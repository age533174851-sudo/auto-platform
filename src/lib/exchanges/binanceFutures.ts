// ─────────────────────────────────────────────────────────────
// Binance USDT-M Futures API Adapter (server-side only)
// testnet(demo): https://demo-fapi.binance.com / 실전: https://fapi.binance.com
// 바이낸스가 testnet.binancefuture.com → demo-fapi.binance.com 으로 변경
// ⚠️ 출금 권한 없는 키만. 서버에서만 호출. 프론트 노출 금지.
// ─────────────────────────────────────────────────────────────
import { createHmac } from 'crypto';

const FUTURES_BASE         = 'https://fapi.binance.com';
const TESTNET_FUTURES_BASE = 'https://demo-fapi.binance.com';

function base(testnet: boolean): string {
  return testnet ? TESTNET_FUTURES_BASE : FUTURES_BASE;
}
function sign(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

async function fapiSigned(
  method: 'GET' | 'POST' | 'DELETE',
  path: string, key: string, secret: string, testnet: boolean,
  params: Record<string, string | number> = {},
) {
  const qsObj: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) qsObj[k] = String(v);
  qsObj.timestamp  = String(Date.now());
  qsObj.recvWindow = '5000';
  const qs  = new URLSearchParams(qsObj).toString();
  const sig = sign(qs, secret);
  const url = `${base(testnet)}${path}?${qs}&signature=${sig}`;
  // 디버그 로그 (Vercel 함수 로그에서 확인)
  console.log('[Binance] MODE:', testnet ? 'TESTNET' : 'LIVE', '| BASE:', base(testnet), '| KEY:', key?.slice(0, 8) + '...', '| path:', path);
  const r = await fetch(url, {
    method, headers: { 'X-MBX-APIKEY': key }, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.log('[Binance] ERROR:', r.status, '| code:', err.code, '| msg:', err.msg);
    // 바이낸스 에러코드 + 메시지 그대로 전달
    throw new Error(err.msg ? `[${err.code}] ${err.msg}` : `HTTP ${r.status}`);
  }
  return r.json();
}

export interface FuturesBalance { asset: string; balance: number; availableBalance: number; unrealizedPnl: number; }

export async function getFuturesBalance(key: string, secret: string, testnet = true) {
  try {
    const data = await fapiSigned('GET', '/fapi/v2/balance', key, secret, testnet);
    const balances: FuturesBalance[] = (Array.isArray(data) ? data : [])
      .filter((b: any) => parseFloat(b.balance) !== 0 || parseFloat(b.availableBalance) !== 0)
      .map((b: any) => ({
        asset: b.asset, balance: parseFloat(b.balance),
        availableBalance: parseFloat(b.availableBalance), unrealizedPnl: parseFloat(b.crossUnPnl || '0'),
      }));
    return { success: true, message: `${balances.length}개 자산`, balances };
  } catch (e: any) { return { success: false, message: e.message || '잔고 조회 실패' }; }
}

export interface FuturesPosition {
  symbol: string; side: 'LONG' | 'SHORT' | 'FLAT'; amount: number;
  entryPrice: number; markPrice: number; unrealizedPnl: number; leverage: number; liquidationPrice: number;
}

export async function getFuturesPositions(key: string, secret: string, testnet = true) {
  try {
    const data = await fapiSigned('GET', '/fapi/v2/positionRisk', key, secret, testnet);
    const positions: FuturesPosition[] = (Array.isArray(data) ? data : [])
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => {
        const amt = parseFloat(p.positionAmt);
        return {
          symbol: p.symbol, side: amt > 0 ? 'LONG' : amt < 0 ? 'SHORT' : 'FLAT',
          amount: Math.abs(amt), entryPrice: parseFloat(p.entryPrice), markPrice: parseFloat(p.markPrice),
          unrealizedPnl: parseFloat(p.unRealizedProfit), leverage: parseInt(p.leverage || '1', 10),
          liquidationPrice: parseFloat(p.liquidationPrice || '0'),
        } as FuturesPosition;
      });
    return { success: true, message: `${positions.length}개 포지션`, positions };
  } catch (e: any) { return { success: false, message: e.message || '포지션 조회 실패' }; }
}

