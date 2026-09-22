// src/lib/markets/venueSpec.ts
//
// **주문 하나가 어느 격자 위에 놓이는가 — 제품×venue로 답한다.**
//
// 이미 있던 것과 무엇이 다른가
// ────────────────────────────
// `exchanges/quantize.ts`는 **격자가 주어졌을 때** 수량·가격을 맞추는 계산이고,
// 이미 잘 돼 있다(MARKET/LIMIT 격자 분리, 못 읽으면 만들어내지 않음).
// 이 파일은 그것을 **대체하지 않는다** — 정규화를 두 벌로 만들면 같은 주문이
// 경로에 따라 다른 수량으로 나간다. `quantizeOrder`를 그대로 부른다.
//
// 이 파일이 더하는 것은 두 가지다:
//
//   ① **어느 venue의 격자인가**를 값으로 들고 다닌다. 현물 격자를 선물에,
//      USDT-M 격자를 COIN-M에 쓰는 일이 타입에서 막힌다.
//   ② **규격을 못 읽었을 때 무엇을 할지**를 한 곳에서 정한다.
//
// ★ 규격을 못 읽었을 때 — 절충 정책
// ─────────────────────────────────
// 세 가지 선택지가 있었다:
//
//   그대로 보낸다        지금 동작. 거래소가 판단한다. 맞춘 척을 안 하는 건
//                        정직하지만, 왜 거부됐는지가 사용자에게 안 남는다
//   막는다               `exchangeInfo` 일시 장애에 주문이 전부 막힌다.
//                        지금 성공하던 주문을 새로 막는 건 다른 종류의 사고다
//   ★ 캐시 우선, 없으면 보내되 **안 맞췄다고 적는다**
//
// 셋째를 쓴다. 조회 실패가 곧 "격자가 없다"는 뜻은 아니다 — 5분 전에 읽은
// 값이 있으면 그게 지금도 맞을 가능성이 훨씬 높다. 그래도 없으면 보내되,
// `applied: false`와 사유를 **값으로** 남긴다. 그래야 "맞춘 줄 알았는데
// 안 맞춘" 상태가 화면과 로그에 드러난다.
//
// **이 정책은 진입에만 해당한다.** 청산은 `quantizeOrder`가 이미 규격
// 미상에도 통과시킨다 — 규격을 못 읽어서 포지션에서 못 빠져나오는 것이
// 더 위험하기 때문이고, 그 판단을 여기서 뒤집지 않는다.

import {
  quantizeOrder, type SymbolFilters, type QuantizeCode,
} from '../exchanges/quantize';

/**
 * 격자를 고시하는 주체. **제품이 아니라 venue다** — 같은 "코인 무기한"도
 * 바이낸스와 Gate의 격자가 다르고, USDT-M과 COIN-M은 아예 다른 상품이다.
 */
export type VenueId =
  | 'BINANCE_SPOT'
  | 'BINANCE_USDM'
  | 'BINANCE_COINM'
  | 'GATE_USDM'
  | 'KIS_KR'
  | 'KIS_US';

export const VENUES: readonly VenueId[] = [
  'BINANCE_SPOT', 'BINANCE_USDM', 'BINANCE_COINM', 'GATE_USDM', 'KIS_KR', 'KIS_US',
] as const;

/**
 * 이 격자를 어디서 얻었는가.
 *
 * **값으로 들고 다닌다.** "맞췄다"와 "맞춘 것 같다"를 구별할 수 없으면
 * 사후에 무엇이 틀렸는지 알아낼 방법이 없다.
 */
export type SpecSource =
  /** 지금 거래소에서 읽었다 */
  | 'EXCHANGE'
  /** 문서화된 고정 규칙 (주식 1주 단위 같은 것) */
  | 'KNOWN'
  /** 최근에 읽어 둔 값 */
  | 'CACHED'
  /** 못 읽었다. **0이나 기본값이 아니다** */
  | 'UNKNOWN';

