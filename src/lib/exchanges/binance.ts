// ─────────────────────────────────────────────────────────────
// Binance API Adapter (server-side only)
// Docs: https://binance-docs.github.io/apidocs/spot/en/
// ─────────────────────────────────────────────────────────────
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.binance.com';

function sign(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

async function bnFetch(path: string, key: string, secret: string, params: Record<string,string> = {}) {
  const ts  = Date.now().toString();
  const qs  = new URLSearchParams({ ...params, timestamp: ts });
  const sig = sign(qs.toString(), secret);
  qs.set('signature', sig);

  const r = await fetch(`${BASE}${path}?${qs}`, {
    headers: { 'X-MBX-APIKEY': key },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.msg || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function testBinance(key: string, secret: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    // 1. Check account info (requires read permission)
    const account = await bnFetch('/api/v3/account', key, secret);
    const permissions = {
      read:       true,
      trading:    account.canTrade   ?? false,
      withdrawal: account.enableWithdrawals ?? false,
    };

    // 2. Parse balances (non-zero)
    const balances: ExchangeBalance[] = (account.balances || [])
      .filter((b: any) => parseFloat(b.free) + parseFloat(b.locked) > 0)
      .slice(0, 20)
      .map((b: any) => ({
        currency: b.asset,
        free:     parseFloat(b.free),
        locked:   parseFloat(b.locked),
        total:    parseFloat(b.free) + parseFloat(b.locked),
      }));

    return {
      success: true,
      message: `연결 성공 · ${balances.length}개 자산 확인`,
      balances,
      permissions,
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    return { success: false, message: e.message || '연결 실패' };
  }
}

export async function getBalancesBinance(key: string, secret: string): Promise<ExchangeBalance[]> {
  const account = await bnFetch('/api/v3/account', key, secret);
  return (account.balances || [])
    .filter((b: any) => parseFloat(b.free) + parseFloat(b.locked) > 0.000001)
    .map((b: any) => ({
      currency: b.asset,
      free:     parseFloat(b.free),
      locked:   parseFloat(b.locked),
      total:    parseFloat(b.free) + parseFloat(b.locked),
    }));
}

// ─── POST helper (signed) ──────────────────────────────────────
async function bnPost(path: string, key: string, secret: string, params: Record<string,string>) {
  const ts  = Date.now().toString();
  const qs  = new URLSearchParams({ ...params, timestamp: ts, recvWindow: '5000' });
  const sig = sign(qs.toString(), secret);
  qs.set('signature', sig);

  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'X-MBX-APIKEY': key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    qs.toString(),
    signal:  AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.msg || `HTTP ${r.status}`);
  }
  return r.json();
}

export interface OrderResult {
  success:  boolean;
  message:  string;
  orderId?: string | number;
  symbol?:  string;
  side?:    string;
  qty?:     number;
  price?:   number;
  raw?:     any;
}

// 실제 주문 (Binance Spot)
// symbol: 'BTCUSDT' 형식 / side: 'BUY'|'SELL' / type: 'MARKET'|'LIMIT'
// MARKET BUY는 quoteOrderQty(USDT 금액), 그 외는 quantity(코인 수량)
export async function placeOrderBinance(
  key: string,
  secret: string,
  opts: {
    symbol:   string;
    side:     'BUY' | 'SELL';
    type:     'MARKET' | 'LIMIT';
    quantity?:      number;   // 코인 수량
    quoteOrderQty?: number;   // USDT 금액 (MARKET BUY 전용)
    price?:         number;   // LIMIT 전용
  },
): Promise<OrderResult> {
  try {
    const symbol = opts.symbol.toUpperCase().replace('/', '');
    const params: Record<string, string> = {
      symbol,
      side: opts.side,
      type: opts.type,
    };

    if (opts.type === 'MARKET') {
      if (opts.side === 'BUY' && opts.quoteOrderQty != null) {
        params.quoteOrderQty = String(opts.quoteOrderQty);
      } else if (opts.quantity != null) {
        params.quantity = String(opts.quantity);
      } else {
        return { success: false, message: '주문 수량/금액 누락' };
      }
    } else {
      // LIMIT
      if (opts.quantity == null || opts.price == null) {
        return { success: false, message: 'LIMIT 주문은 수량+가격 필요' };
      }
      params.quantity    = String(opts.quantity);
      params.price       = String(opts.price);
      params.timeInForce = 'GTC';
    }

    const d = await bnPost('/api/v3/order', key, secret, params);
    return {
      success: true,
      message: '주문 체결',
      orderId: d.orderId,
      symbol:  d.symbol,
      side:    d.side,
      qty:     parseFloat(d.executedQty || d.origQty || '0'),
      price:   parseFloat(d.fills?.[0]?.price || d.price || '0'),
      raw:     d,
    };
  } catch (e: any) {
    return { success: false, message: e.message || '주문 실패' };
  }
}
