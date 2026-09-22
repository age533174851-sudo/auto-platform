// src/lib/markets/venueSpecSource.ts
//
// **격자를 어디서 읽어 오는가 — 그리고 못 읽었을 때 무엇을 남기는가.**
//
// 조회 코드를 새로 쓰지 않는다
// ────────────────────────────
// `binanceFutures.getSymbolFilters`는 이미 제대로 돼 있다 — LOT_SIZE ·
// MARKET_LOT_SIZE · PRICE_FILTER · MIN_NOTIONAL을 각각 읽고, 하나라도
// 없으면 그 격자를 `null`로 둔다. 그 파일 주석이 규율을 적어 두었다:
// **"못 읽으면 만들어내지 않는다 / 값을 추론하지 않는다."**
//
// 여기서는 그것을 `VenueSpec`으로 옮기기만 한다. 두 번째 조회 구현을
// 만들면 언젠가 한쪽만 고쳐진다.
//
// ★ 캐시 우선
// ───────────
// 조회 실패가 곧 "격자가 없다"는 뜻은 아니다. 5분 전에 읽은 값이 있으면
// 그게 지금도 맞을 가능성이 훨씬 높다. 그래서 실패하면 마지막으로 읽은
// 값을 쓰고 `source: 'CACHED'`로 적는다 — **맞췄다고 적지 않는다.**
//
// 그래도 없으면 `UNKNOWN`이다. 0이나 기본값이 아니다.

import {
  unknownSpec, type VenueId, type VenueSpec,
} from './venueSpec';

/** 거래소를 다시 부르지 않는 창(ms). `getSymbolFilters`의 내부 캐시와 같은 값 */
const FRESH_MS = 5 * 60 * 1000;
/**
 * 실패했을 때 얼마나 오래된 값까지 쓸 것인가.
 *
 * 신선한 값보다 길다 — 조회가 몇 분 막히는 동안 격자가 바뀌는 일은
 * 드물고, 그 사이 주문을 전부 안 맞춘 채 보내는 것이 더 나쁘다.
 */
const STALE_OK_MS = 60 * 60 * 1000;

const cache = new Map<string, VenueSpec>();

const keyOf = (venue: VenueId, symbol: string, testnet: boolean) =>
  `${venue}:${testnet ? 'T' : 'L'}:${String(symbol).toUpperCase()}`;

const pos = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** 시험이 캐시 상태를 만들 수 있게. 제품 코드에서는 부르지 않는다. */
export function __seedSpecCache(spec: VenueSpec, testnet = false): void {
  cache.set(keyOf(spec.venue, spec.symbol, testnet), spec);
}
export function __clearSpecCache(): void { cache.clear(); }

/**
 * 이 venue·종목의 격자.
 *
 * **절대 던지지 않는다.** 실패는 `UNKNOWN` 스펙으로 돌아오고, 부르는 쪽이
 * `normalizeForVenue`에 그대로 넘기면 절충 정책이 적용된다.
 */
export async function fetchVenueSpec(
  venue: VenueId, symbol: string, testnet = false,
): Promise<VenueSpec> {
  const sym = String(symbol || '').toUpperCase().replace('/', '');
  if (!sym) return unknownSpec(venue, String(symbol || ''));

  const k = keyOf(venue, sym, testnet);
  const hit = cache.get(k);
  if (hit && hit.fetchedAt != null && Date.now() - hit.fetchedAt < FRESH_MS) {
    return hit;
  }

  let fresh: VenueSpec | null = null;
  try {
    fresh = await readSpec(venue, sym, testnet);
  } catch {
    fresh = null;
  }

  if (fresh) {
    cache.set(k, fresh);
    return fresh;
  }

  // ── 조회 실패 — 최근 값이 있으면 그것을 쓴다 ──
  if (hit && hit.fetchedAt != null && Date.now() - hit.fetchedAt < STALE_OK_MS) {
    return { ...hit, source: 'CACHED' };
  }
  return unknownSpec(venue, sym);
}

/** venue별 실제 조회. **격자를 만들어내지 않는다** */
async function readSpec(
  venue: VenueId, sym: string, testnet: boolean,
): Promise<VenueSpec | null> {
  const base = {
    venue, symbol: sym, source: 'EXCHANGE' as const,
    maxQty: null as number | null, multiplier: null as number | null,
    fetchedAt: Date.now(),
  };

  if (venue === 'BINANCE_USDM') {
    // 이미 규율이 잡힌 조회를 그대로 쓴다.
    const bf = await import('../exchanges/binanceFutures');
    const f = await bf.getSymbolFilters(sym, testnet);
    if (!f) return null;
    return {
      ...base,
      tickSize: pos(f.tickSize),
      stepSize: pos(f.limitQty?.stepSize),
      minQty: pos(f.limitQty?.minQty),
      minNotional: pos(f.minNotional),
      marketStepSize: pos(f.marketQty?.stepSize),
      marketMinQty: pos(f.marketQty?.minQty),
    };
  }

  if (venue === 'BINANCE_SPOT') {
    const b = await import('../exchanges/binance');
    const f = await b.getSpotSymbolFilters(sym, testnet);
    if (!f) return null;
    return {
      ...base,
      tickSize: pos(f.tickSize),
      stepSize: pos(f.stepSize),
      minQty: pos(f.minQty),
      minNotional: pos(f.minNotional),
      marketStepSize: pos(f.marketStepSize),
      marketMinQty: pos(f.marketMinQty),
    };
  }

  // ── 아직 읽지 않는 venue ──
  //
  // COIN-M은 계약배수만 권위가 있고 격자는 없다. Gate는 계약 수 기반이라
  // 모양이 다르다. 주식은 호가단위 출처가 없다.
  //
  // **여기서 다른 venue의 격자를 빌려 오지 않는다.** 현물 격자를 선물에
  // 쓰는 것이 이 Phase가 막으려는 바로 그 고장이다. 못 읽는 것은 못
  // 읽는 것으로 둔다 — 절충 정책이 받아서 "안 맞췄다"고 적는다.
  return null;
}
