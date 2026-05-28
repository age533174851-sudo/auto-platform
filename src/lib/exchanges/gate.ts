// Gate.io API Adapter (server-side only)
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.gateio.ws';

function signGate(method: string, path: string, qs: string, body: string, secret: string, ts: string): string {
  const bodyHash = createHmac('sha512','').update(body).digest('hex'); // gate uses sha512 for body
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
