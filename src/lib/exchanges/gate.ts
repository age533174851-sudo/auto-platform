// Gate.io API Adapter (server-side only)
import { createHmac, createHash } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.gateio.ws';

function signGate(method: string, path: string, qs: string, body: string, secret: string, ts: string): string {
  // Gate v4 규격: 본문은 SHA-512 '해시' (HMAC 아님). HMAC를 쓰면 POST 주문 서명이 실패한다.
  const bodyHash = createHash('sha512').update(body).digest('hex');
  const payload = `${method}\n${path}\n${qs}\n${bodyHash}\n${ts}`;
  return createHmac('sha512', secret).update(payload).digest('hex');
}

async function gateFetch(path: string, key: string, secret: string) {
  const ts  = Math.floor(Date.now()/1000).toString();
  const sig = signGate('GET', path, '', '', secret, ts);

  const r = await fetch(`${BASE}${path}`, {
    headers: {
      'KEY': key, 'SIGN': sig, 'Timestamp': ts,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function testGate(key: string, secret: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const data = await gateFetch('/api/v4/spot/accounts', key, secret);
    const balances: ExchangeBalance[] = (Array.isArray(data) ? data : [])
      .filter((b: any) => parseFloat(b.available) + parseFloat(b.locked) > 0)
      .slice(0, 20)
      .map((b: any) => ({ currency: b.currency, free: parseFloat(b.available), locked: parseFloat(b.locked), total: parseFloat(b.available)+parseFloat(b.locked) }));
    return { success: true, message: `연결 성공 · ${balances.length}개 자산`, balances,
      permissions: { read: true, trading: false, withdrawal: false }, latencyMs: Date.now()-t0 };
  } catch (e: any) {
    return { success: false, message: e.message || 'Gate.io 연결 실패' };
  }
}

export async function getBalancesGate(key: string, secret: string): Promise<ExchangeBalance[]> {
  const data = await gateFetch('/api/v4/spot/accounts', key, secret);
  return (Array.isArray(data) ? data : [])
    .filter((b: any) => parseFloat(b.available)+parseFloat(b.locked)>0)
    .map((b: any) => ({ currency: b.currency, free: parseFloat(b.available), locked: parseFloat(b.locked), total: parseFloat(b.available)+parseFloat(b.locked) }));
}

// ─── POST helper (signed) ──────────────────────────────────────
async function gatePost(path: string, key: string, secret: string, bodyObj: any) {
  const ts   = Math.floor(Date.now()/1000).toString();
  const body = JSON.stringify(bodyObj);
  const sig  = signGate('POST', path, '', body, secret, ts);

  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: {
      'KEY': key, 'SIGN': sig, 'Timestamp': ts,
      'Content-Type': 'application/json', 'Accept': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.message || err.label || `HTTP ${r.status}`);
  }
  return r.json();
}

export interface GateOrderResult {
  success:  boolean;
  message:  string;
  orderId?: string;
  symbol?:  string;
  side?:    string;
  qty?:     number;
  price?:   number;
  raw?:     any;
}

// 실제 주문 (Gate.io Spot)
// currency_pair: 'BTC_USDT' 형식
export async function placeOrderGate(
  key: string,
  secret: string,
  opts: {
    symbol:   string;          // 'BTC/USDT' or 'BTCUSDT' or 'BTC_USDT'
    side:     'BUY' | 'SELL';
    type:     'MARKET' | 'LIMIT';
    quantity?:  number;        // 코인 수량 (LIMIT/SELL)
    amount?:    number;        // USDT 금액 (MARKET BUY)
    price?:     number;        // LIMIT 전용
  },
): Promise<GateOrderResult> {
  try {
    // 심볼 정규화 → BTC_USDT
    let pair = opts.symbol.toUpperCase().replace('/', '').replace('_', '');
    if (pair.endsWith('USDT')) pair = `${pair.slice(0, -4)}_USDT`;

    const body: any = {
      currency_pair: pair,
      side:          opts.side.toLowerCase(),
      type:          opts.type.toLowerCase(),
    };

    if (opts.type === 'MARKET') {
      body.time_in_force = 'ioc';
      if (opts.side === 'BUY' && opts.amount != null) {
        body.amount = String(opts.amount);     // Gate: MARKET BUY는 quote(USDT) 금액
      } else if (opts.quantity != null) {
        body.amount = String(opts.quantity);    // MARKET SELL은 base 수량
      } else {
        return { success: false, message: '주문 수량/금액 누락' };
      }
    } else {
      if (opts.quantity == null || opts.price == null) {
        return { success: false, message: 'LIMIT 주문은 수량+가격 필요' };
      }
      body.amount = String(opts.quantity);
      body.price  = String(opts.price);
    }

    const d = await gatePost('/api/v4/spot/orders', key, secret, body);
    return {
      success: true,
      message: '주문 체결',
      orderId: d.id,
      symbol:  d.currency_pair,
      side:    d.side,
      qty:     parseFloat(d.amount || '0'),
      price:   parseFloat(d.price || d.fill_price || '0'),
      raw:     d,
    };
  } catch (e: any) {
    return { success: false, message: e.message || '주문 실패' };
  }
}

// ─── Gate.io 조건부 주문 (price-triggered) ──────────────────
// 앱/서버가 꺼져도 거래소가 트리거 가격 도달 시 자동 실행
// → 24시간 손절/익절을 거래소에 위임 (서버리스 한계 극복)
export async function placeConditionalGate(
  key: string,
  secret: string,
  opts: {
    pair: string;          // 예: 'BTC_USDT'
    triggerPrice: number;  // 트리거 가격
    orderPrice: number;    // 실행 가격 (시장가는 '0')
    amount: number;        // 수량
    side: 'buy' | 'sell';
    rule: '>=' | '<=';     // 트리거 방향 (손절=<=, 익절=>=)
  }
): Promise<GateOrderResult> {
  try {
    const body = {
      market: opts.pair,
      trigger: {
        price: String(opts.triggerPrice),
        rule: opts.rule === '>=' ? 1 : 2,   // 1: >=, 2: <=
        expiration: 86400,                   // 24시간
      },
      put: {
        type: 'limit',
        side: opts.side,
        price: String(opts.orderPrice),
        amount: String(opts.amount),
        time_in_force: 'gtc',
      },
    };
    const d = await gatePost('/api/v4/spot/price_orders', key, secret, body);
    return { success: true, message: '조건부 주문 등록 (거래소가 24시간 감시)', orderId: d.id, symbol: opts.pair, side: opts.side, qty: opts.amount, price: opts.orderPrice, raw: d };
  } catch (e: any) {
    return { success: false, message: e.message || '조건부 주문 실패' };
  }
}