export async function setFuturesLeverage(key: string, secret: string, symbol: string, leverage: number, testnet = true) {
  try {
    await fapiSigned('POST', '/fapi/v1/leverage', key, secret, testnet, {
      symbol: symbol.toUpperCase().replace('/', ''), leverage: Math.max(1, Math.min(125, Math.round(leverage))),
    });
    return { success: true, message: `레버리지 ${leverage}x` };
  } catch (e: any) { return { success: false, message: e.message || '레버리지 설정 실패' }; }
}

export async function getFuturesTicker(symbol: string, testnet = true): Promise<number | null> {
  try {
    const sym = symbol.toUpperCase().replace('/', '');
    const r = await fetch(`${base(testnet)}/fapi/v1/ticker/price?symbol=${sym}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat(d.price) || null;
  } catch { return null; }
}

export interface FuturesOrderResult {
  success: boolean; message: string; orderId?: number | string;
  symbol?: string; side?: string; qty?: number; price?: number; raw?: any;
}

export async function placeFuturesOrder(
  key: string, secret: string,
  opts: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: number; price?: number; reduceOnly?: boolean },
  testnet = true,
): Promise<FuturesOrderResult> {
  try {
    const params: Record<string, string | number> = {
      symbol: opts.symbol.toUpperCase().replace('/', ''), side: opts.side, type: opts.type, quantity: opts.quantity,
    };
    if (opts.reduceOnly) params.reduceOnly = 'true';
    if (opts.type === 'LIMIT') {
      if (opts.price == null) return { success: false, message: 'LIMIT은 가격 필요' };
      params.price = opts.price; params.timeInForce = 'GTC';
    }
    const d = await fapiSigned('POST', '/fapi/v1/order', key, secret, testnet, params);
    return {
      success: true, message: '주문 접수', orderId: d.orderId, symbol: d.symbol, side: d.side,
      qty: parseFloat(d.origQty || d.executedQty || '0'), price: parseFloat(d.avgPrice || d.price || '0'), raw: d,
    };
  } catch (e: any) { return { success: false, message: e.message || '주문 실패' }; }
}

export async function placeFuturesTPSL(
  key: string, secret: string,
  opts: { symbol: string; side: 'BUY' | 'SELL'; stopPrice: number; type: 'TAKE_PROFIT_MARKET' | 'STOP_MARKET'; quantity?: number },
  testnet = true,
): Promise<FuturesOrderResult> {
  try {
    const params: Record<string, string | number> = {
      symbol: opts.symbol.toUpperCase().replace('/', ''), side: opts.side, type: opts.type, stopPrice: opts.stopPrice,
    };
    if (opts.quantity != null) { params.quantity = opts.quantity; params.reduceOnly = 'true'; }
    else { params.closePosition = 'true'; }
    const d = await fapiSigned('POST', '/fapi/v1/order', key, secret, testnet, params);
    return { success: true, message: opts.type === 'TAKE_PROFIT_MARKET' ? '익절 설정' : '손절 설정', orderId: d.orderId, symbol: d.symbol, raw: d };
  } catch (e: any) { return { success: false, message: e.message || 'TP/SL 실패' }; }
}

export async function cancelFuturesOrder(key: string, secret: string, symbol: string, orderId: number | string, testnet = true) {
  try {
    await fapiSigned('DELETE', '/fapi/v1/order', key, secret, testnet, { symbol: symbol.toUpperCase().replace('/', ''), orderId });
    return { success: true, message: '주문 취소됨' };
  } catch (e: any) { return { success: false, message: e.message || '취소 실패' }; }
}

export async function testFuturesConnection(key: string, secret: string, testnet = true) {
  try {
    const acc = await fapiSigned('GET', '/fapi/v2/account', key, secret, testnet);
    return {
      success: true, message: testnet ? '테스트넷 연결 성공' : '실전 연결 성공',
      canTrade: acc.canTrade ?? false, totalBalance: parseFloat(acc.totalWalletBalance || '0'),
    };
  } catch (e: any) {
    const msg = e.message || '';
    let friendly = msg;
    if (msg.includes('-2014') || msg.includes('Invalid API-key') || msg.includes('Api key')) friendly = `API 키 무효 — 실전 키를 테스트넷에 넣었거나 키가 틀림 (원문: ${msg})`;
    else if (msg.includes('-2015')) friendly = `API 키 권한/IP 문제 — Futures 권한 활성화 + IP 제한 해제 필요 (원문: ${msg})`;
    else if (msg.includes('-1022') || msg.toLowerCase().includes('signature')) friendly = `서명 오류 — Secret Key 재확인/재발급 필요 (원문: ${msg})`;
    else if (msg.includes('-1021') || msg.toLowerCase().includes('recvwindow') || msg.toLowerCase().includes('timestamp')) friendly = `타임스탬프 오류 — 서버 시간 동기화 문제 (원문: ${msg})`;
    else if (msg.toLowerCase().includes('ip')) friendly = `IP 제한에 막힘 — 테스트넷은 IP 제한 해제 권장 (원문: ${msg})`;
    return { success: false, message: friendly };
  }
}

// ─── LOT_SIZE / 수량 정밀도 처리 ──────────────────────────────
// 거래소 심볼별 최소 수량/스텝 캐시 (5분)
const _lotCache: Record<string, { stepSize: number; minQty: number; tickSize: number; at: number }> = {};

export async function getSymbolFilters(symbol: string, testnet = true): Promise<{ stepSize: number; minQty: number; tickSize: number } | null> {
  const sym = symbol.toUpperCase().replace('/', '');
  const cached = _lotCache[sym];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;
  try {
    const r = await fetch(`${base(testnet)}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    const s = (data.symbols || []).find((x: any) => x.symbol === sym);
    if (!s) return null;
    const lot = (s.filters || []).find((f: any) => f.filterType === 'LOT_SIZE');
    const priceF = (s.filters || []).find((f: any) => f.filterType === 'PRICE_FILTER');
    const result = {
      stepSize: parseFloat(lot?.stepSize || '0.001'),
      minQty:   parseFloat(lot?.minQty || '0.001'),
      tickSize: parseFloat(priceF?.tickSize || '0.01'),
      at: Date.now(),
    };
    _lotCache[sym] = result;
    return result;
  } catch { return null; }
}

// 수량을 stepSize에 맞게 내림 + 최소수량 보정
export function roundToStep(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const decimals = Math.max(0, Math.round(-Math.log10(stepSize)));
  const rounded = Math.floor(qty / stepSize) * stepSize;
  return parseFloat(rounded.toFixed(decimals));
}

// 가격을 tickSize에 맞게 반올림
export function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  const decimals = Math.max(0, Math.round(-Math.log10(tickSize)));
  const rounded = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(decimals));
}

// LOT_SIZE 적용된 안전 주문 (권장)
export async function placeFuturesOrderSafe(
  key: string, secret: string,
  opts: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: number; price?: number; reduceOnly?: boolean },
  testnet = true,
): Promise<FuturesOrderResult> {
  const filters = await getSymbolFilters(opts.symbol, testnet);
  let qty = opts.quantity;
  let price = opts.price;
  if (filters) {
    qty = roundToStep(opts.quantity, filters.stepSize);
    if (qty < filters.minQty) {
      return { success: false, message: `주문 수량(${qty})이 최소 수량(${filters.minQty}) 미만입니다. 주문 금액을 늘리세요.` };
    }
    if (price != null) price = roundToTick(price, filters.tickSize);
  }
  return placeFuturesOrder(key, secret, { ...opts, quantity: qty, price }, testnet);
}
