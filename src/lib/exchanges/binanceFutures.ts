// ─────────────────────────────────────────────────────────────
// Binance USDT-M Futures API Adapter (server-side only)
// testnet(demo): https://demo-fapi.binance.com / 실전: https://fapi.binance.com
// 바이낸스가 testnet.binancefuture.com → demo-fapi.binance.com 으로 변경
// ⚠️ 출금 권한 없는 키만. 서버에서만 호출. 프론트 노출 금지.
// ─────────────────────────────────────────────────────────────
import { createHmac, createHash } from 'crypto';
import {
  readPositionRiskWithProvenance,
  type PositionRiskProvenance, type SymbolPositionRisk,
} from './positionRiskRead';
export type { PositionRiskProvenance, SymbolPositionRisk };
import { parseLossless, venueIdOf } from './losslessJson';
import { qtyGridFor, type SymbolFilters } from './quantize';

const FUTURES_BASE         = 'https://fapi.binance.com';
const TESTNET_FUTURES_BASE = 'https://demo-fapi.binance.com';

function base(testnet: boolean): string {
  return testnet ? TESTNET_FUTURES_BASE : FUTURES_BASE;
}

/**
 * 선물 호스트. **호스트를 두 벌로 적지 않는다.**
 *
 * 봉을 읽는 쪽(venueBars)이 자기 상수를 따로 들고 있으면, 데모 주소를
 * 한쪽만 고치는 순간 시세와 주문이 다른 서버를 보게 된다.
 */
export function futuresBase(testnet: boolean): string { return base(testnet); }
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
    // 에러 본문에서는 code/msg만 쓴다 — 주문 번호를 읽지 않으므로 안전하다.
    const err = await r.json().catch(() => ({})); // eslint-disable-line -- error message only
    console.log('[Binance] ERROR:', r.status, '| code:', err.code, '| msg:', err.msg);
    // 바이낸스 에러코드 + 메시지 그대로 전달
    throw new Error(err.msg ? `[${err.code}] ${err.msg}` : `HTTP ${r.status}`);
  }
  // ── **주문 번호를 숫자로 읽지 않는다** ──
  //
  // 바이낸스 `orderId`도 스키마상 int64다. 지금 값은 아직
  // Number.MAX_SAFE_INTEGER 안이지만, Gate에서 이미 같은 고장이 났다
  // (2026-08-16: 2089209928026685400 → 마지막 자릿수 반올림 → 취소 실패).
  // **거래소가 번호를 키우기 시작한 뒤에 알아채면 늦는다.**
  return parseLossless(await r.text());
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
  /** 거래소가 보고한 실제 마진 타입. 'isolated'가 아니면 격리 전제가 깨진 것이다. */
  marginType: string;
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
          marginType: String(p.marginType || '').toLowerCase(),
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

/**
 * 오늘의 손익 원장. **종류를 가리지 않고 받아온다.**
 *
 * `getFuturesFunding`은 펀딩만 본다. 일일 손실 한도는 실현손익·수수료·
 * 펀딩을 **모두** 세야 한다 — 100배로 자주 들어가면 수수료가 손익보다 커지는
 * 구간이 있고, 무기한은 8시간마다 펀딩을 낸다. 수수료를 빼놓고 "오늘 얼마
 * 잃었나"에 답하면 그건 다른 질문의 답이다.
 *
 * 합산은 `lib/risk/dailyLoss.ts`의 순수 함수가 한다. 여기서는 받아만 온다.
 *
 * **못 받으면 null이다.** 빈 배열로 돌려주면 호출자가 '오늘 거래 없음'으로
 * 읽고, 그러면 한도가 통째로 사라진다.
 */
export async function getFuturesIncome(
  key: string, secret: string, testnet = true,
  opts: { startTime?: number; limit?: number } = {},
): Promise<any[] | null> {
  try {
    const params: Record<string, string | number> = { limit: opts.limit ?? 1000 };
    if (opts.startTime) params.startTime = opts.startTime;
    const data = await fapiSigned('GET', '/fapi/v1/income', key, secret, testnet, params);
    return Array.isArray(data) ? data : null;
  } catch { return null; }
}

// ── 레버리지 브래킷 (심볼별 실제 유지증거금률/공제액) ──────────────
// Binance /fapi/v1/leverageBracket (서명 필요). 응답을 [상한, MMR, 공제액] 형태로 변환
export type { BracketTier } from './leverageBracket';
export { parseBrackets } from './leverageBracket';
import { parseBrackets, type BracketTier } from './leverageBracket';

// 캐시는 여기 남는다 — 파서는 순수 함수이고, 캐시는 네트워크 호출의 것이다.
interface BracketCacheEntry { tiers: BracketTier[]; ts: number; }
const BRACKET_CACHE = new Map<string, BracketCacheEntry>();
const BRACKET_TTL = 6 * 60 * 60 * 1000; // 6시간

/**
 * 이 심볼에서 거래소가 허용하는 **최대 배율**.
 *
 * `getLeverageBrackets`를 쓸 수 없다 — `parseBrackets`가 명목가 구간과
 * 유지증거금률만 남기고 **`initialLeverage`를 버린다.** 청산가 계산에는
 * 그 둘이면 되지만, "몇 배까지 되나"는 거기 없다.
 *
 * 브래킷은 명목가가 커질수록 상한이 내려간다. 첫 구간(가장 작은 명목가)의
 * 상한이 그 심볼의 최대다.
 *
 * **못 읽으면 null이다.** 125를 채우면 없는 상한을 있다고 적는 것이다.
 */
export async function getMaxLeverage(
  key: string, secret: string, symbol: string, testnet = true,
): Promise<{ maxLeverage: number | null; error: string | null }> {
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    const data = await fapiSigned('GET', '/fapi/v1/leverageBracket', key, secret, testnet, { symbol: sym });
    const list = Array.isArray(data) ? data : [data];
    const hit = list.find((x: any) => String(x?.symbol) === sym) ?? list[0];
    const arr = Array.isArray(hit?.brackets) ? hit.brackets : [];
    let best: number | null = null;
    for (const b of arr) {
      const lev = Number(b?.initialLeverage);
      if (Number.isFinite(lev) && lev > 0 && (best == null || lev > best)) best = lev;
    }
    return best == null
      ? { maxLeverage: null, error: `${sym}의 브래킷에서 최대 배율을 읽지 못했습니다` }
      : { maxLeverage: best, error: null };
  } catch (e: any) {
    return { maxLeverage: null, error: e?.message || '레버리지 브래킷 조회 실패' };
  }
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

/**
 * 브래킷을 어디서 가져왔는가. **"있다"와 "지금 것이다"는 다르다.**
 *
 *   FRESH        TTL 안의 값이거나 방금 읽은 값
 *   STALE_CACHE  TTL이 지났는데 다시 읽는 데 실패해 **옛 값**이 남아 있다
 *   NONE         쓸 값이 없다
 */
export type BracketFreshness = 'FRESH' | 'STALE_CACHE' | 'NONE';

export interface BracketRead {
  tiers: BracketTier[] | null;
  freshness: BracketFreshness;
  /** 이 값을 **실제로 거래소에서 읽은** 시각. 캐시면 그때 그 시각이다 */
  observedAtMs: number | null;
  error: string | null;
}

/**
 * 캐시 키. **계정이 들어간다.**
 *
 * `/fapi/v1/leverageBracket`은 USER_DATA이고 응답의 `notionalCoef`는
 * **계정별 조정 배수**다. 그래서 `테스트넷여부 + 심볼`만으로 키를 만들면,
 * 계정 A가 먼저 BTCUSDT를 읽은 뒤 계정 B가 같은 심볼을 물으면 **A의
 * 브래킷을 받는다.** 100배 청산거리 입력에서 그건 허용할 수 없다.
 *
 * **비밀값을 키에 넣지 않는다** — 저장소 정본인 `fingerprintOf`(SHA-256)로
 * 지문만 쓴다. 캐시 키라 충돌이 곧 계정 섞임이므로 6자리보다 길게 잡는다.
 */
function bracketCacheKey(apiKey: string, symbol: string, testnet: boolean): string {
  const who = createHash('sha256').update(String(apiKey ?? '')).digest('hex').slice(0, 16);
  return `${testnet ? 'T' : 'L'}:${who}:${symbol}`;
}

/**
 * 단일 심볼 브래킷 — **출처와 신선도를 함께** 돌려준다.
 *
 * 옛 `getCachedBracket`은 TTL이 지난 뒤 다시 읽기에 실패하면 옛 값을
 * 조용히 돌려줬다. 그러면 6시간이 아니라 **사실상 무기한** 낡은
 * 유지증거금 구간으로 100배 청산가를 계산하게 된다. "거래소 risk tier를
 * 신뢰할 수 없으면 막는다"는 ②의 계약과 정면으로 어긋난다.
 *
 * 그래서 값을 버리지는 않되 **`STALE_CACHE`라고 말한다.** 그 값을 쓸지는
 * 부르는 쪽이 정한다 — Exact100X는 쓰지 않는다.
 */
export async function readBracket(
  symbol: string, key: string, secret: string, testnet = true,
  /**
   * 거래소 조회. **시험이 주입한다** — 안 주면 정본을 쓴다.
   *
   * 전역 `fetch`를 바꿔치기하지 않는 이유: 공유 하네스에서 그렇게 하면
   * 다른 시험까지 깨진다(실제로 깨뜨렸다). 저장소의 다른 판정들이 쓰는
   * 의존 주입과 같은 모양으로 맞춘다.
   */
  fetchBrackets: (
    k: string, sec: string, tn: boolean, sym: string,
  ) => Promise<{ brackets: Record<string, BracketTier[]>; message?: string }>
    = getLeverageBrackets as any,
  /** 지금 시각. 시험이 고정한다 — 전역 `Date.now`를 바꾸지 않는다 */
  nowMs: () => number = () => Date.now(),
): Promise<BracketRead> {
  const sym = symbol.toUpperCase().replace('/', '');
  const cacheKey = bracketCacheKey(key, sym, testnet);
  const hit = BRACKET_CACHE.get(cacheKey);
  if (hit && nowMs() - hit.ts < BRACKET_TTL) {
    return { tiers: hit.tiers, freshness: 'FRESH', observedAtMs: hit.ts, error: null };
  }
  let res: { brackets: Record<string, BracketTier[]>; message?: string };
  try { res = await fetchBrackets(key, secret, testnet, sym); }
  catch (e: any) { res = { brackets: {}, message: e?.message || '브래킷 조회 실패' }; }
  const tiers = res.brackets[sym];
  if (tiers && tiers.length) {
    const ts = nowMs();
    BRACKET_CACHE.set(cacheKey, { tiers, ts });
    return { tiers, freshness: 'FRESH', observedAtMs: ts, error: null };
  }
  const why = res.message || `${sym}의 브래킷을 읽지 못했습니다`;
  if (hit) {
    // 값은 있지만 **지금 것이 아니다.** 그 사실을 숨기지 않는다.
    return { tiers: hit.tiers, freshness: 'STALE_CACHE', observedAtMs: hit.ts, error: why };
  }
  return { tiers: null, freshness: 'NONE', observedAtMs: null, error: why };
}

