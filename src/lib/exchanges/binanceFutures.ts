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

// 실제 정산된 펀딩비 조회 (incomeType=FUNDING_FEE). income<0=지불, income>0=수령
export interface FuturesFundingItem { symbol: string; income: number; time: number; }
export async function getFuturesFunding(
  key: string, secret: string, testnet = true,
  opts: { symbol?: string; startTime?: number; limit?: number } = {},
) {
  try {
    const params: Record<string, string | number> = { incomeType: 'FUNDING_FEE', limit: opts.limit ?? 100 };
    if (opts.symbol)    params.symbol    = opts.symbol.toUpperCase().replace('/', '');
    if (opts.startTime) params.startTime = opts.startTime;
    const data = await fapiSigned('GET', '/fapi/v1/income', key, secret, testnet, params);
    const items: FuturesFundingItem[] = (Array.isArray(data) ? data : [])
      .map((d: any) => ({ symbol: d.symbol, income: parseFloat(d.income), time: d.time }));
    const total = items.reduce((s, i) => s + i.income, 0);
    const bySymbol: Record<string, number> = {};
    for (const i of items) bySymbol[i.symbol] = (bySymbol[i.symbol] || 0) + i.income;
    return { success: true, message: `펀딩 ${items.length}건`, total, bySymbol, items };
  } catch (e: any) {
    return { success: false, message: e.message || '펀딩비 조회 실패', total: 0, bySymbol: {} as Record<string, number>, items: [] as FuturesFundingItem[] };
  }
}

// ── 레버리지 브래킷 (심볼별 실제 유지증거금률/공제액) ──────────────
// Binance /fapi/v1/leverageBracket (서명 필요). 응답을 [상한, MMR, 공제액] 형태로 변환
export type BracketTier = [cap: number, mmr: number, maintAmount: number];
interface BracketCacheEntry { tiers: BracketTier[]; ts: number; }
const BRACKET_CACHE = new Map<string, BracketCacheEntry>();
const BRACKET_TTL = 6 * 60 * 60 * 1000; // 6시간

function parseBrackets(raw: any): BracketTier[] {
  const arr = Array.isArray(raw?.brackets) ? raw.brackets : [];
  return arr
    .map((b: any): BracketTier => [
      parseFloat(b.notionalCap),
      parseFloat(b.maintMarginRatio),
      parseFloat(b.cum ?? b.cumFastMaintenanceAmount ?? '0'),
    ])
    .sort((a: BracketTier, b: BracketTier) => a[0] - b[0]);
}

export async function getLeverageBrackets(
  key: string, secret: string, testnet = true, symbol?: string,
) {
  try {
    const params: Record<string, string | number> = {};
    if (symbol) params.symbol = symbol.toUpperCase().replace('/', '');
    const data = await fapiSigned('GET', '/fapi/v1/leverageBracket', key, secret, testnet, params);
    const list = Array.isArray(data) ? data : [data];
    const out: Record<string, BracketTier[]> = {};
    for (const item of list) {
      if (item?.symbol) out[item.symbol] = parseBrackets(item);
    }
    return { success: true, brackets: out };
  } catch (e: any) {
    return { success: false, message: e.message || '브래킷 조회 실패', brackets: {} as Record<string, BracketTier[]> };
  }
}

// 캐시 우선 단일 심볼 브래킷 조회 (TTL 6시간). 실패 시 null → 호출측이 fallback 사용
export async function getCachedBracket(
  symbol: string, key: string, secret: string, testnet = true,
): Promise<BracketTier[] | null> {
  const sym = symbol.toUpperCase().replace('/', '');
  const cacheKey = `${testnet ? 'T' : 'L'}:${sym}`;
  const hit = BRACKET_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.ts < BRACKET_TTL) return hit.tiers;
  const res = await getLeverageBrackets(key, secret, testnet, sym);
  const tiers = res.brackets[sym];
  if (tiers && tiers.length) {
    BRACKET_CACHE.set(cacheKey, { tiers, ts: Date.now() });
    return tiers;
  }
  return hit ? hit.tiers : null; // 만료된 캐시라도 있으면 그거라도
}

// 펀딩 예측용 premiumIndex (공개 엔드포인트, 서명 불필요) — 45초 캐시
export interface PremiumIndex { symbol: string; markPrice: number; indexPrice: number; lastFundingRate: number; nextFundingTime: number; }
interface PremiumCacheEntry { data: PremiumIndex; ts: number; }
const PREMIUM_CACHE = new Map<string, PremiumCacheEntry>();
const PREMIUM_TTL = 45 * 1000;

