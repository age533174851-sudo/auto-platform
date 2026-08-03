// ─────────────────────────────────────────────────────────────
// Binance API Adapter (server-side only)
// Docs: https://binance-docs.github.io/apidocs/spot/en/
// ─────────────────────────────────────────────────────────────
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';
const TESTNET_FUTURES_BASE = 'https://demo-fapi.binance.com';

// 현물 테스트넷. 별개 거래소다 — 상장 심볼 수부터 다르다(실전 3,659 / 여기 1,373).
//
// demo-api.binance.com 을 쓰지 않는 이유: 그 호스트는 응답하지만
// exchangeInfo 심볼 수가 실전과 완전히 같다. 테스트넷이 아니라 실전 미러다.
// 이름만 보고 붙였으면 진짜 돈으로 주문이 나갔다.
const TESTNET_SPOT_BASE = 'https://testnet.binance.vision';

export function binanceBase(opts?: { testnet?: boolean; futures?: boolean }): string {
  if (opts?.futures) return opts.testnet ? TESTNET_FUTURES_BASE : FUTURES_BASE;
  return opts?.testnet ? TESTNET_SPOT_BASE : BASE;
}

/** 현물 호스트. 이 파일 안에서 BASE를 직접 쓰지 않는다 — 한 군데라도 빠뜨리면 섞인다. */
function spotBase(testnet?: boolean): string {
  return testnet ? TESTNET_SPOT_BASE : BASE;
}