export interface VenueSpec {
  venue: VenueId;
  symbol: string;
  source: SpecSource;
  /** 가격 단위. 모르면 null — 지어내지 않는다 */
  tickSize: number | null;
  /** 지정가 수량 단위 */
  stepSize: number | null;
  minQty: number | null;
  /** venue가 고시하면 담는다. 대부분 없다 */
  maxQty: number | null;
  minNotional: number | null;
  /**
   * 시장가 전용 수량 격자.
   *
   * **없으면 null이다.** 지정가 격자를 복사하지 않는다 — 거래소가 두지
   * 않은 규칙을 만드는 것이기 때문이다(`quantize.ts`가 같은 규율).
   */
  marketStepSize: number | null;
  marketMinQty: number | null;
  /** 1계약이 기초자산 몇 단위인가. 해당 없으면 null */
  multiplier: number | null;
  /** 읽은 시각(ms). 캐시 판단에 쓴다 */
  fetchedAt: number | null;
}

/** 이 격자로 실제 주문을 맞출 수 있는가 */
export function specUsable(s: VenueSpec | null | undefined): boolean {
  return !!s && s.source !== 'UNKNOWN';
}

/** 못 읽었다는 사실을 **값으로** 만든다. null을 흘려보내지 않는다. */
export function unknownSpec(venue: VenueId, symbol: string): VenueSpec {
  return {
    venue, symbol, source: 'UNKNOWN',
    tickSize: null, stepSize: null, minQty: null, maxQty: null, minNotional: null,
    marketStepSize: null, marketMinQty: null, multiplier: null, fetchedAt: null,
  };
}

/**
 * `VenueSpec` → `quantizeOrder`가 받는 모양.
 *
 * **여기서 값을 만들지 않는다.** null은 null로 간다 — `quantizeOrder`가
 * "이 주문유형의 격자를 모른다"로 읽는다.
 */
export function filtersOf(spec: VenueSpec | null | undefined): SymbolFilters | null {
  if (!specUsable(spec)) return null;
  const s = spec as VenueSpec;
  const grid = (step: number | null, min: number | null) =>
    (step == null && min == null) ? null : { stepSize: step, minQty: min };
  return {
    limitQty: grid(s.stepSize, s.minQty),
    marketQty: grid(s.marketStepSize, s.marketMinQty),
    tickSize: s.tickSize,
    minNotional: s.minNotional,
  };
}

export type NormalizeCode =
  | QuantizeCode
  /** venue를 모른다 */
  | 'VENUE_UNKNOWN'
  /** venue 고시 최대 수량 초과 */
  | 'ABOVE_MAX_QTY';

export interface NormalizeResult {
  /** 이 주문을 보내도 되는가 */
  ok: boolean;
  quantity: number | null;
  price: number | null;
  /** **격자를 실제로 적용했는가.** false면 맞추지 않고 보내는 것이다 */
  applied: boolean;
  /** 어느 격자였는가 */
  source: SpecSource;
  venue: VenueId | null;
  changed: boolean;
  code: NormalizeCode | null;
  /** 사용자에게 그대로 보여 줄 한 줄 */
  reason: string;
}

export interface NormalizeInput {
  spec: VenueSpec | null | undefined;
  quantity: number;
  price?: number | null;
  orderType?: 'MARKET' | 'LIMIT' | null;
  reduceOnly?: boolean | null;
  /** 시장가 최소 명목가 검사용 기준가. **서버가 읽은 값이어야 한다** */
  referencePrice?: number | null;
}

/**
 * 주문을 이 venue의 격자에 맞춘다.
 *
 * 계산은 `quantizeOrder`가 한다. 이 함수가 하는 것은 **정책**이다 —
 * 격자를 못 읽었을 때 어떻게 할지, 그리고 그 사실을 어떻게 남길지.
 */