export async function getPremiumIndex(symbol: string, testnet = true): Promise<PremiumIndex | null> {
  const sym = symbol.toUpperCase().replace('/', '');
  const cacheKey = `${testnet ? 'T' : 'L'}:${sym}`;
  const hit = PREMIUM_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.ts < PREMIUM_TTL) return hit.data;
  try {
    const r = await fetch(`${base(testnet)}/fapi/v1/premiumIndex?symbol=${sym}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return hit ? hit.data : null;
    const d = await r.json();
    const data: PremiumIndex = {
      symbol: d.symbol,
      markPrice: parseFloat(d.markPrice || '0'),
      indexPrice: parseFloat(d.indexPrice || '0'),
      lastFundingRate: parseFloat(d.lastFundingRate || '0'),
      nextFundingTime: Number(d.nextFundingTime || 0),
    };
    PREMIUM_CACHE.set(cacheKey, { data, ts: Date.now() });
    return data;
  } catch {
    return hit ? hit.data : null;
  }
}

// ── 전체 오픈주문 취소 (C 옵션) — 심볼별 DELETE allOpenOrders ───────
export async function cancelAllOpenOrders(key: string, secret: string, testnet = true, symbols?: string[]) {
  let syms = symbols;
  if (!syms) {
    const { orders } = await getFuturesOpenOrders(key, secret, testnet);
    const { positions } = await getFuturesPositions(key, secret, testnet);
    const set = new Set<string>([
      ...(orders || []).map(o => o.symbol),
      ...((positions || []) as any[]).filter((p: any) => Math.abs(p.amount || 0) > 0).map((p: any) => p.symbol),
    ]);
    syms = Array.from(set);
  }
  const results: Array<{ symbol: string; ok: boolean; message?: string }> = [];
  for (const sym of syms) {
    try { await fapiSigned('DELETE', '/fapi/v1/allOpenOrders', key, secret, testnet, { symbol: sym.toUpperCase().replace('/', '') }); results.push({ symbol: sym, ok: true }); }
    catch (e: any) { results.push({ symbol: sym, ok: false, message: e.message || '취소 실패' }); }
  }
  return { success: results.every(r => r.ok), results, count: syms.length };
}

// ── 전체 포지션 종료 (D 옵션) — reduce-only MARKET, 3초 간격 최대 5회 재시도 ──
export async function closeAllPositions(key: string, secret: string, testnet = true, maxRetry = 5) {
  const attempts: Array<{ symbol: string; ok: boolean; message?: string }> = [];
  for (let i = 1; i <= maxRetry; i++) {
    const { positions } = await getFuturesPositions(key, secret, testnet);
    const open = ((positions || []) as any[]).filter((p: any) => Math.abs(p.amount || 0) > 0);
    if (open.length === 0) return { success: true, remaining: 0, retries: i - 1, attempts };
    for (const p of open) {
      const side: 'BUY' | 'SELL' = (p.amount || 0) > 0 ? 'SELL' : 'BUY';
      const r = await placeFuturesOrderSafe(key, secret, { symbol: p.symbol, side, type: 'MARKET', quantity: Math.abs(p.amount), reduceOnly: true }, testnet);
      attempts.push({ symbol: p.symbol, ok: r.success, message: r.message });
    }
    if (i < maxRetry) await new Promise(res => setTimeout(res, 3000));  // 3초 간격 재시도
  }
  const { positions } = await getFuturesPositions(key, secret, testnet);
  const remaining = ((positions || []) as any[]).filter((p: any) => Math.abs(p.amount || 0) > 0).length;
  return { success: remaining === 0, remaining, retries: maxRetry, attempts };
}

// 현재 잔여 포지션/주문 수 (reconciliation용)
export async function countOpen(key: string, secret: string, testnet = true) {
  const [{ positions }, { orders }] = await Promise.all([
    getFuturesPositions(key, secret, testnet),
    getFuturesOpenOrders(key, secret, testnet),
  ]);
  const posN = ((positions || []) as any[]).filter((p: any) => Math.abs(p.amount || 0) > 0).length;
  const ordN = (orders || []).length;
  return { positions: posN, orders: ordN };
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
      workingType: 'MARK_PRICE',
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

// 미체결 주문 조회 (TP/SL 등) — type별 stopPrice 추출용
export interface FuturesOpenOrder { orderId: number; symbol: string; type: string; side: string; stopPrice: number; closePosition: boolean; reduceOnly: boolean; }
export async function getFuturesOpenOrders(key: string, secret: string, testnet = true, symbol?: string) {
  try {
    const params: Record<string, string | number> = {};
    if (symbol) params.symbol = symbol.toUpperCase().replace('/', '');
    const data = await fapiSigned('GET', '/fapi/v1/openOrders', key, secret, testnet, params);
    const orders: FuturesOpenOrder[] = (Array.isArray(data) ? data : []).map((o: any) => ({
      orderId: o.orderId, symbol: o.symbol, type: o.type, side: o.side,
      stopPrice: parseFloat(o.stopPrice || '0'),
      closePosition: !!o.closePosition, reduceOnly: !!o.reduceOnly,
    }));
    return { success: true, orders };
  } catch (e: any) { return { success: false, message: e.message || '미체결 조회 실패', orders: [] as FuturesOpenOrder[] }; }
}

// 심볼의 기존 TP/SL(STOP_MARKET·TAKE_PROFIT_MARKET) 주문만 취소 (replace용)
export async function cancelOpenTPSL(key: string, secret: string, symbol: string, testnet = true, only?: 'TP' | 'SL') {
  try {
    const { orders } = await getFuturesOpenOrders(key, secret, testnet, symbol);
    const targets = orders.filter(o => {
      const isTP = o.type === 'TAKE_PROFIT_MARKET';
      const isSL = o.type === 'STOP_MARKET';
      if (only === 'TP') return isTP;
      if (only === 'SL') return isSL;
      return isTP || isSL;
    });
    for (const o of targets) {
      try { await cancelFuturesOrder(key, secret, symbol, o.orderId, testnet); } catch { /* 개별 실패 무시 */ }
    }
    return { success: true, cancelled: targets.length };
  } catch (e: any) { return { success: false, message: e.message || '기존 TP/SL 취소 실패', cancelled: 0 }; }
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