function sign(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

/**
 * 현물 거래소 서버 시각 (epoch ms). 못 읽으면 null — 0이 아니다.
 *
 * 선물의 getFuturesServerTime과 왜 따로 두는가: 호스트가 다르다
 * (api.binance.com vs fapi.binance.com, 테스트넷은 완전히 다른 거래소다).
 * 하나로 쓰면 현물 주문의 시계를 선물 호스트에 물어보는 것이 되고, 그건
 * 이 파일이 spotBase()를 따로 둔 이유와 같은 종류의 혼입이다.
 *
 * 서명이 필요 없는 공개 엔드포인트다.
 */
export async function getSpotServerTime(testnet?: boolean): Promise<number | null> {
  try {
    const r = await fetch(`${spotBase(testnet)}/api/v3/time`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    const t = Number(d?.serverTime);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch { return null; }
}

async function bnFetch(
  path: string, key: string, secret: string,
  params: Record<string,string> = {}, testnet?: boolean,
) {
  const ts  = Date.now().toString();
  const qs  = new URLSearchParams({ ...params, timestamp: ts });
  const sig = sign(qs.toString(), secret);
  qs.set('signature', sig);

  const r = await fetch(`${spotBase(testnet)}${path}?${qs}`, {
    headers: { 'X-MBX-APIKEY': key },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(annotateAuthError(err.msg || `HTTP ${r.status}`, testnet));
  }
  return r.json();
}

/**
 * 인증 실패에 "어느 거래소에 물어봤는지"를 붙인다.
 *
 * 현물 테스트넷 키와 선물 데모 키는 서로 다른 키다. 하나로 둘 다 쓰려다
 * -2015를 받으면 원인이 권한인지 호스트인지 알 수 없다 — 그걸 말해 준다.
 */
export function annotateAuthError(msg: string, testnet?: boolean): string {
  const authish = /-2015|-2014|-1022|API-key|Invalid API|signature/i.test(msg);
  if (!authish) return msg;
  return testnet
    ? `${msg} · 현물 테스트넷(testnet.binance.vision)에 물어본 결과입니다. 선물 데모(demo-fapi) 키는 여기서 인증되지 않습니다 — 현물 테스트넷 키를 따로 발급하세요.`
    : `${msg} · 실전 현물(api.binance.com)에 물어본 결과입니다. 테스트넷 키라면 연결의 테스트넷 설정을 확인하세요.`;
}

/**
 * 선물(USDⓈ-M) 인증 실패를 **고칠 수 있는 말로** 바꾼다.
 *
 * `[-2015] Invalid API-key, IP, or permissions for action`은 바이낸스가
 * 원인 셋을 한 문장으로 뭉뚱그린 것이다. 이 메시지만 보면 무엇을
 * 확인해야 하는지 알 수 없다 — 실제로 이 화면에서 그대로 멈췄다.
 *
 * 셋을 나눠 적는다. 그리고 **어느 호스트에 물어봤는지**를 같이 적는다.
 * 이 저장소에서 가장 흔한 원인이 그것이기 때문이다: 실전 키를 등록한
 * 연결에 테스트넷 표시가 붙어 있으면 데모 호스트로 나가고, 데모는 그
 * 키를 모른다.
 */
export function explainFuturesAuthError(msg: string, testnet: boolean): string {
  const m = String(msg || '');
  if (!/-2015|-2014|-1022|API-key|Invalid API|signature/i.test(m)) return m;

  const host = testnet ? 'demo-fapi.binance.com (테스트넷)' : 'fapi.binance.com (실전)';
  const wrongEnv = testnet
    ? '이 연결은 **테스트넷**으로 표시돼 있어 데모 서버에 요청했습니다. '
      + '등록한 키가 실전 키라면 데모는 그 키를 모릅니다 — 연결의 테스트넷 설정이나 키 중 하나가 틀렸습니다.'
    : '이 연결은 **실전**으로 표시돼 있어 실전 서버에 요청했습니다. '
      + '등록한 키가 테스트넷 키라면 실전은 그 키를 모릅니다.';

  return [
    m,
    '',
    `요청한 곳: ${host}`,
    '',
    '원인은 셋 중 하나입니다:',
    `1. **환경이 안 맞습니다.** ${wrongEnv}`,
    '2. **선물 권한이 꺼져 있습니다.** 키 설정에서 Futures(선물) 거래를 켜야 합니다 — 읽기만 켜져 있으면 조회는 되고 주문만 막힙니다.',
    '3. **IP 제한에 걸렸습니다.** 키에 IP 화이트리스트를 걸었다면, 이 앱이 나가는 IP가 그 목록에 있어야 합니다.',
  ].join('\n');
}

/**
 * -2015가 났을 때 **셋 중 무엇인지 실제로 알아낸다.**
 *
 * 왜 필요한가
 * ───────────
 * 위 함수는 원인 셋을 나열한다. 나열은 원문보다 낫지만, 사용자는 여전히
 * 셋을 다 뒤져야 한다. 그런데 대부분의 경우 **우리가 이미 답을 알 수 있다.**
 *
 * 바이낸스 선물 키의 권한은 계층이다:
 *   · `/fapi/v2/balance` — **읽기** 권한이면 된다
 *   · `/fapi/v1/order`   — **거래(TRADE)** 권한이 필요하다
 *
 * 그래서 읽기가 되는데 주문이 -2015면, 환경도 IP도 아니다. 둘 다 틀렸다면
 * 읽기부터 막힌다(IP 화이트리스트는 엔드포인트를 가리지 않고, 데모 서버는
 * 실전 키를 아예 모른다). 남는 것은 하나뿐이다 — **선물 거래 권한이 꺼져 있다.**
 *
 * 반대로 읽기도 -2015면 환경이나 IP다. 그때는 좁히지 않고 그대로 둔다 —
 * **모르는 것을 아는 척하지 않는다.**
 */
export async function narrowFuturesAuthError(
  msg: string, testnet: boolean,
  probeRead: () => Promise<{ success: boolean; message?: string }>,
): Promise<string> {
  const base = explainFuturesAuthError(msg, testnet);
  // 인증 오류가 아니면 좁힐 것이 없다
  if (base === String(msg || '')) return base;

  let readOk = false;
  let probeErr = '';
  try {
    const r = await probeRead();
    readOk = !!r?.success;
    if (!readOk) probeErr = String(r?.message || '');
  } catch (e: any) {
    probeErr = String(e?.message || e);
  }

  if (readOk) {
    const host = testnet ? 'demo-fapi.binance.com (테스트넷)' : 'fapi.binance.com (실전)';
    return [
      String(msg || ''),
      '',
      `요청한 곳: ${host}`,
      '',
      '**선물 거래 권한이 꺼져 있습니다.**',
      '',
      '같은 키·같은 서버로 잔고 조회는 성공했습니다. 즉 키도 맞고 환경도 맞고',
      'IP도 막히지 않았습니다 — 그 셋 중 하나라도 틀렸다면 잔고부터 막힙니다.',
      '주문 계열 요청만 거부됐으므로 남는 원인은 하나입니다.',
      '',
      '고치는 법: 바이낸스 → API 관리 → 이 키 편집 → **Futures(선물) 사용**을 켜고',
      '저장하세요. 읽기만 켜져 있으면 잔고·시세는 보이고 주문만 막힙니다.',
      // 빈 문자열은 문단을 나누는 빈 줄이다. filter(Boolean)으로 지우면
      // 전체가 한 덩어리가 되어 화면에서 읽기 어려워진다.
      ...(testnet ? ['', '(테스트넷 키는 testnet.binancefuture.com에서 관리합니다)'] : []),
    ].join('\n');
  }

  // 읽기도 막혔다 — 환경이나 IP다. 권한은 아니다(권한 문제면 읽기는 됐다).
  return [
    base,
    '',
    `— 확인: 잔고 조회도 같은 오류로 막혔습니다${probeErr ? ` (${probeErr})` : ''}.`,
    '  읽기부터 막히면 **2번(선물 권한)은 아닙니다.** 1번(환경)과 3번(IP)을 보세요.',
  ].join('\n');
}

export async function testBinance(key: string, secret: string, testnet?: boolean): Promise<TestResult> {
  const t0 = Date.now();
  try {
    // 1. Check account info (requires read permission)
    const account = await bnFetch('/api/v3/account', key, secret, {}, testnet);
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
      message: testnet
        ? `현물 테스트넷 연결 성공 · ${balances.length}개 자산 확인`
        : `연결 성공 · ${balances.length}개 자산 확인`,
      balances,
      permissions,
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    return { success: false, message: e.message || '연결 실패' };
  }
}

export async function getBalancesBinance(
  key: string, secret: string, testnet?: boolean,
): Promise<ExchangeBalance[]> {
  const account = await bnFetch('/api/v3/account', key, secret, {}, testnet);
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
async function bnPost(
  path: string, key: string, secret: string,
  params: Record<string,string>, testnet?: boolean,
) {
  const ts  = Date.now().toString();
  const qs  = new URLSearchParams({ ...params, timestamp: ts, recvWindow: '5000' });
  const sig = sign(qs.toString(), secret);
  qs.set('signature', sig);

  const r = await fetch(`${spotBase(testnet)}${path}`, {
    method:  'POST',
    headers: { 'X-MBX-APIKEY': key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    qs.toString(),
    signal:  AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(annotateAuthError(err.msg || `HTTP ${r.status}`, testnet));
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
    clientOrderId?: string;
    testnet?:       boolean;  // true면 testnet.binance.vision
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
    if (opts.clientOrderId) params.newClientOrderId = opts.clientOrderId;

    const d = await bnPost('/api/v3/order', key, secret, params, opts.testnet);
    return {
      success: true,
      message: opts.testnet ? '주문 체결 (테스트넷)' : '주문 체결',
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

// ─── 현물 조회 ───────────────────────────────────────────────
// 선물 쪽 함수와 이름을 겹치지 않게 둔다. import 한 줄을 잘못 쓰면
// 현물 화면이 선물 데이터를 보여주게 되고, 그 화면을 보고 주문한다.

/** 현물 미체결 주문. symbol을 주면 그 종목만. */
export async function getSpotOpenOrders(
  key: string, secret: string, symbol?: string, testnet?: boolean,
): Promise<any[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol.toUpperCase().replace('/', '');
  const d = await bnFetch('/api/v3/openOrders', key, secret, params, testnet);
  return Array.isArray(d) ? d : [];
}

/**
 * 현물 체결 내역.
 *
 * Binance는 심볼 없이 전체 체결을 주지 않는다. 그래서 symbol이 필수다 —
 * 없는데 빈 배열을 돌려주면 "거래 내역이 없다"로 읽힌다.
 */
export async function getSpotTrades(
  key: string, secret: string, symbol: string, limit = 100, testnet?: boolean,
): Promise<any[]> {
  const d = await bnFetch('/api/v3/myTrades', key, secret, {
    symbol: symbol.toUpperCase().replace('/', ''),
    limit: String(Math.min(1000, Math.max(1, limit))),
  }, testnet);
  return Array.isArray(d) ? d : [];
}

/** 현물 주문 취소 */
export async function cancelSpotOrder(
  key: string, secret: string, symbol: string, orderId: string | number, testnet?: boolean,
): Promise<{ success: boolean; message?: string }> {
  try {
    await bnFetch('/api/v3/order', key, secret, {
      symbol: symbol.toUpperCase().replace('/', ''),
      orderId: String(orderId),
    }, testnet);
    return { success: true };
  } catch (e: any) {
    return { success: false, message: e?.message || '취소 실패' };
  }
}

// ─── 현물 LOT_SIZE 처리 ──────────────────────────────────────
const _spotLotCache: Record<string, { stepSize: number; minQty: number; at: number }> = {};

// 캐시 키에 testnet을 넣는다. 두 거래소는 상장 종목도 필터도 다르다 —
// 키를 심볼만으로 두면 실전에서 캐시된 stepSize로 테스트넷 주문을 반올림하게 된다.
export async function getSpotSymbolFilters(
  symbol: string, testnet?: boolean,
): Promise<{ stepSize: number; minQty: number } | null> {
  const sym = symbol.toUpperCase().replace('/', '');
  const cacheKey = `${testnet ? 'T' : 'L'}:${sym}`;
  const cached = _spotLotCache[cacheKey];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;
  try {
    const r = await fetch(`${spotBase(testnet)}/api/v3/exchangeInfo?symbol=${sym}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    const s = (data.symbols || [])[0];
    if (!s) return null;
    const lot = (s.filters || []).find((f: any) => f.filterType === 'LOT_SIZE');
    const result = {
      stepSize: parseFloat(lot?.stepSize || '0.00001'),
      minQty:   parseFloat(lot?.minQty || '0.00001'),
      at: Date.now(),
    };
    _spotLotCache[cacheKey] = result;
    return result;
  } catch { return null; }
}

export function roundSpotQty(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
  return parseFloat((Math.floor(qty / stepSize) * stepSize).toFixed(decimals));
}
