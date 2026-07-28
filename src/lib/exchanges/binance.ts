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