/**
 * 옛 이름. **기존 화면의 동작을 바꾸지 않는다** — 낡은 캐시도 그대로
 * 돌려준다(그쪽은 `bracketSource`로 추정/거래소를 구분해 표시한다).
 *
 * ★ Exact100X 청산거리 입력에는 **쓰지 마라.** 낡은 구간으로 100배
 *   청산가를 정하게 된다. 그 경로는 `readBracket`을 쓰고 `FRESH`가
 *   아니면 막는다.
 */
export async function getCachedBracket(
  symbol: string, key: string, secret: string, testnet = true,
): Promise<BracketTier[] | null> {
  const r = await readBracket(symbol, key, secret, testnet);
  return r.tiers;
}

// ── 계정의 **실제** 수수료율 ────────────────────────────────
//
// 기본값 표(`lib/fees.ts`의 `DEFAULT_FEES`)는 등급·BNB 할인·프로모션을
// 모르므로 100배 비용 계산의 출처로 쓸 수 없다. 심볼별 실제 수수료를
// 계정에서 읽는다. **못 읽으면 null이다** — 기본값으로 대체하지 않는다.
export interface CommissionRate {
  symbol: string;
  /** 비율. 0.0004 = 0.04% */
  makerRate: number;
  takerRate: number;
  /**
   * 우리가 이 응답을 **실제로 받은** 시각.
   *
   * 부르는 쪽이 `Date.now()`를 붙이게 두지 않는다 — 그러면 언제 읽었든
   * 항상 "방금"이 되어 신선도 검사가 자기 자신을 속인다.
   */
  observedAtMs: number;
}

export async function getCommissionRate(
  key: string, secret: string, symbol: string, testnet = true,
): Promise<{ rate: CommissionRate | null; error: string | null }> {
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    const d = await fapiSigned('GET', '/fapi/v1/commissionRate', key, secret, testnet,
      { symbol: sym });
    const maker = parseFloat(d?.makerCommissionRate);
    const taker = parseFloat(d?.takerCommissionRate);
    if (!Number.isFinite(maker) || !Number.isFinite(taker)) {
      return { rate: null, error: `${sym}의 수수료율을 읽지 못했습니다` };
    }
    return {
      rate: { symbol: sym, makerRate: maker, takerRate: taker, observedAtMs: Date.now() },
      error: null,
    };
  } catch (e: any) {
    return { rate: null, error: e?.message || '수수료율 조회 실패' };
  }
}

// ── 호가(depth) ─────────────────────────────────────────────
//
// 슬리피지를 상수로 지어내지 않으려면 **실제 호가**가 있어야 한다.
// 공개 엔드포인트다(서명 불필요). 캐시하지 않는다 — 호가는 금방 낡고,
// 낡은 호가로 체결가를 추정하면 그 추정이 가장 틀리는 순간에 쓰인다.
// 관측 시각을 함께 돌려주어 ④(신선도)가 검사할 수 있게 한다.
export interface DepthSnapshot {
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  /** 우리가 응답을 **실제로 받은** 시각 */
  observedAtMs: number;
  /**
   * 거래소가 적어 준 시각. 선물 depth 응답은 `T`(거래 엔진 시각)와
   * `E`(메시지 출력 시각)를 준다 — 호가가 **만들어진** 시각은 `T`다.
   * 둘 다 없으면 null이다. **지어내지 않는다.**
   */
  exchangeTimeMs: number | null;
}

export async function getOrderBookDepth(
  symbol: string, testnet = true, limit = 100,
): Promise<{ depth: DepthSnapshot | null; error: string | null }> {
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    const r = await fetch(`${base(testnet)}/fapi/v1/depth?symbol=${sym}&limit=${limit}`,
      { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!r.ok) return { depth: null, error: `호가 조회 실패 (HTTP ${r.status})` };
    const d = parseLossless(await r.text());
    const lv = (x: any): Array<[number, number]> => (Array.isArray(x) ? x : [])
      .map((e: any) => [parseFloat(e?.[0]), parseFloat(e?.[1])] as [number, number])
      .filter(e => Number.isFinite(e[0]) && Number.isFinite(e[1]));
    const bids = lv(d?.bids);
    const asks = lv(d?.asks);
    if (!bids.length || !asks.length) {
      return { depth: null, error: `${sym}의 호가가 비어 있습니다` };
    }
    const te = Number(d?.T ?? d?.E);
    return {
      depth: { symbol: sym, bids, asks, observedAtMs: Date.now(),
               exchangeTimeMs: Number.isFinite(te) && te > 0 ? te : null },
      error: null,
    };
  } catch (e: any) {
    return { depth: null, error: e?.message || '호가 조회 실패' };
  }
}

// ── 펀딩: 주기와 **지불 상한** ─────────────────────────────
//
// **8시간을 박지 않는다.** 그리고 더 중요한 것: **지금 펀딩률을 미래
// 정산 비용의 상한으로 쓰지 않는다.**
//
// `premiumIndex.lastFundingRate`가 보장하는 것은 "가장 최근 요율"뿐이다.
// 진입 시 0.01%여도 정산 직전에 0.3%가 될 수 있다. 그 값을 반복해서
// 예약하면 reserve가 모자랄 수 있고, 모자란 reserve는 100배에서 증거금
// 전액이다.
//
// 상한은 `/fapi/v1/fundingInfo`가 준다 — `adjustedFundingRateCap`과
// `adjustedFundingRateFloor`. 그 엔드포인트는 **조정된 종목만** 담는다.
//
// ★ 목록에 없는 종목은 **막는다.**
//   예전에는 "목록에 있는 가장 짧은 주기"를 그 종목의 주기로 썼다. 그
//   값은 대상 종목에서 관측한 것이 아니다 — 다른 종목의 숫자를 빌려
//   authoritative인 척한 것이고, 이 저장소가 금지하는 형태다("다른
//   전략의 값을 빌려 쓰지 않는다"). 기본 주기·기본 상한이 무엇인지는
//   이 환경에서 증명하지 못했으므로 **지어내지 않고 막는다.**
export interface FundingBounds {
  symbol: string;
  /** 정산 주기(시간) */
  intervalHours: number;
  /** 요율 상한(비율). LONG이 지불할 수 있는 최대치 */
  capRate: number;
  /** 요율 하한(비율, 음수). SHORT이 지불할 수 있는 최대치의 부호 반대 */
  floorRate: number;
  /** **대상 종목에서 직접 읽은 값만** 이 출처를 쓴다 */
  source: 'EXCHANGE_FUNDING_INFO';
  observedAtMs: number;
}

export async function getFundingBounds(
  symbol: string, testnet = true,
): Promise<{ bounds: FundingBounds | null; error: string | null }> {
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    const r = await fetch(`${base(testnet)}/fapi/v1/fundingInfo`,
      { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!r.ok) return { bounds: null, error: `펀딩 정보 조회 실패 (HTTP ${r.status})` };
    const d = parseLossless(await r.text());
    const list = Array.isArray(d) ? d : [];
    const own = list.find((x: any) => String(x?.symbol || '').toUpperCase() === sym);
    if (!own) {
      // **다른 종목의 숫자를 빌려 쓰지 않는다.**
      return { bounds: null,
        error: `${sym}은 펀딩 정보 목록에 없습니다 — 이 종목의 주기·상한을 직접 읽지 못했습니다`
          + ' (다른 종목의 값을 빌려 쓰지 않습니다)' };
    }
    const hours = parseFloat(own.fundingIntervalHours);
    const cap = parseFloat(own.adjustedFundingRateCap);
    const floor = parseFloat(own.adjustedFundingRateFloor);
    if (!Number.isFinite(hours) || !(hours > 0)
        || !Number.isFinite(cap) || !Number.isFinite(floor)) {
      return { bounds: null,
        error: `${sym}의 펀딩 주기·상한을 읽지 못했습니다`
          + ` (주기 ${own.fundingIntervalHours} · 상한 ${own.adjustedFundingRateCap}`
          + ` · 하한 ${own.adjustedFundingRateFloor})` };
    }
    return {
      bounds: { symbol: sym, intervalHours: hours, capRate: cap, floorRate: floor,
                source: 'EXCHANGE_FUNDING_INFO', observedAtMs: Date.now() },
      error: null,
    };
  } catch (e: any) {
    return { bounds: null, error: e?.message || '펀딩 정보 조회 실패' };
  }
}

// 펀딩 예측용 premiumIndex (공개 엔드포인트, 서명 불필요) — 45초 캐시
export interface PremiumIndex {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastFundingRate: number;
  nextFundingTime: number;
  /**
   * 거래소가 응답에 적어 준 시각(`time`). **없으면 null이다.**
   *
   * 예전에는 이 칸을 버렸다. 그래서 "이 마크가가 거래소에서 언제
   * 만들어졌는가"를 물을 방법이 없었고, 남은 것은 우리가 받은 시각뿐이라
   * **늦게 도착한 값과 방금 만들어진 값을 구분할 수 없었다.**
   */
  timeMs: number | null;
}
interface PremiumCacheEntry { data: PremiumIndex; ts: number; }
const PREMIUM_CACHE = new Map<string, PremiumCacheEntry>();
const PREMIUM_TTL = 45 * 1000;