export function normalizeForVenue(i: NormalizeInput): NormalizeResult {
  const q0 = Number(i?.quantity);
  const venue = i?.spec?.venue ?? null;

  if (!venue) {
    return {
      ok: false, quantity: null, price: null, applied: false, source: 'UNKNOWN',
      venue: null, changed: false, code: 'VENUE_UNKNOWN',
      reason: '어느 거래소 규격인지 알 수 없어 주문을 맞추지 못했습니다',
    };
  }
  if (!Number.isFinite(q0) || q0 <= 0) {
    return {
      ok: false, quantity: null, price: null, applied: false,
      source: i.spec!.source, venue, changed: false, code: 'INVALID_QUANTITY',
      reason: '수량이 올바르지 않습니다',
    };
  }

  // ── ★ 절충: 못 읽었으면 보내되 "안 맞췄다"고 적는다 ──
  //
  // 여기서 막으면 `exchangeInfo` 일시 장애에 주문이 전부 멈춘다. 지금
  // 성공하던 주문을 새로 막는 것은 다른 종류의 사고다. 대신 맞춘 척을
  // 하지 않는다 — `applied: false`가 그 사실을 들고 다닌다.
  if (!specUsable(i.spec)) {
    return {
      ok: true, quantity: q0, price: i.price ?? null, applied: false,
      source: 'UNKNOWN', venue, changed: false, code: null,
      reason: '거래소 규격을 읽지 못해 수량을 맞추지 않고 보냅니다 — 거래소가 거부할 수 있습니다',
    };
  }

  const spec = i.spec as VenueSpec;

  const r = quantizeOrder(q0, i.price ?? null, filtersOf(spec), {
    orderType: i.orderType ?? null,
    reduceOnly: i.reduceOnly ?? null,
    marketReferencePrice: i.referencePrice ?? null,
  });

  // venue가 최대 수량을 고시하면 그것도 본다. `quantizeOrder`에는 없는 축이다.
  if (r.ok && spec.maxQty != null && Number(r.quantity) > spec.maxQty) {
    return {
      ok: false, quantity: null, price: r.price, applied: true,
      source: spec.source, venue, changed: true, code: 'ABOVE_MAX_QTY',
      reason: `1회 최대 주문 수량(${spec.maxQty})을 넘습니다`,
    };
  }

  // 내려서 0이 되는 경우는 여기서 다시 보지 않는다.
  //
  //   `quantizeOrder`가 이미 `INVALID_STEP`으로 막는다(quantize.ts:248 —
  //   `if (!isPos(q))`). 한 겹 더 두었다가 뮤테이션으로 **도달 불가**임이
  //   드러났다: 가드를 `if (false)`로 바꿔도 게이트가 초록이었다.
  //   지키는 뮤테이션이 없는 방어는 방어가 아니라 죽은 코드다.

  return {
    ok: r.ok, quantity: r.quantity, price: r.price, applied: r.applied,
    source: spec.source, venue, changed: r.changed,
    code: r.code as NormalizeCode | null, reason: r.reason,
  };
}

// ══════════════ 모의 장부는 어느 venue를 모사하는가 ══════════════

/**
 * **모의는 venue-neutral이 아니다.**
 *
 * `engine/paperPriceSource.ts`가 머리말에 이미 선언해 두었다:
 *
 *   SPOT → Binance 현물 ticker
 *   USDM → Binance 선물 markPrice
 *
 * 가격 권위가 바이낸스인 장부에 바이낸스 격자를 쓰는 것은 **임의 선택이
 * 아니라 기존 권위와의 일치**다. 여기서 다른 거래소 격자를 쓰면 같은
 * 장부가 가격은 바이낸스, 수량은 다른 곳 규칙으로 돌아간다.
 *
 * **모르는 시장은 null이다.** 기본값으로 현물을 쓰면 선물 주문이 현물
 * 격자로 맞춰진다.
 */
export function venueForPaperMarket(market: any): VenueId | null {
  if (market === 'SPOT') return 'BINANCE_SPOT';
  if (market === 'USDM') return 'BINANCE_USDM';
  return null;
}

export const VENUE_LABEL: Record<VenueId, string> = {
  BINANCE_SPOT: '바이낸스 현물',
  BINANCE_USDM: '바이낸스 USDT 무기한',
  BINANCE_COINM: '바이낸스 코인 마진',
  GATE_USDM: 'Gate 무기한',
  KIS_KR: '한국투자증권 국내',
  KIS_US: '한국투자증권 해외',
};

export const SPEC_SOURCE_LABEL: Record<SpecSource, string> = {
  EXCHANGE: '거래소 조회',
  KNOWN: '고시 규칙',
  CACHED: '최근 조회값',
  UNKNOWN: '확인 불가',
};
