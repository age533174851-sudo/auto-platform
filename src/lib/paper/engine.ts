// src/lib/paper/engine.ts
// Virtual paper trading account — local-only, no network.
// Tracks cash, positions, realized/unrealized PnL, history.

const STORE_KEY = 'tg_paper_account_v1';
const INITIAL_CASH = 10_000_000; // 1천만원 시작
const FEE_RATE = 0.001; // 0.1%

export interface PaperPosition {
  symbol:    string;
  name:      string;
  qty:       number;
  avgPrice:  number;   // 평균 매입가
  openedAt:  number;
}

export interface PaperOrder {
  id:       string;
  ts:       number;
  symbol:   string;
  name:     string;
  side:     'buy' | 'sell';
  price:    number;
  qty:      number;
  value:    number;     // qty * price
  fee:      number;
  realized?:number;     // sell only
  realizedPct?: number;
}

export interface PaperAccount {
  cash:        number;
  initialCash: number;
  positions:   PaperPosition[];
  orders:      PaperOrder[];   // most recent first
  createdAt:   number;
}

export interface OrderResult {
  ok:       boolean;
  error?:   string;
  account?: PaperAccount;
  order?:   PaperOrder;
}

/* ── Storage ── */
export function loadAccount(): PaperAccount {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const a = JSON.parse(raw);
      return {
        cash:        Number(a?.cash) || 0,
        initialCash: Number(a?.initialCash) || INITIAL_CASH,
        positions:   Array.isArray(a?.positions) ? a.positions : [],
        orders:      Array.isArray(a?.orders) ? a.orders : [],
        createdAt:   Number(a?.createdAt) || Date.now(),
      };
    }
  } catch {}
  return createFresh();
}

export function saveAccount(account: PaperAccount): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(account)); } catch {}
}

export function createFresh(): PaperAccount {
  const a: PaperAccount = {
    cash:        INITIAL_CASH,
    initialCash: INITIAL_CASH,
    positions:   [],
    orders:      [],
    createdAt:   Date.now(),
  };
  saveAccount(a);
  return a;
}

export function resetAccount(): PaperAccount {
  return createFresh();
}

/* ── Orders ── */
export function placeOrder(
  account: PaperAccount,
  args: { symbol: string; name?: string; side: 'buy' | 'sell'; price: number; qty: number }
): OrderResult {
  const { symbol, side } = args;
  const name = args.name || symbol;
  const price = Number(args.price);
  const qty   = Number(args.qty);

  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: '가격이 유효하지 않습니다' };
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: '수량이 유효하지 않습니다' };
  }

  const value = price * qty;
  const fee   = value * FEE_RATE;
  const cost  = side === 'buy' ? value + fee : 0;
  const idx   = account.positions.findIndex(p => p.symbol === symbol);

  if (side === 'buy') {
    if (account.cash < cost) {
      return { ok: false, error: `잔고 부족 (필요 ${Math.round(cost).toLocaleString()}원, 보유 ${Math.round(account.cash).toLocaleString()}원)` };
    }
    const next = { ...account };
    next.cash = account.cash - cost;
    if (idx >= 0) {
      const cur = account.positions[idx];
      const totalQty = cur.qty + qty;
      const totalCost = cur.qty * cur.avgPrice + qty * price;
      next.positions = account.positions.map((p, i) => i === idx ? {
        ...p, qty: totalQty, avgPrice: totalCost / totalQty,
      } : p);
    } else {
      next.positions = [...account.positions, { symbol, name, qty, avgPrice: price, openedAt: Date.now() }];
    }
    const order: PaperOrder = {
      id: 'o-' + Date.now().toString(36),
      ts: Date.now(),
      symbol, name, side, price, qty, value, fee,
    };
    next.orders = [order, ...account.orders].slice(0, 200);
    saveAccount(next);
    return { ok: true, account: next, order };
  }

  // SELL
  if (idx < 0) {
    return { ok: false, error: '보유하지 않은 종목입니다' };
  }
  const cur = account.positions[idx];
  if (cur.qty < qty - 1e-9) {
    return { ok: false, error: `보유 수량 부족 (보유 ${cur.qty}, 매도 시도 ${qty})` };
  }

  const proceeds = value - fee;
  const realized = (price - cur.avgPrice) * qty - fee;
  const realizedPct = cur.avgPrice > 0 ? ((price - cur.avgPrice) / cur.avgPrice) * 100 : 0;

  const next = { ...account };
  next.cash = account.cash + proceeds;
  const remainQty = cur.qty - qty;
  if (remainQty < 1e-9) {
    next.positions = account.positions.filter((_, i) => i !== idx);
  } else {
    next.positions = account.positions.map((p, i) => i === idx ? { ...p, qty: remainQty } : p);
  }
  const order: PaperOrder = {
    id: 'o-' + Date.now().toString(36),
    ts: Date.now(),
    symbol, name, side, price, qty, value, fee,
    realized, realizedPct,
  };
  next.orders = [order, ...account.orders].slice(0, 200);
  saveAccount(next);
  return { ok: true, account: next, order };
}

/* ── Metrics ── */
export function calcMetrics(
  account: PaperAccount,
  priceLookup: (symbol: string) => number | null
): {
  totalEquity: number;
  positionValue: number;
  pnl: number;
  pnlPct: number;
  realized: number;
  unrealized: number;
  winRate: number;
} {
  const safe = Array.isArray(account?.positions) ? account.positions : [];
  let positionValue = 0;
  let unrealized = 0;
  safe.forEach(p => {
    const cur = priceLookup(p.symbol);
    if (cur && Number.isFinite(cur)) {
      positionValue += cur * p.qty;
      unrealized += (cur - p.avgPrice) * p.qty;
    } else {
      positionValue += p.avgPrice * p.qty; // fallback
    }
  });
  const totalEquity = account.cash + positionValue;
  const initialCash = account.initialCash || INITIAL_CASH;
  const pnl = totalEquity - initialCash;
  const pnlPct = initialCash > 0 ? (pnl / initialCash) * 100 : 0;

  const sells = (Array.isArray(account.orders) ? account.orders : []).filter(o => o.side === 'sell' && o.realized !== undefined);
  const wins = sells.filter(o => (o.realized ?? 0) > 0);
  const realized = sells.reduce((s, o) => s + (o.realized ?? 0), 0);
  const winRate = sells.length > 0 ? (wins.length / sells.length) * 100 : 0;

  return { totalEquity, positionValue, pnl, pnlPct, realized, unrealized, winRate };
}