/**
 * 읽은 값과 **언제 읽었는지**를 함께 준다.
 *
 * 왜 따로 만드는가
 * ────────────────
 * 옛 `getPremiumIndex`는 TTL이 지난 뒤 조회에 실패하면 캐시의 옛 값을
 * 조용히 돌려줬다. 그런데 부르는 쪽(scalp 라우트)은 그 값에
 * `observedAtMs: Date.now()`를 **새로 붙이고** 있었다. 그러면 며칠 된
 * 캐시도 "방금 읽은 펀딩 데이터"로 보인다 — ④(신선도 보호)가 설 기반이
 * 통째로 오염된다.
 *
 * 그래서 **실제 관측 시각을 값과 함께** 돌려준다. 낡은 캐시를 쓰더라도
 * 그 사실(`STALE_CACHE`)과 원래 시각이 남는다. 세탁은 부르는 쪽에서도
 * 할 수 없다 — 붙일 시각이 응답에 들어 있으므로.
 */
export type PremiumFreshness = 'FRESH' | 'STALE_CACHE' | 'NONE';

/** 실제 조회. 주입이 없으면 이것을 쓴다 */
async function defaultPremiumFetch(sym: string, testnet: boolean): Promise<PremiumIndex> {
  const r = await fetch(`${base(testnet)}/fapi/v1/premiumIndex?symbol=${sym}`,
    { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = parseLossless(await r.text());
  // **`|| 0`으로 때우지 않는다** — 없는 시각을 1970년으로 적으면 그
  // 값은 "아주 낡음"이 아니라 "시각을 모름"이다. 둘은 다른 고장이다.
  const t = Number(d.time);
  return {
    symbol: d.symbol,
    markPrice: parseFloat(d.markPrice || '0'),
    indexPrice: parseFloat(d.indexPrice || '0'),
    lastFundingRate: parseFloat(d.lastFundingRate || '0'),
    nextFundingTime: Number(d.nextFundingTime || 0),
    timeMs: Number.isFinite(t) && t > 0 ? t : null,
  };
}

export interface PremiumRead {
  data: PremiumIndex | null;
  freshness: PremiumFreshness;
  /** 이 값을 **실제로 거래소에서 읽은** 시각 */
  observedAtMs: number | null;
  error: string | null;
}

export async function readPremiumIndex(
  symbol: string, testnet = true,
  /** 거래소 조회. **시험이 주입한다** — 전역 `fetch`를 바꾸지 않는다 */
  fetchOne: (sym: string, tn: boolean) => Promise<PremiumIndex> = defaultPremiumFetch,
  /** 지금 시각. 시험이 고정한다 */
  nowMs: () => number = () => Date.now(),
): Promise<PremiumRead> {
  const sym = symbol.toUpperCase().replace('/', '');
  const cacheKey = `${testnet ? 'T' : 'L'}:${sym}`;
  const hit = PREMIUM_CACHE.get(cacheKey);
  if (hit && nowMs() - hit.ts < PREMIUM_TTL) {
    return { data: hit.data, freshness: 'FRESH', observedAtMs: hit.ts, error: null };
  }
  try {
    const data = await fetchOne(sym, testnet);
    const ts = nowMs();
    PREMIUM_CACHE.set(cacheKey, { data, ts });
    return { data, freshness: 'FRESH', observedAtMs: ts, error: null };
  } catch (e: any) {
    const why = e?.message || 'premiumIndex 조회 실패';
    if (hit) {
      // 값은 있지만 **지금 것이 아니다.** 원래 시각을 그대로 들고 간다.
      return { data: hit.data, freshness: 'STALE_CACHE', observedAtMs: hit.ts, error: why };
    }
    return { data: null, freshness: 'NONE', observedAtMs: null, error: why };
  }
}

/**
 * 옛 이름. 기존 화면의 동작을 바꾸지 않는다(낡은 캐시도 돌려준다).
 *
 * ★ Exact100X 비용 입력에는 **쓰지 마라** — 관측 시각이 사라진다.
 *   그 경로는 `readPremiumIndex`를 쓰고 `FRESH`가 아니면 막는다.
 */
export async function getPremiumIndex(symbol: string, testnet = true): Promise<PremiumIndex | null> {
  return (await readPremiumIndex(symbol, testnet)).data;
}

// ── 시장 스냅숏: **한 요청에 한 번만 읽는다** ──
//
// 예전에는 `positionRisk.markPrice` 숫자 하나를 기준가로 썼다. 두 가지가
// 동시에 잘못돼 있었다.
//
//   · 그 응답은 **계좌/포지션 상태**다. 같은 응답에 들어 있다는 이유로
//     마크가를 거기서 떼어 오면, 시장 가격의 관측 시각을 물을 자리가
//     사라진다. 그 응답의 `updateTime`은 **포지션이 갱신된 시각**이지
//     마크가가 만들어진 시각이 아니다 — 포지션을 사흘 안 건드렸으면
//     `updateTime`은 사흘 전이고 마크가는 방금 값이다. 서로의 timestamp가
//     될 수 없다
//   · 숫자만 돌려주니 호출부가 나이를 잴 방법이 없었다
//
// **왜 마크가와 premium을 한 함수에서 주는가**
// ────────────────────────────────────────────
// 둘은 `/fapi/v1/premiumIndex` **같은 응답**에 들어 있다. 따로 읽으면
// 한 진입 안에서 청산거리는 T0의 마크가로, 펀딩은 T1의 요율로 계산된다 —
// ④가 막으려는 바로 그 모양("서로 다른 시점을 하나의 시장 상태처럼")을
// ④ 자신이 만드는 꼴이다. 그래서 **한 번 읽어 둘 다 돌려준다.**
//
// **캐시하지 않는다.** `readPremiumIndex`는 화면·예측용이라 45초 캐시를
// 선언하지만, 100배 청산 여유를 재는 기준가에 45초는 쓸 수 없다. 응답을
// 푸는 코드(`defaultPremiumFetch`)는 **한 벌을 공유한다.**
//
// 한 요청 안에서 여러 번 부르지 않는 것은 **호출부의 일이다** — 라우트가
// 이 Promise를 한 번 만들어 모든 의존이 같은 것을 쓰게 한다.

/** 하나의 관측이 들고 다니는 시각들. 셋은 서로 다른 질문의 답이다 */
export interface ObservationStamps {
  /** 거래소가 응답에 적어 준 시각(`time`). 없으면 null — **지어내지 않는다** */
  exchangeTimeMs: number | null;
  /** 우리 서버가 이 응답을 **실제로 받은** 시각 */
  receivedAtMs: number;
  /**
   * 이 값이 **원래 관측된** 시각.
   *
   * 캐시가 없으면 `receivedAtMs`와 같다. 캐시에서 왔다면 **원본을 받은
   * 그때**다 — 지금이 아니다. 둘을 하나로 뭉개면 "거래소에서 이미 오래된
   * 값"과 "우리 캐시에서 오래된 값"을 구별할 수 없다.
   */
  observedAtMs: number;
  cache: 'FRESH' | 'STALE_CACHE' | 'NONE';
}

export interface MarketSnapshot {
  symbol: string;
  /** 거리를 재는 기준가 */
  markPrice: number;
  /** 지수가(참고). 거리 계산에는 쓰지 않는다 */
  indexPrice: number | null;
  /** 최근 펀딩률. **미래 비용의 상한이 아니다** (상한은 fundingInfo) */
  lastFundingRate: number;
  nextFundingTimeMs: number;
  source: 'EXCHANGE_PREMIUM_INDEX';
  stamps: ObservationStamps;
}

/**
 * 한 진입이 쓰는 **시장 스냅숏 하나.** 마크가와 premium이 같은 순간이다.
 *
 * 실패하면 `snapshot: null`이고 이유를 적는다 — 값도 시각도 지어내지 않는다.
 */
export async function readMarketSnapshot(
  symbol: string, testnet = true,
  /** 거래소 조회. **시험이 주입한다** — 전역 `fetch`를 바꾸지 않는다 */
  fetchOne: (sym: string, tn: boolean) => Promise<PremiumIndex> = defaultPremiumFetch,
  /** 지금 시각. 시험이 고정한다 */
  nowMs: () => number = () => Date.now(),
): Promise<{ snapshot: MarketSnapshot | null; error: string | null }> {
  const sym = symbol.toUpperCase().replace('/', '');
  let d: PremiumIndex;
  try { d = await fetchOne(sym, testnet); }
  catch (e: any) { return { snapshot: null, error: e?.message || '시장 스냅숏 조회 실패' }; }
  const at = nowMs();
  const px = Number(d?.markPrice);
  if (!Number.isFinite(px) || !(px > 0)) {
    return { snapshot: null, error: `${sym}의 마크가를 읽지 못했습니다 (${String(d?.markPrice)})` };
  }
  const ix = Number(d?.indexPrice);
  return {
    snapshot: {
      symbol: sym,
      markPrice: px,
      indexPrice: Number.isFinite(ix) && ix > 0 ? ix : null,
      lastFundingRate: Number(d?.lastFundingRate),
      nextFundingTimeMs: Number(d?.nextFundingTime),
      source: 'EXCHANGE_PREMIUM_INDEX',
      stamps: {
        // **없는 시각을 받은 시각으로 대체하지 않는다.** 그러면 지연이
        // 항상 0이 되어 "늦게 도착한 값"을 영영 못 잡는다.
        exchangeTimeMs: d?.timeMs ?? null,
        receivedAtMs: at,
        // 캐시가 없으므로 원래 관측 시각 = 받은 시각이다.
        observedAtMs: at,
        cache: 'FRESH',
      },
    },
    error: null,
  };
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
/**
 * 포지션을 비율로 줄인다 (부분 청산).
 *
 * worker/src/binance.ts의 closePositionPct를 앱으로 옮긴 것이다. 그 워커는
 * Binance IP 지역 차단으로 쓰지 않고 있어서, 그쪽에만 있던 이 기능은 호출해도
 * 아무 일이 일어나지 않았다.
 *
 * 지키는 것 넷:
 *  - 포지션이 없으면 **성공**이다. 이미 원하는 상태이므로 오류로 만들면
 *    화면이 "청산 실패"를 띄우고 사용자가 다시 누른다
 *  - 방향이 다르면 **거부**한다. 롱을 닫으라는 요청에 숏이 열려 있으면
 *    그건 상태가 어긋난 것이고, 그때 시장가를 보내면 새 포지션이 생긴다
 *  - 수량은 **내림**한다. 올리면 보유량을 넘겨 거래소가 거부하거나,
 *    reduceOnly가 아니었다면 반대 포지션이 열린다
 *  - 계산된 수량이 최소 단위에 못 미치면 **전량**으로 올린다. 1%를 닫으려다
 *    아무것도 못 닫는 것보다, 남길 수 없는 양이면 전부 닫는 편이 낫다
 *    (그 사실을 closedQty로 돌려주므로 화면이 숨기지 않을 수 있다)
 */
/**
 * 부분 청산 수량 계산. 순수 함수 — 테스트가 붙는 자리다.
 *
 * 여기서 틀리면 조용하다. 조금 더 닫히거나 덜 닫히는 것은 화면에서 알 수 없고,
 * 그 차이가 남은 포지션의 청산가를 바꾼다.
 */
export function closeQuantityFor(
  totalQty: number, percent: number, stepSize: number, minQty: number,
): { qty: number; fullClose: boolean; reason: string } {
  const total = Math.abs(Number(totalQty) || 0);
  if (total <= 0) return { qty: 0, fullClose: false, reason: '포지션이 없습니다' };

  // 말이 안 되는 비율이면 **거래하지 않는다.**
  //
  // 처음에는 `Number(percent) || 100`으로 두고 "0이나 음수는 전량"이라고 적었다.
  // 그런데 실제 동작은 음수를 1%로 조이고 있었고(주석과 코드가 달랐다), 어느
  // 쪽이든 **잘못된 입력으로 실제 주문을 낸다.** 0%는 '아무것도 하지 않음'이고
  // 음수는 뜻이 없다 — 그때 100%로 해석해 전량을 닫으면 최악이고, 1%로 조여
  // 조금 닫는 것도 요청하지 않은 거래다.
  const raw = Number(percent);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { qty: 0, fullClose: false,
      reason: `비율이 유효하지 않습니다 (${percent}). 추측해서 청산하지 않습니다` };
  }
  // 여기부터는 의도가 읽히는 값이다. 0.5%처럼 너무 작으면 1%로, 100 초과는
  // 보유량보다 많이 닫으라는 뜻이라 전량으로 조인다.
  const pct = Math.max(1, Math.min(100, raw));

  // 내림한다. 올리면 보유량을 넘겨 거래소가 거부하거나, reduceOnly가 아니었다면
  // 반대 포지션이 열린다.
  let qty = stepSize > 0 ? roundToStep(total * (pct / 100), stepSize) : total * (pct / 100);
  let fullClose = pct >= 100;
  let reason = `${pct}%`;

  if (qty < minQty) {
    // 남길 수 없는 양이면 전부 닫는다. 1%를 닫으려다 아무것도 못 닫는 것보다 낫다.
    // 다만 그 사실을 숨기지 않는다 — 호출자가 화면에 적을 수 있게 이유를 돌려준다.
    qty = stepSize > 0 ? roundToStep(total, stepSize) : total;
    fullClose = true;
    reason = `${pct}%가 최소 단위(${minQty}) 미만이라 전량`;
  }
  if (qty <= 0 || qty < minQty) {
    return { qty: 0, fullClose: false, reason: `종료 수량이 최소 단위(${minQty}) 미만입니다` };
  }
  return { qty, fullClose, reason };
}

// ── 청산을 **준비**하는 것과 **보내는** 것을 나눈다 ──
//
// 왜 나누는가
// ───────────
// 전용 종료 권한(⑤)은 "쓰기 직전에 다시 내가 주인인가"를 묻는다. 그런데
// 예전 `closePositionPercent`는 그 확인이 끝난 **뒤에** 포지션 조회와
// 규격 조회를 또 했다 — 네트워크 왕복 두 번이다. 그 사이에 임차가
// 넘어가면 울타리를 확인하고도 남의 포지션에 주문이 나간다.
//
// 그래서 **읽는 일을 전부 앞으로** 모은다. 울타리 확인 뒤에는
// `sendPreparedClose`의 주문 전송 하나만 남는다.
//
// ★ **주문 payload를 만드는 곳은 여전히 한 곳이다.** 수량·반대방향·
//   `reduceOnly`를 두 벌로 만들면 한쪽만 고쳐지고 그때 두 답이 갈린다.

export interface PreparedClose {
  symbol: string;
  /** 보낼 주문의 방향. 포지션의 **반대**다 */
  side: 'BUY' | 'SELL';
  /** 지금 관측한 노출로 만든 수량. **진입 수량이 아니다** */
  quantity: number;
  fullClose: boolean;
  /** 준비 시점에 거래소가 답한 노출 */
  observedQty: number;
  observedSide: 'LONG' | 'SHORT';
  /**
   * 멱등 키. **같은 종료 의도면 같은 값이다.**
   *
   * 울타리가 넘어간 직후 두 실행자가 각자 보내더라도, 같은 식별자면
   * 거래소가 중복을 **알아볼 기회**가 생긴다.
   *
   * ★ 다만 "둘째가 반드시 거부된다"고 주장하지 않는다. 공식 문서는
   *   `newClientOrderId`가 **열린 주문들 사이에서** 고유하다고만 적고,
   *   체결된 MARKET 주문까지 포함한 영구 중복 차단은 확인된 범위 밖이다.
   *   이것은 **추가 방어층**이다.
   */
  clientOrderId: string | null;
  reason: string;
}

/**
 * 청산 주문을 **준비한다.** 거래소를 바꾸지 않는다 — 읽기만 한다.
 *
 * `alreadyFlat`은 "보낼 것이 없다"이고 **실패가 아니다.** 그 둘을 한
 * boolean으로 합치면 "이미 닫혀 있음"이 "주문을 보냈음"으로 적힌다.
 */
export async function prepareClosePosition(
  key: string, secret: string, symbol: string,
  positionSide: 'LONG' | 'SHORT', percent: number, testnet = true,
  /** 멱등 키. 안 주면 붙이지 않는다 — 기존 호출부의 동작을 바꾸지 않는다 */
  clientOrderId: string | null = null,
  /**
   * 거래소 조회. **시험이 주입한다** — 안 주면 정본을 쓴다.
   *
   * 이 함수가 정하는 것은 숫자가 아니라 **방향**이다. LONG을 닫으려면
   * SELL을 보내야 하고, 뒤집히면 `reduceOnly`가 거부하지 않는 한
   * 포지션이 **커진다.** 그 판단이 네트워크 뒤에 숨어 있으면 시험이
   * 지나갈 수 없다 — 실제로 변이 하나가 그래서 새 나갔다.
   * 저장소의 다른 판정들이 쓰는 주입과 같은 모양으로 맞춘다.
   */
  deps: {
    fetchPositions?: (k: string, sec: string, tn: boolean) => Promise<any>;
    fetchFilters?: (sym: string, tn: boolean) => Promise<SymbolFilters | null>;
  } = {},
): Promise<{
  ok: boolean; alreadyFlat: boolean; prepared: PreparedClose | null; message: string;
}> {
  const sym = symbol.toUpperCase().replace('/', '');
  const readPositions = deps.fetchPositions ?? getFuturesPositions;
  const readFilters = deps.fetchFilters ?? getSymbolFilters;
  const posRes: any = await readPositions(key, secret, testnet);
  if (!posRes?.success) {
    // **못 읽은 것을 flat으로 읽지 않는다.**
    return { ok: false, alreadyFlat: false, prepared: null,
      message: `포지션 조회 실패: ${posRes?.message || '사유 미상'}` };
  }
  const pos = (posRes.positions as FuturesPosition[])
    .find(p => p.symbol.toUpperCase() === sym);
  if (!pos || Math.abs(pos.amount) === 0) {
    return { ok: true, alreadyFlat: true, prepared: null, message: '이미 포지션이 없습니다' };
  }
  if (pos.side !== positionSide) {
    return { ok: false, alreadyFlat: false, prepared: null,
      message: `방향 불일치 — 요청 ${positionSide}, 실제 ${pos.side}. 상태를 먼저 대조하세요` };
  }

  const filters = await readFilters(sym, testnet);
  // 청산은 시장가로 나간다 — 시장가 격자를 쓴다. 없으면 격자 없이 간다.
  const grid = qtyGridFor(filters, 'MARKET');
  const calc = closeQuantityFor(
    pos.amount, percent, grid?.stepSize ?? 0, grid?.minQty ?? 0);
  if (calc.qty <= 0) {
    return { ok: false, alreadyFlat: false, prepared: null, message: calc.reason };
  }
  return {
    ok: true, alreadyFlat: false,
    prepared: {
      symbol: sym,
      // **반대 방향이다.** 같은 방향으로 보내면 포지션이 커진다.
      side: pos.side === 'LONG' ? 'SELL' : 'BUY',
      quantity: calc.qty, fullClose: calc.fullClose,
      observedQty: Math.abs(pos.amount), observedSide: pos.side,
      clientOrderId,
      reason: calc.reason,
    },
    message: calc.reason,
  };
}

/**
 * 준비된 청산을 **보낸다.** 여기서는 읽지 않는다.
 *
 * 울타리 확인과 이 호출 사이에 네트워크 왕복이 없어야 한다 — 그 창이
 * 넓을수록 느린 실행자가 뒤늦게 깨어나 남의 포지션을 닫을 여지가 커진다.
 */
export async function sendPreparedClose(
  key: string, secret: string, p: PreparedClose, testnet = true,
): Promise<{ success: boolean; closedQty: number; fullClose: boolean; message: string }> {
  const r = await placeFuturesOrder(key, secret, {
    symbol: p.symbol, side: p.side, type: 'MARKET', quantity: p.quantity,
    // **축소 전용이다.** 빼면 신규 반대 포지션이 된다.
    reduceOnly: true,
    // **멱등 키.** 거래소가 중복을 알아볼 기회를 주는 추가 방어층이다.
    ...(p.clientOrderId ? { clientOrderId: p.clientOrderId } : {}),
  }, testnet);
  if (!r.success) {
    return { success: false, closedQty: 0, fullClose: false, message: r.message };
  }
  return { success: true, closedQty: p.quantity, fullClose: p.fullClose,
    message: `${p.quantity} 종료 (${p.reason})` };
}

/**
 * 옛 이름. **동작을 바꾸지 않는다** — 준비와 전송을 이어서 할 뿐이다.
 *
 * ★ 전용 종료 권한은 이것을 쓰지 않는다. 준비와 전송 사이에 울타리를
 *   다시 확인해야 하기 때문이다.
 */
export async function closePositionPercent(
  key: string, secret: string, symbol: string,
  positionSide: 'LONG' | 'SHORT', percent: number, testnet = true,
): Promise<{ success: boolean; closedQty: number; fullClose: boolean; message: string }> {
  try {
    const prep = await prepareClosePosition(key, secret, symbol, positionSide, percent, testnet);
    if (!prep.ok) return { success: false, closedQty: 0, fullClose: false, message: prep.message };
    if (prep.alreadyFlat || !prep.prepared) {
      return { success: true, closedQty: 0, fullClose: false, message: prep.message };
    }
    return await sendPreparedClose(key, secret, prep.prepared, testnet);
  } catch (e: any) {
    // 여기까지 오면 주문을 보냈는지 알 수 없다. 성공으로 만들지 않는다.
    return { success: false, closedQty: 0, fullClose: false,
      message: e?.message || '부분 청산 실패 — 결과를 확인할 수 없습니다' };
  }
}

export async function countOpen(key: string, secret: string, testnet = true) {
  const [{ positions }, { orders }] = await Promise.all([
    getFuturesPositions(key, secret, testnet),
    getFuturesOpenOrders(key, secret, testnet),
  ]);
  const posN = ((positions || []) as any[]).filter((p: any) => Math.abs(p.amount || 0) > 0).length;
  const ordN = (orders || []).length;
  return { positions: posN, orders: ordN };
}

/**
 * 레버리지를 설정하고 **되읽어 확인한다.**
 *
 * 예전에는 POST가 200을 주면 그대로 `success: true`였다. 그런데 200은
 * "요청을 받았다"이지 "그 값이 됐다"가 아니다. 실제로 화면에 이렇게 떴다:
 *
 *   거래소 100배 · 의도 50배
 *
 * 배율이 의도와 다르면 **계산한 모든 것이 틀린다** — 청산가도, 필요
 * 증거금도, 손절이 청산 안쪽인지도. 100배에서 청산 거리는 1%보다 좁은데
 * 손절을 1.57%에 걸어 두면 손절이 작동하기 전에 청산된다. 그게 이 계좌에서
 * 실제로 일어난 일이다.
 *
 * Gate 경로는 이미 되읽어 확인하고 있었다(setLeverageGateFutures).
 * 바이낸스만 빠져 있었다.
 *
 * **못 읽으면 success:false다.** 확인하지 못한 것은 통과가 아니다.
 */
export async function setFuturesLeverage(
  key: string, secret: string, symbol: string, leverage: number, testnet = true,
): Promise<{ success: boolean; leverage: number | null; message: string }> {
  const want = Math.max(1, Math.min(125, Math.round(leverage)));
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    await fapiSigned('POST', '/fapi/v1/leverage', key, secret, testnet, { symbol: sym, leverage: want });
  } catch (e: any) {
    return { success: false, leverage: null, message: e?.message || '레버리지 설정 실패' };
  }

  // 되읽는다. 설정이 200을 줬다는 것과 계좌가 그 배율이라는 것은 다르다.
  const rr = await getSymbolPositionRiskEx(key, secret, sym, testnet);
  const actual = rr.risk?.leverage ?? null;
  if (actual == null) {
    return { success: false, leverage: null,
      message: `레버리지를 되읽지 못해 확인할 수 없습니다 (${rr.error || '조회 실패'}) — `
             + '배율을 모르면 청산가도 필요 증거금도 계산할 수 없습니다' };
  }
  if (actual === want) return { success: true, leverage: actual, message: `레버리지 ${actual}x 확인` };

  // ── 요청보다 **높으면** 막는다 ──
  //
  // 청산 거리가 계획보다 짧아진다. 손절이 청산 너머로 밀리면 손절은
  // 영원히 발동하지 않는다 — 계획의 전제가 무너진 것이다.
  if (actual > want) {
    return { success: false, leverage: actual,
      message: `거래소 배율이 ${actual}배인데 ${want}배로 설정하지 못했습니다 — `
             + '계획보다 청산이 가까워져 손절이 작동하지 않을 수 있습니다' };
  }
  // 낮게 잡힌 것은 거래소가 상한으로 깎은 경우다. 포지션당 위험은 줄지만
  // 필요 증거금이 늘어 주문이 거부될 수 있다. 막지 않고 사실만 남긴다.
  return { success: true, leverage: actual,
    message: `요청 ${want}배 / 실제 ${actual}배 — 거래소가 낮췄습니다` };
}

/**
 * 마진 타입 설정 (ISOLATED / CROSSED).
 *
 * Binance는 심볼별 마진 타입 기본값이 CROSSED다. 주문 전에 이걸 호출하지
 * 않으면 "격리 증거금" 전략이라도 실제로는 Cross로 체결되고, 손실이 증거금을
 * 넘어 계좌 전체로 번진다. 계단식 전략처럼 1회 증거금을 고정하는 설계는
 * 이 호출이 없으면 전제가 무너진다.
 *
 * 응답 처리에서 주의할 점:
 *  -4046 "No need to change margin type" — 이미 원하는 값이라는 뜻이므로
 *        성공으로 본다. 실패로 처리하면 두 번째 주문부터 전부 막힌다.
 *  -4047/-4048 — 포지션이나 미체결 주문이 있으면 변경할 수 없다.
 *        이때는 진짜 실패다 (현재 타입이 무엇인지 알 수 없으므로).
 */
export async function setFuturesMarginType(
  key: string, secret: string, symbol: string,
  marginType: 'ISOLATED' | 'CROSSED' = 'ISOLATED',
  testnet = true,
): Promise<{ success: boolean; alreadySet: boolean; message: string; code?: number }> {
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    await fapiSigned('POST', '/fapi/v1/marginType', key, secret, testnet, { symbol: sym, marginType });
    return { success: true, alreadySet: false, message: `${sym} 마진 타입 ${marginType}` };
  } catch (e: any) {
    const msg = String(e?.message || '');
    const codeMatch = msg.match(/-?\d{4,5}/);
    const code = codeMatch ? Number(codeMatch[0]) : undefined;

    // 이미 해당 타입 — 성공으로 취급
    if (code === -4046 || /no need to change margin type/i.test(msg)) {
      return { success: true, alreadySet: true, message: `${sym}는 이미 ${marginType}입니다`, code };
    }
    return { success: false, alreadySet: false, message: msg || '마진 타입 설정 실패', code };
  }
}

