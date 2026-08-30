// src/lib/markets/orderTypes.ts
//
// **주문유형의 정본. 화면이 고른 것과 거래소가 받는 것이 같아야 한다.**
//
// 무엇이 있었나
// ─────────────
// 화면은 `시장가 / 지정가 / 조건부` 셋을 고르게 했고, 지정가·조건부에는
// 가격 입력칸까지 띄웠다. 그런데 실제 요청 본문은:
//
//   type: 'MARKET'
//
// 로 박혀 있었고 입력한 가격은 **한 번도 읽히지 않았다.** 지정가를 눌러도,
// 트리거가를 적어도, 나가는 것은 지금 값으로 즉시 체결되는 시장가였다.
// 사용자는 "이 가격까지 내려오면 사겠다"고 눌렀는데 지금 들어간다.
//
// 조건부는 더 심하다. 서버·워커·어댑터 어디에도 진입 트리거가 없다.
// 화면에만 존재하는 선택지였다.
//
// 무엇을 하나
// ───────────
// **지원하지 않는 것을 지원하는 척하지 않는다.** 서버 `validateOrder`가
// 받는 집합이 정본이고, 화면은 그 부분집합만 고르게 한다. 뒤에서 조용히
// 다른 유형으로 바꾸지 않는다 — 바꾸는 순간 화면이 거짓말이 된다.
//
// 그리고 **수량의 기준가는 주문유형이 정한다:**
//
//   MARKET  거래소 선물가로 나눈다  — 지금 값에 체결되므로
//   LIMIT   지정가로 나눈다        — 그 값에 체결되므로
//
// 이게 어긋나면 명목가가 어긋난다. 100 USDT · 마크가 2,500 · 지정가 2,000
// 에서 마크가로 수량을 만들면 0.04가 되고, 실제 체결 명목은
// `0.04 × 2,000 = 80 USDT`다 — 사용자가 적은 100이 아니다.
//
// 이 파일은 아무것도 import하지 않는다. 서버 검증기와 화면이 **같은 목록**을
// 보게 하려면 목록이 양쪽 아래에 있어야 한다.

/**
 * 서버 `validateOrder`가 받는 주문유형. **이것이 정본이다.**
 *
 * 화면의 선택지는 이 집합의 부분집합이어야 한다.
 */
export const SERVER_ORDER_TYPES = ['MARKET', 'LIMIT'] as const;

export type ServerOrderType = typeof SERVER_ORDER_TYPES[number];

export function isServerOrderType(v: unknown): v is ServerOrderType {
  return typeof v === 'string' && (SERVER_ORDER_TYPES as readonly string[]).includes(v);
}

/** 수량을 무엇으로 나눴는가 — 화면이 그대로 적는다 */
export type SizingBasis = 'VENUE_MARK' | 'LIMIT_PRICE';

export type SizingBlockCode =
  /** 시장가인데 거래소 가격을 못 읽었다 */
  | 'NATIVE_PRICE_UNKNOWN'
  /** 지정가인데 가격이 없다 */
  | 'LIMIT_PRICE_REQUIRED'
  /** 서버가 받지 않는 유형이다 */
  | 'UNSUPPORTED_ORDER_TYPE';

export type SizingPrice =
  | { kind: 'READY'; price: number; basis: SizingBasis }
  | { kind: 'BLOCKED'; code: SizingBlockCode; reason: string };

const pos = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 이 주문의 수량을 **어느 가격으로** 나눌 것인가.
 *
 * 한 곳에서만 정한다. 미리보기·확인창·실행이 각자 정하면 언젠가 갈리고,
 * 갈린 자리에서 명목가가 어긋난다.
 *
 * **못 정하면 값을 만들지 않는다.** 시장가로 되돌리지 않는다 — 되돌리는
 * 것이 지금 고치는 바로 그 고장이다.
 */
export function sizingPriceOf(i: {
  orderType: string | null | undefined;
  /** 거래소 선물가 (USDT). 못 읽었으면 null */
  venuePrice: number | null | undefined;
  /** 사용자가 적은 지정가 (USDT) */
  limitPrice: number | string | null | undefined;
}): SizingPrice {
  const t = String(i?.orderType ?? '').toUpperCase();
  if (!isServerOrderType(t)) {
    return {
      kind: 'BLOCKED', code: 'UNSUPPORTED_ORDER_TYPE',
      reason: `지원하지 않는 주문 유형입니다: ${String(i?.orderType ?? '')}`
        + ' — 시장가로 바꿔 보내지 않습니다',
    };
  }
  if (t === 'LIMIT') {
    const lp = pos(i?.limitPrice);
    if (lp == null) {
      return {
        kind: 'BLOCKED', code: 'LIMIT_PRICE_REQUIRED',
        reason: '지정가 주문에는 0보다 큰 가격이 필요합니다 — 시장가로 바꿔 보내지 않습니다',
      };
    }
    // **지정가는 거래소 시세를 몰라도 계산된다.** 체결될 가격을 사용자가
    // 이미 정했기 때문이다. 여기서 마크가를 요구하면 시세 조회가 안 될 때
    // 낼 수 있는 주문까지 막힌다.
    return { kind: 'READY', price: lp, basis: 'LIMIT_PRICE' };
  }
  const vp = pos(i?.venuePrice);
  if (vp == null) {
    return {
      kind: 'BLOCKED', code: 'NATIVE_PRICE_UNKNOWN',
      reason: '거래소 가격을 확인하지 못해 주문할 수 없습니다 — 환율로 대신 계산하지 않습니다',
    };
  }
  return { kind: 'READY', price: vp, basis: 'VENUE_MARK' };
}
