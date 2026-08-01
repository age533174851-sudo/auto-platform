// Gate.io API Adapter (server-side only)
import { createHmac, createHash } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

// 호스트를 **연결의 testnet 여부로** 고른다.
//
// 예전에는 `const BASE = 'https://api.gateio.ws'` 하나로 박혀 있었다.
// 그래서 테스트넷으로 등록한 Gate 연결이어도
//   · 연결 테스트와 잔고 조회가 실계좌를 봤고
//   · `/api/exchange/order`가 **실계좌로 주문을 보냈다** (그 라우트는
//     testnet 값을 계산해 두고 Gate 갈래에서만 안 넘기고 있었다)
// 화면에는 '테스트넷'이라고 적혀 있는 채로.
import { gateBase } from './gateFutures';
import { toGatePair } from './gateSpotPlan';

function signGate(method: string, path: string, qs: string, body: string, secret: string, ts: string): string {
  // Gate v4 규격: 본문은 SHA-512 '해시' (HMAC 아님). HMAC를 쓰면 POST 주문 서명이 실패한다.
  const bodyHash = createHash('sha512').update(body).digest('hex');
  const payload = `${method}\n${path}\n${qs}\n${bodyHash}\n${ts}`;
  return createHmac('sha512', secret).update(payload).digest('hex');
}

/**
 * 실패를 사람이 고칠 수 있는 문장으로.
 *
 * `HTTP 401`만 적으면 화면에는 "연결 테스트 실패: HTTP 401"이 뜬다. 그걸 보고
 * 할 수 있는 일이 없다 — 키가 틀린 건지, 서명이 틀린 건지, **테스트넷 키를
 * 실계좌에 물어본 건지** 구분이 안 된다. 마지막 경우가 제일 흔하고 제일
 * 알아채기 어렵다.
 *
 * 그래서 세 가지를 항상 적는다: Gate가 실제로 한 말 · 어느 호스트에 물었나 ·
 * 지금 뭘 확인해야 하나.
 */
function gateError(status: number, body: any, testnet: boolean): Error {
  const said = body?.message || body?.label || '';
  const host = testnet ? '테스트넷(api-testnet.gateapi.io)' : '실전(api.gateio.ws)';
  const hint =
    status === 401
      // 401은 Gate가 서명을 못 받아들인 것이다. 원인이 셋인데 화면에서는
      // 구별이 안 되므로 셋을 다 적는다.
      ? ` — ${host}에 물어본 결과입니다. ①키/시크릿이 맞는지 ②이 키가 ${testnet ? '테스트넷' : '실전'} 키가 맞는지(반대쪽 키라면 연결의 테스트넷 설정을 바꾸세요) ③IP 제한을 걸었다면 이 서버 IP가 허용 목록에 있는지 확인하세요`
      : status === 403
        ? ` — ${host}. 키에 이 동작의 권한이 없습니다(읽기 권한을 켜세요)`
        : status === 429
          ? ` — ${host}. 요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요`
          : ` — ${host}에 물어본 결과입니다`;
  return new Error(`${said || `HTTP ${status}`}${hint}`);
}

async function gateFetch(path: string, key: string, secret: string, testnet = false) {
  const ts  = Math.floor(Date.now()/1000).toString();
  const sig = signGate('GET', path, '', '', secret, ts);

  const r = await fetch(`${gateBase(testnet)}${path}`, {
    headers: {
      'KEY': key, 'SIGN': sig, 'Timestamp': ts,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    // 본문을 버리지 않는다. Gate는 여기에 실제 사유를 담아 보낸다
    // (`INVALID_KEY`, `INVALID_SIGNATURE`, `IP_FORBIDDEN` 등).
    // 바로 아래 gatePost는 원래 이렇게 하고 있었는데 GET 경로만 빠져 있었다.
    const err = await r.json().catch(() => ({}));
    throw gateError(r.status, err, testnet);
  }
  return r.json();
}

export async function testGate(key: string, secret: string, testnet = false): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const data = await gateFetch('/api/v4/spot/accounts', key, secret, testnet);
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

export async function getBalancesGate(key: string, secret: string, testnet = false): Promise<ExchangeBalance[]> {
  const data = await gateFetch('/api/v4/spot/accounts', key, secret, testnet);
  return (Array.isArray(data) ? data : [])
    .filter((b: any) => parseFloat(b.available)+parseFloat(b.locked)>0)
    .map((b: any) => ({ currency: b.currency, free: parseFloat(b.available), locked: parseFloat(b.locked), total: parseFloat(b.available)+parseFloat(b.locked) }));
}

// ─── POST helper (signed) ──────────────────────────────────────
async function gatePost(path: string, key: string, secret: string, bodyObj: any, testnet = false) {
  const ts   = Math.floor(Date.now()/1000).toString();
  const body = JSON.stringify(bodyObj);
  const sig  = signGate('POST', path, '', body, secret, ts);

  const r = await fetch(`${gateBase(testnet)}${path}`, {
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
    throw gateError(r.status, err, testnet);
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
  testnet = false,
): Promise<GateOrderResult> {
  try {
    // 종목 이름은 **한 곳**에서 만든다.
    //
    // 여기 있던 `endsWith('USDT')`만 보는 코드는 ETHBTC·SOLUSDC에 밑줄을
    // 안 붙였다. 거절되면 그나마 낫고, 하필 그 이름의 종목이 있으면
    // 다른 것을 산다. 판정이 두 곳에 있으면 한쪽만 고쳐진다.
    const p = toGatePair(opts.symbol);
    if (!p) {
      return { success: false, message: `종목 '${opts.symbol}'의 결제 통화를 알 수 없습니다 (예: BTC_USDT)` };
    }
    const pair = p.pair;

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

    const d = await gatePost('/api/v4/spot/orders', key, secret, body, testnet);
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
  },
  testnet = false,
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
    const d = await gatePost('/api/v4/spot/price_orders', key, secret, body, testnet);
    return { success: true, message: '조건부 주문 등록 (거래소가 24시간 감시)', orderId: d.id, symbol: opts.pair, side: opts.side, qty: opts.amount, price: opts.orderPrice, raw: d };
  } catch (e: any) {
    return { success: false, message: e.message || '조건부 주문 실패' };
  }
}