export async function getFuturesTicker(symbol: string, testnet = true): Promise<number | null> {
  try {
    const sym = symbol.toUpperCase().replace('/', '');
    const r = await fetch(`${base(testnet)}/fapi/v1/ticker/price?symbol=${sym}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = parseLossless(await r.text());
    return parseFloat(d.price) || null;
  } catch { return null; }
}


/**
 * 심볼 하나의 포지션 위험 정보. **포지션이 없어도 돌려준다.**
 *
 * getFuturesPositions와 왜 따로 두는가
 * ────────────────────────────────────
 * 그 함수는 `positionAmt !== 0`으로 걸러낸다. 목록 화면에는 그게 맞다 —
 * 없는 포지션을 줄로 그릴 이유가 없다. 그런데 **주문 전 점검**에는 그 필터가
 * 치명적이다. 신규 진입은 정의상 포지션이 0이므로, 걸러진 목록에서는 그
 * 심볼의 마진 모드를 알 수 없다. 그러면 점검이 "마진 모드를 모른다"로
 * 모든 신규 진입을 막는다.
 *
 * 마진 모드는 포지션이 아니라 **심볼별 계좌 설정**이라 포지션이 0이어도
 * 존재한다. 그 값을 읽으려고 이 함수를 둔다. symbol을 지정하므로 응답도
 * 작다 — 전체를 받아 거르는 것보다 싸다.
 */
/**
 * 이 심볼의 마진 모드·배율·청산가.
 *
 * **왜 두 번 시도하는가**
 * 바이낸스가 `/fapi/v2/positionRisk`를 없애고 v3로 옮겼다. 그런데 v3
 * 응답에는 **marginType과 leverage가 없다** — 그 둘은 계정 조회로 옮겨
 * 갔다. 그래서 v2가 살아 있는 서버에서는 v2를 쓰고(한 번에 다 온다),
 * 없는 서버에서는 v3 + 계정 조회로 채운다.
 *
 * **실패 이유를 삼키지 않는다**
 * 예전에는 `catch { return null }`이었다. 그래서 마진 모드를 못 읽어도
 * "확인 못 함"까지만 뜨고 **왜 못 읽었는지는 아무도 몰랐다.** 오늘
 * 하루를 그것 때문에 썼다. 이제 이유를 함께 돌려준다.
 */
/**
 * 심볼 하나의 포지션 위험 + **조회 provenance.**
 *
 * 순서와 시각 경계는 `positionRiskRead` 한 곳에 있다 — 여기서 다시 쓰면
 * 두 벌이 되고, 무엇보다 이 파일은 `crypto` 때문에 검사기가 컴파일하지
 * 못해 그 경계를 돌려서 확인할 수 없다.
 */
export async function getSymbolPositionRiskEx(
  key: string, secret: string, symbol: string, testnet = true,
  /** 지금 시각. **시험이 고정한다** */
  nowMs: () => number = () => Date.now(),
): Promise<{
  risk: SymbolPositionRisk | null; error: string | null;
  provenance: PositionRiskProvenance;
}> {
  return readPositionRiskWithProvenance(
    symbol,
    (path, params = {}) => fapiSigned('GET', path, key, secret, testnet, params),
    nowMs,
  );
}

/** 이유가 필요 없을 때 쓰는 얇은 래퍼 */
export async function getSymbolPositionRisk(
  key: string, secret: string, symbol: string, testnet = true,
): Promise<SymbolPositionRisk | null> {
  return (await getSymbolPositionRiskEx(key, secret, symbol, testnet)).risk;
}

/**
 * 거래소 서버 시각 (epoch ms). 못 읽으면 null — 0이 아니다.
 *
 * 왜 필요한가: 서명 요청은 timestamp를 싣고, 바이낸스는 recvWindow(이
 * 프로젝트는 5000ms) 밖의 요청을 -1021로 거절한다. 그 실패는 주문을 보낸
 * **뒤에** 오고 화면에는 그냥 '주문 실패'로 보인다. 원인이 로컬 시계라는
 * 것을 알 방법이 없어서, 주문 전에 미리 비교하려고 둔다.
 *
 * 공개 엔드포인트라 키가 필요 없다 — 연결을 등록하기 전에도 확인할 수 있다.
 */
export async function getFuturesServerTime(testnet = true): Promise<number | null> {
  try {
    const r = await fetch(`${base(testnet)}/fapi/v1/time`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = parseLossless(await r.text());
    const t = Number(d?.serverTime);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch { return null; }
}

/**
 * 이 계좌가 **단방향인가 헤지 모드인가.**
 *
 * 왜 필요한가
 * ───────────
 * 헤지 모드에서는 주문에 `positionSide`(LONG/SHORT)가 필요하고, 단방향
 * 에서는 그걸 보내면 거부된다. 반대로 헤지 모드인데 안 보내면 거래소가
 * 어느 쪽을 줄일지 스스로 고르는데, **그 선택이 우리 의도와 다를 수 있다.**
 *
 * 앱은 롱·숏을 따로 보여주는데 거래소가 단방향이면 두 포지션이 하나로
 * 합쳐진다. 그 상태에서 '숏 청산'을 누르면 롱까지 줄어든다.
 *
 * **못 읽으면 null이다.** 추측한 모드로 주문을 만들면, 틀렸을 때 거부가
 * 아니라 반대 포지션이 열릴 수 있다 — 거부는 불편이고 반대 포지션은 사고다.
 */
export async function getFuturesPositionMode(
  key: string, secret: string, testnet = true,
): Promise<{ mode: 'ONE_WAY' | 'HEDGE' | null; error: string | null }> {
  try {
    const d = await fapiSigned('GET', '/fapi/v1/positionSide/dual', key, secret, testnet);
    const dual = (d as any)?.dualSidePosition;
    // **불리언이 아니면 모른다.** 문자열 'false'가 오는 환경이 있어
    // 그것만 따로 받고, 그 밖의 값은 추측하지 않는다.
    if (dual === true || dual === 'true') return { mode: 'HEDGE', error: null };
    if (dual === false || dual === 'false') return { mode: 'ONE_WAY', error: null };
    return { mode: null, error: `포지션 모드를 알 수 없는 응답입니다 (${JSON.stringify(dual)})` };
  } catch (e: any) {
    return { mode: null, error: e?.message || String(e) };
  }
}

export interface FuturesOrderResult {
  success: boolean; message: string; orderId?: number | string;
  symbol?: string; side?: string; qty?: number; price?: number; raw?: any;
  /**
   * 이 **거래 환경**이 그 주문 유형을 아예 안 받는가(-4120).
   *
   * 파라미터를 고쳐서 될 일이 아니라는 뜻이다. 이게 없으면 화면이
   * 키·권한·수량을 의심하게 만든다 — 거기엔 고칠 것이 없다.
   */
  envUnsupported?: boolean;
}

export async function placeFuturesOrder(
  key: string, secret: string,
  opts: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: number; price?: number; reduceOnly?: boolean; clientOrderId?: string },
  testnet = true,
): Promise<FuturesOrderResult> {
  try {
    const params: Record<string, string | number> = {
      symbol: opts.symbol.toUpperCase().replace('/', ''), side: opts.side, type: opts.type, quantity: opts.quantity,
    };
    // clientOrderId: 재시도 시 중복 주문을 막기 위한 멱등 키.
    // ★ 공식 문서가 보장하는 범위는 **열린 주문들 사이의 고유성**이다.
    //   체결이 끝난 주문까지 포함해 영구히 재사용 불가라고 적혀 있지 않다.
    if (opts.clientOrderId) params.newClientOrderId = opts.clientOrderId;
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
  opts: {
    symbol: string; side: 'BUY' | 'SELL'; stopPrice: number;
    type: 'TAKE_PROFIT_MARKET' | 'STOP_MARKET'; quantity?: number;
    /**
     * 대체 시도에만 쓰는 수량.
     *
     * 손절은 `closePosition: true`로 거는 것이 맞다 — 부분 체결이든
     * 나중에 수량이 바뀌든 '그때 있는 전량'을 닫는다. 그래서 quantity를
     * 안 넘긴다.
     *
     * 그런데 그 모양이 -4120으로 거절되면 대체할 수단이 없어진다.
     * 이 칸은 **1차 시도의 모양을 바꾸지 않으면서** 대체 시도에 쓸 수량을
     * 준다. 없으면 대체 시도를 건너뛴다.
     */
    fallbackQuantity?: number | null;
    /**
     * 트리거 기준가. 기본은 MARK_PRICE — 얇은 호가의 한 틱 꼬리에 손절이
     * 털리는 것을 줄인다. 예전에는 코드에 박혀 있어서 사용자가 Last를
     * 원해도 방법이 없었다.
     */
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  },
  testnet = true,
): Promise<FuturesOrderResult> {
  const sym = opts.symbol.toUpperCase().replace('/', '');
  const label = opts.type === 'TAKE_PROFIT_MARKET' ? '익절' : '손절';

  const attempt = async (shape: 'closePosition' | 'quantity') => {
    const params: Record<string, string | number> = {
      symbol: sym, side: opts.side, type: opts.type, stopPrice: opts.stopPrice,
      workingType: opts.workingType || 'MARK_PRICE',
    };
    if (shape === 'quantity') {
      const q = opts.quantity ?? opts.fallbackQuantity;
      if (q == null || !Number.isFinite(Number(q)) || Number(q) <= 0) {
        throw new Error('수량을 모르면 이 방식으로 걸 수 없습니다');
      }
      params.quantity = Number(q);
      params.reduceOnly = 'true';
    } else {
      params.closePosition = 'true';
    }
    return fapiSigned('POST', '/fapi/v1/order', key, secret, testnet, params);
  };

  // 원래 쓰던 모양. 수량을 알면 reduceOnly, 모르면 closePosition.
  const first: 'closePosition' | 'quantity' = opts.quantity != null ? 'quantity' : 'closePosition';

  try {
    const d = await attempt(first);
    return { success: true, message: `${label} 설정`, orderId: d.orderId, symbol: d.symbol, raw: d };
  } catch (e: any) {
    const msg = String(e?.message || e);

    // ── -4120: 이 엔드포인트가 이 주문 유형을 안 받는다 ──
    //
    // 바이낸스 데모(demo-fapi)에서 STOP_MARKET이 이 오류로 거절되는 것을
    // 봤다. 환경마다 조건부 주문의 파라미터 조합을 받는 범위가 다르므로,
    // **반대 모양으로 한 번 더 시도한다** — closePosition으로 막혔으면
    // 수량+reduceOnly로, 그 반대도 마찬가지.
    //
    // 엔드포인트 주소를 추측해서 바꾸지는 않는다. 어디로 나갈지 확실하지
    // 않은 주문을 실계좌에 보내는 것이 이 오류보다 훨씬 나쁘다.
    const other: 'closePosition' | 'quantity' = first === 'quantity' ? 'closePosition' : 'quantity';
    const retriable = /-4120|not supported for this endpoint|Algo Order/i.test(msg);
    const canRetryWithQty = (opts.quantity ?? opts.fallbackQuantity) != null;
    if (retriable && !(other === 'quantity' && !canRetryWithQty)) {
      try {
        const d2 = await attempt(other);
        return { success: true, message: `${label} 설정 (대체 방식)`, orderId: d2.orderId, symbol: d2.symbol, raw: d2 };
      } catch (e2: any) {
        // 두 모양 다 -4120이면 파라미터 문제가 아니라 **환경 문제**다.
        // 그렇게 말해야 사용자가 키·권한·수량을 뒤지지 않는다.
        const bothBlocked = /-4120|not supported for this endpoint|Algo Order/i
          .test(String(e2?.message || e2));
        return {
          success: false,
          envUnsupported: bothBlocked,
          message: bothBlocked
            ? `${label}을(를) 거래소에 걸 수 없습니다 — ${testnet ? '바이낸스 데모(demo-fapi)' : '이 환경'}가 `
              + `${opts.type} 주문을 받지 않습니다(-4120). 전량 청산·수량 지정 두 방식을 다 시도했습니다. `
              + `키·권한·수량 문제가 아닙니다.`
            : `${label} 부착 실패 — 두 가지 방식을 다 시도했습니다. `
              + `원문: ${msg} / ${String(e2?.message || e2)}`,
        };
      }
    }
    return { success: false, message: msg || 'TP/SL 실패' };
  }
}

/**
 * 트레일링 스톱 (TRAILING_STOP_MARKET).
 *
 * 가격이 유리한 쪽으로 갈 때 손절이 따라 올라가고, `callbackRate`만큼
 * 되돌리면 시장가로 닫는다.
 *
 * 주의할 점 둘
 * ────────────
 *  · `callbackRate`는 거래소가 0.1~10%만 받는다. 범위 밖이면 거절되는데
 *    그 메시지로는 무엇이 잘못됐는지 알기 어렵다 — 부르기 전에
 *    `tpslPlan.checkTrailing`으로 거른다.
 *  · `activationPrice`는 **선택**이다. 안 주면 지금 마크가에서 바로
 *    추적을 시작한다. 주면 그 가격에 닿아야 시작된다 — 방향이 틀리면
 *    영원히 시작되지 않고, 화면에서는 걸린 것처럼 보인다.
 *
 * `closePosition`은 쓰지 않는다. 트레일링은 부분 수량이 흔하고,
 * closePosition과 quantity를 같이 보내면 거래소가 거부한다.
 */
export async function placeFuturesTrailingStop(
  key: string, secret: string,
  opts: {
    symbol: string; side: 'BUY' | 'SELL';
    /** 0.1 ~ 10 (%) */
    callbackRate: number;
    /** 없으면 전량 */
    quantity?: number | null;
    activationPrice?: number | null;
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  },
  testnet = true,
): Promise<FuturesOrderResult> {
  try {
    const params: Record<string, string | number> = {
      symbol: opts.symbol.toUpperCase().replace('/', ''),
      side: opts.side,
      type: 'TRAILING_STOP_MARKET',
      callbackRate: opts.callbackRate,
      workingType: opts.workingType || 'MARK_PRICE',
      reduceOnly: 'true',
    };
    if (opts.quantity != null && opts.quantity > 0) params.quantity = opts.quantity;
    if (opts.activationPrice != null && opts.activationPrice > 0) {
      params.activationPrice = opts.activationPrice;
    }
    const d = await fapiSigned('POST', '/fapi/v1/order', key, secret, testnet, params);
    return {
      success: true,
      message: `트레일링 스톱 설정 (${opts.callbackRate}%)`,
      orderId: d.orderId, symbol: d.symbol, raw: d,
    };
  } catch (e: any) {
    return { success: false, message: e.message || '트레일링 스톱 실패' };
  }
}

export async function cancelFuturesOrder(key: string, secret: string, symbol: string, orderId: number | string, testnet = true) {
  try {
    await fapiSigned('DELETE', '/fapi/v1/order', key, secret, testnet, { symbol: symbol.toUpperCase().replace('/', ''), orderId });
    return { success: true, message: '주문 취소됨' };
  } catch (e: any) { return { success: false, message: e.message || '취소 실패' }; }
}

// 미체결 주문 조회 (TP/SL 등) — type별 stopPrice 추출용
export interface FuturesOpenOrder {
  orderId: number; symbol: string; type: string; side: string; stopPrice: number;
  closePosition: boolean; reduceOnly: boolean;
  // ── 아래 넷은 예전에 **읽어 놓고 버렸다** ──
  // 미체결 탭이 수량·가격 칸을 origQty/price로 그리는데 이 매핑이 그 둘을
  // 떨어뜨려서, 화면에는 언제나 빈칸이 떴다. 조회는 성공했고 응답에
  // 안 실은 것 — 이 저장소에서 가장 자주 반복된 실패다.
  origQty: number | null;
  price: number | null;
  /** MARK_PRICE | CONTRACT_PRICE — 발동 기준 */
  workingType: string | null;
  time: number | null;
  status: string | null;
}
export async function getFuturesOpenOrders(key: string, secret: string, testnet = true, symbol?: string) {
  try {
    const params: Record<string, string | number> = {};
    if (symbol) params.symbol = symbol.toUpperCase().replace('/', '');
    const data = await fapiSigned('GET', '/fapi/v1/openOrders', key, secret, testnet, params);
    const orders: FuturesOpenOrder[] = (Array.isArray(data) ? data : []).map((o: any) => ({
      orderId: o.orderId, symbol: o.symbol, type: o.type, side: o.side,
      stopPrice: parseFloat(o.stopPrice || '0'),
      closePosition: !!o.closePosition, reduceOnly: !!o.reduceOnly,
      // 0과 없음을 구분한다. 수량 0은 '0개 주문'이 아니라 '못 읽었다'이고,
      // 화면이 그 둘을 같게 그리면 사용자는 없는 수량을 믿는다.
      origQty: Number.isFinite(parseFloat(o.origQty)) ? parseFloat(o.origQty) : null,
      price: Number.isFinite(parseFloat(o.price)) && parseFloat(o.price) > 0 ? parseFloat(o.price) : null,
      workingType: o.workingType ? String(o.workingType) : null,
      time: Number.isFinite(Number(o.time)) ? Number(o.time) : null,
      status: o.status ? String(o.status) : null,
    }));
    return { success: true, orders };
  } catch (e: any) { return { success: false, message: e.message || '미체결 조회 실패', orders: [] as FuturesOpenOrder[] }; }
}

/**
 * 심볼의 기존 TP/SL만 취소 (replace용).
 *
 * **전량 청산용(closePosition=true)만 지운다.**
 *
 * 예전에는 STOP_MARKET·TAKE_PROFIT_MARKET을 전부 지웠다. 그러면 분할 익절
 * 사다리(수량 지정 + reduceOnly)와 다른 전략이 걸어 둔 보호주문까지 같이
 * 날아간다. 그쪽 전략은 자기 손절이 살아 있다고 믿고 아무것도 다시 걸지 않는다.
 *
 * 이것은 감사 지적 6번("TP/SL 수정이 타 주문 취소")과 같은 문제다. 그 수정은
 * worker/src/binance.ts에만 들어가 있었고 이 함수에는 오지 않았다 — 지금까지
 * 호출자가 없어서 드러나지 않았다. TP/SL 라우트를 직접 실행으로 옮기며 함께 고쳤다.
 */
export async function cancelOpenTPSL(key: string, secret: string, symbol: string, testnet = true, only?: 'TP' | 'SL') {
  try {
    const { orders } = await getFuturesOpenOrders(key, secret, testnet, symbol);
    const targets = orders.filter(o => {
      // 분할 익절·남의 주문은 건드리지 않는다
      if (o.closePosition !== true) return false;
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
const _lotCache: Record<string, SymbolFilters & { at: number }> = {};

/** 시험에서만 쓴다. 규격은 5분 캐시라 앞 시험의 값이 다음 시험에 남는다 */
export function __clearFiltersCache() {
  for (const k of Object.keys(_lotCache)) delete _lotCache[k];
}

/**
 * 이 심볼의 주문 규격.
 *
 * **주문유형마다 수량 규칙이 다르다.** 바이낸스 USDⓈ-M은 지정가에
 * `LOT_SIZE`, 시장가에 `MARKET_LOT_SIZE`를 따로 준다. 예전에는 `LOT_SIZE`만
 * 읽어서, 시장가 주문도 지정가 격자로 깎고 있었다.
 *
 * `MIN_NOTIONAL`도 읽지 않고 있었다. 그래서 최소 주문 금액 검사는 코드에
 * 자리만 있고 **한 번도 실행된 적이 없었다** — 그 공백을 화면의 상수
 * 20 USDT가 메우고 있었는데, 그건 어느 종목의 값도 아니다.
 *
 * 없는 필터는 null로 둔다. 다른 필터를 복사해 채우지 않는다.
 */
export async function getSymbolFilters(symbol: string, testnet = true): Promise<SymbolFilters | null> {
  const sym = symbol.toUpperCase().replace('/', '');
  // ── 캐시 열쇠에 **호스트**를 넣는다 ──
  //
  // 예전에는 심볼만으로 캐시했다. 그런데 규격은 환경마다 다르다 —
  // 데모의 BTCUSDT는 step 0.0001인데 실전은 0.001이다. 한쪽에서 먼저
  // 읽힌 값이 다른 쪽에 그대로 쓰이면, **맞는 수량을 틀린 격자로
  // 반올림한다.** 그리고 그 주문은 -1111로 거부된다.
  const cacheKey = `${testnet ? 'demo' : 'live'}:${sym}`;
  const cached = _lotCache[cacheKey];
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;
  try {
    const r = await fetch(`${base(testnet)}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = parseLossless(await r.text());
    const s = (data.symbols || []).find((x: any) => x.symbol === sym);
    if (!s) return null;
    const fl = (s.filters || []) as any[];
    const lot = fl.find((f: any) => f.filterType === 'LOT_SIZE');
    const mktLot = fl.find((f: any) => f.filterType === 'MARKET_LOT_SIZE');
    const priceF = fl.find((f: any) => f.filterType === 'PRICE_FILTER');
    const notionalF = fl.find((f: any) => f.filterType === 'MIN_NOTIONAL');

    // ── **못 읽으면 만들어내지 않는다** ──
    //
    // 예전에는 `parseFloat(lot?.stepSize || '0.001')`처럼 기본값을
    // 지어냈다. 종목마다·환경마다 다른 값을 코드에 박아 두면, 규격을
    // 못 읽은 순간 **틀린 격자로 반올림한 주문**이 나간다. 그건 규격을
    // 안 맞춘 것보다 나쁘다 — 맞춘 줄 알고 보내니까.
    //
    // quantize.ts의 원칙이 이미 그렇게 적혀 있다("못 읽으면 그대로
    // 보내고 거래소가 판단하게 둔다"). 여기서 기본값을 채우는 바람에
    // 그 경로가 한 번도 안 돌았다.
    //
    // ── 값을 추론하지 않는다 ──
    //
    // 예전에는 `minQty`가 없으면 `stepSize`를 대신 넣었다. "한 칸이 최소"
    // 라는 추론인데, 바이낸스에서 **둘은 서로 다른 규칙**이다:
    //
    //   minQty    허용되는 최소 수량
    //   stepSize  수량이 움직일 수 있는 단위
    //
    // 최소가 0.01인데 단위가 0.001인 종목에서 그 추론은 최소를 열 배
    // 낮춰 잡는다 — 거래소가 거절할 주문을 우리가 통과시킨다.
    //
    // 그리고 **다른 필터를 가져다 채우지도 않는다.** `MARKET_LOT_SIZE`가
    // 없는데 `LOT_SIZE`를 복사하면 거래소가 두지 않은 규칙을 만드는 것이다.
    //
    // 필요한 값이 하나라도 없으면 그 격자는 null이다. 부르는 쪽이
    // "이 주문유형의 수량 규격을 모른다"로 읽는다.
    const gridOf = (f: any) => {
      const st = parseFloat(f?.stepSize ?? '');
      const mn = parseFloat(f?.minQty ?? '');
      if (!Number.isFinite(st) || st <= 0) return null;
      if (!Number.isFinite(mn) || mn <= 0) return null;
      return { stepSize: st, minQty: mn };
    };
    const limitQty = gridOf(lot);
    const marketQty = gridOf(mktLot);
    const tick = parseFloat(priceF?.tickSize ?? '');
    // 지정가 격자와 호가 단위는 이 심볼이 거래 가능하다는 최소 근거다.
    // 둘 중 하나라도 없으면 규격을 읽은 것으로 치지 않는다.
    if (!limitQty) return null;
    if (!Number.isFinite(tick) || tick <= 0) return null;

    // MIN_NOTIONAL은 `notional` 필드다. 없으면 null — 5나 20을 지어내지 않는다.
    const notionalRaw = parseFloat(notionalF?.notional ?? '');
    const minNotional = Number.isFinite(notionalRaw) && notionalRaw > 0 ? notionalRaw : null;

    const result = { limitQty, marketQty, tickSize: tick, minNotional, at: Date.now() };
    _lotCache[cacheKey] = result;
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

// 주문유형별 수량 격자를 적용한 안전 주문 (권장)
export async function placeFuturesOrderSafe(
  key: string, secret: string,
  opts: { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: number; price?: number; reduceOnly?: boolean },
  testnet = true,
): Promise<FuturesOrderResult> {
  const filters = await getSymbolFilters(opts.symbol, testnet);
  let qty = opts.quantity;
  let price = opts.price;
  // 시장가와 지정가는 격자가 다르다 — 유형에 맞는 것을 쓴다.
  const grid = qtyGridFor(filters, opts.type);
  if (grid?.stepSize) {
    qty = roundToStep(opts.quantity, grid.stepSize);
    if (grid.minQty != null && qty < grid.minQty) {
      return { success: false, message: `주문 수량(${qty})이 최소 수량(${grid.minQty}) 미만입니다. 주문 금액을 늘리세요.` };
    }
  }
  if (price != null && filters?.tickSize) price = roundToTick(price, filters.tickSize);
  return placeFuturesOrder(key, secret, { ...opts, quantity: qty, price }, testnet);
}

/**
 * clientOrderId로 기존 주문 조회 — 재시도 전에 반드시 호출한다.
 * 네트워크 오류로 응답을 못 받았을 때 실제로는 체결됐을 수 있기 때문.
 */
export async function findOrderByClientId(
  key: string, secret: string, symbol: string, clientOrderId: string, testnet = true
): Promise<{ found: boolean; order?: any }> {
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    const d = await fapiSigned('GET', '/fapi/v1/order', key, secret, testnet, {
      symbol: sym,
      origClientOrderId: clientOrderId,
    });
    return { found: !!d?.orderId, order: d };
  } catch (e: any) {
    const msg = String(e?.message || e);
    // -2013 = Order does not exist → 아직 안 나감
    if (/-2013|does not exist|Unknown order/i.test(msg)) return { found: false };

    // ── 이 엔드포인트만 막혔을 수 있다 ──
    //
    // 바이낸스 데모(demo-fapi)에서 `/fapi/v1/order` 단건 조회가 키는
    // 멀쩡한데 -2015를 주는 경우가 있다. 그때 그대로 던지면 **중복 확인을
    // 못 했다는 이유로 주문 전체가 막힌다** — 실제로 그 상태였다.
    //
    // 그렇다고 중복 확인을 건너뛰면 안 된다. 그건 같은 주문이 두 번
    // 나가도 모른다는 뜻이고, 이 검사가 존재하는 이유가 사라진다.
    //
    // 대신 **다른 문으로 같은 것을 확인한다.** 미체결 목록과 최근 주문
    // 목록에서 같은 clientOrderId를 찾는다. 그쪽까지 막히면 그때는
    // 정말 확인 불가이므로 던진다.
    if (!/-2015|-2014|-1022|API-key|Invalid API|permissions/i.test(msg)) throw e;

    try {
      const open = await fapiSigned('GET', '/fapi/v1/openOrders', key, secret, testnet, { symbol: sym });
      const hitOpen = (Array.isArray(open) ? open : [])
        .find((o: any) => String(o?.clientOrderId) === clientOrderId);
      if (hitOpen) return { found: true, order: hitOpen };

      // 미체결에 없다고 '없음'이 아니다 — 이미 체결됐을 수 있다.
      // 최근 주문까지 봐야 '안 나갔다'고 말할 수 있다.
      const recent = await fapiSigned('GET', '/fapi/v1/allOrders', key, secret, testnet, {
        symbol: sym, limit: 100,
      });
      const hit = (Array.isArray(recent) ? recent : [])
        .find((o: any) => String(o?.clientOrderId) === clientOrderId);
      return hit ? { found: true, order: hit } : { found: false };
    } catch (e2: any) {
      // 두 문 다 막혔다 — 이제는 정말 판단 불가다. 원래 오류를 그대로
      // 올린다(그쪽이 원인에 더 가깝다).
      throw e;
    }
  }
}

/**
 * 이 키로 무엇이 되고 무엇이 안 되는가.
 *
 * 왜 필요한가
 * ───────────
 * `-2015 Invalid API-key, IP, or permissions`는 세 가지를 한 문장에 뭉쳐
 * 놓았다. 화면에는 잔고가 멀쩡히 떠 있는데 주문만 막히는 상황에서, 그
 * 문장만 보고는 무엇을 고쳐야 하는지 알 수 없다.
 *
 * 그래서 **엔드포인트별로 하나씩 찔러 보고 결과를 그대로 적는다.**
 * 어떤 것이 되고 어떤 것이 안 되는지가 곧 원인이다:
 *   · 전부 실패      → 키·환경·IP 문제
 *   · 읽기만 성공    → 선물 거래 권한
 *   · 단건 조회만 실패 → 그 엔드포인트가 이 환경에서 안 되는 것
 *
 * **주문은 내지 않는다.** 진단이 부작용을 만들면 진단을 못 돌린다.
 */
export async function diagnoseFutures(
  key: string, secret: string, testnet = true, symbol = 'BTCUSDT',
): Promise<{ host: string; keyPrefix: string; checks: Array<{ name: string; path: string; ok: boolean; detail: string }> }> {
  const sym = symbol.toUpperCase().replace('/', '');
  const probes: Array<{ name: string; path: string; params?: Record<string, string | number> }> = [
    { name: '서버 시각 (서명 없음)', path: '/fapi/v1/time' },
    { name: '잔고 (읽기)', path: '/fapi/v2/balance' },
    { name: '포지션 (읽기)', path: '/fapi/v2/positionRisk', params: { symbol: sym } },
    { name: '미체결 주문 (읽기)', path: '/fapi/v1/openOrders', params: { symbol: sym } },
    { name: '최근 주문 (읽기)', path: '/fapi/v1/allOrders', params: { symbol: sym, limit: 1 } },
    // 없는 clientOrderId를 물어본다. 정상이면 -2013(없음)이 온다 —
    // 그것도 '성공'이다. 여기서 -2015가 오면 이 엔드포인트만 막힌 것이다.
    { name: '단건 주문 조회', path: '/fapi/v1/order', params: { symbol: sym, origClientOrderId: 'diagnose-none' } },
  ];

  const checks: Array<{ name: string; path: string; ok: boolean; detail: string }> = [];
  for (const p of probes) {
    try {
      if (p.path === '/fapi/v1/time') {
        const t = await getFuturesServerTime(testnet);
        checks.push({ name: p.name, path: p.path, ok: t != null, detail: t != null ? '정상' : '응답 없음' });
        continue;
      }
      await fapiSigned('GET', p.path, key, secret, testnet, p.params || {});
      checks.push({ name: p.name, path: p.path, ok: true, detail: '정상' });
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 주문이 없다는 응답은 **인증이 통과했다는 뜻**이다. 실패가 아니다.
      const notFound = /-2013|does not exist|Unknown order/i.test(msg);
      checks.push({ name: p.name, path: p.path, ok: notFound, detail: notFound ? '정상 (해당 주문 없음)' : msg });
    }
  }

  return { host: base(testnet), keyPrefix: String(key || '').slice(0, 8), checks };
}

/**
 * 이 호스트가 **어떤 주문 유형을 받는다고 스스로 말하는가.**
 *
 * 왜 필요한가
 * ───────────
 * 데모(demo-fapi)에서 STOP_MARKET이 -4120으로 거절됐다. 그런데 그건
 * 주문을 실제로 내 봐야 알 수 있었고, 매번 진입·청산 수수료가 나갔다.
 *
 * `exchangeInfo`는 **키도 서명도 필요 없는 공개 조회**이고, 심볼마다
 * `orderTypes`를 알려준다. 미리 물어보면 주문을 내기 전에 알 수 있다.
 *
 * 이 값을 판단에 그대로 쓰지는 않는다 — 거래소가 목록에 적어 두고도
 * 거절하는 경우가 있다(실제로 그랬을 수 있다). 화면에 **사실을 보여주는**
 * 용도다. 목록에 없으면 확실히 안 되는 것이고, 있는데 안 되면 그건
 * 거래소가 목록과 다르게 동작하는 것이라 그렇게 적어야 한다.
 */
export async function futuresOrderTypes(
  hostUrl: string, symbol = 'BTCUSDT',
): Promise<{ ok: boolean; orderTypes: string[]; detail: string }> {
  const sym = symbol.toUpperCase().replace('/', '');
  try {
    const r = await fetch(`${hostUrl}/fapi/v1/exchangeInfo?symbol=${sym}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { ok: false, orderTypes: [], detail: `HTTP ${r.status}` };
    const d = parseLossless(await r.text());
    const row = (Array.isArray(d?.symbols) ? d.symbols : []).find(
      (s: any) => String(s?.symbol).toUpperCase() === sym);
    if (!row) return { ok: false, orderTypes: [], detail: `${sym}을(를) 찾지 못했습니다` };
    const types = Array.isArray(row.orderTypes) ? row.orderTypes.map(String) : [];
    return { ok: true, orderTypes: types, detail: types.length ? types.join(', ') : '목록이 비어 있습니다' };
  } catch (e: any) {
    return { ok: false, orderTypes: [], detail: String(e?.message || e) };
  }
}

/** 진단이 물어볼 선물 호스트들. 옛 테스트넷이 살아 있는지도 함께 본다 */
export const FUTURES_HOSTS = {
  live: FUTURES_BASE,
  demo: TESTNET_FUTURES_BASE,
  /** 바이낸스가 데모로 옮기기 전의 선물 테스트넷. 아직 사는지 확인용 */
  oldTestnet: 'https://testnet.binancefuture.com',
} as const;
