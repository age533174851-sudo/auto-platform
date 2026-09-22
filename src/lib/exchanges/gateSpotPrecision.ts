// src/lib/exchanges/gateSpotPrecision.ts
//
// **Gate 현물의 네 축을 각각 다른 것으로 다룬다.**
//
// Gate가 종목마다 주는 규격은 네 개이고, 넷 다 의미가 다르다:
//
//   amount_precision    수량의 **소수 자릿수**
//   precision           지정가 **가격의 소수 자릿수**
//   min_base_amount     최소 주문 **수량**(base)
//   min_quote_amount    최소 주문 **금액**(quote)
//
// 이걸 하나의 `stepSize` / `minNotional` 개념으로 뭉치면 안 된다. 바이낸스는
// 수량 격자를 `stepSize`(증분)로 주고 Gate는 **자릿수**로 준다 — 같은 뜻이
// 아니라 **변환 관계**다(`stepSize = 10^-precision`). 그리고 10의 거듭제곱이
// 아닌 증분은 자릿수로 표현할 수 없다. 두 표현을 섞는 순간 한쪽 종목에서
// 조용히 틀린 수량이 나간다.
//
// 그래서 이 파일이 하는 일은 둘뿐이다:
//   ① Gate가 준 값이 **가격 자릿수**인지 한 곳에서 확정한다
//   ② 그 자릿수로 가격을 맞춘다
//
// 이 둘이 여기 한 곳에만 있어야 한다. 같은 계산이 두 벌이 되면 언젠가
// 한쪽만 고쳐진다.
//
// ★ `quantizeOrder`·`roundToTick`을 쓰지 않는 이유 — 단위가 정확히 안 맞는다
// ──────────────────────────────────────────────────────────────────────
// 처음에는 자릿수를 증분으로 바꿔(`10^-p`) 기존 `roundToTick`에 넘기려 했다.
// **그 변환이 정확하지 않다:**
//
//     Math.pow(10, -4) === 0.00009999999999999999   // 0.0001이 아니다
//
// `roundToTick`은 증분의 문자열에서 자릿수를 세므로(`decimalsOf`), 저 값을
// 받으면 **소수 20자리**로 읽고 `toFixed(20)`을 한다. 맞추려다 더 틀린다.
//
// Gate의 규격은 처음부터 **자릿수**다. 자릿수를 증분으로 바꿨다가 다시
// 자릿수로 되돌리는 왕복 자체가 불필요하고, 그 왕복에서 오차가 생긴다.
// 그래서 자릿수로 **직접** 반올림한다 — 억지로 끼우지 않는다.
//
// `quantizeOrder` 전체를 쓰지 않는 이유는 또 따로 있다: 그것은 수량·가격·
// 최소명목가를 한 번에 판정하므로, 어댑터가 이미 하고 있는 수량 내림
// (`gateSpotPlan`의 `floorTo(amount_precision)`)이 **두 번** 걸린다.

/**
 * Gate가 그 축을 적용하지 못한 이유.
 *
 * **바이낸스 쪽(`spotPrecisionState.ts`)과 일부러 따로 둔다.** 그쪽은
 * "base 수량 격자를 왜 못 맞췄는가"를 답하고, 여기는 "이 축의 자릿수를 왜
 * 못 맞췄는가"를 답한다. 두 거래소는 규격의 **모양 자체**가 다르므로,
 * 하나의 낱말 집합으로 묶으면 한쪽 의미가 늘어난다.
 */
export type GatePrecisionSkip =
  /** 이 주문에 그 값이 아예 없다 (시장가의 가격, 금액 주문의 수량) */
  | 'NOT_IN_ORDER'
  /** 종목 규격을 못 읽었다. **0이나 기본값이 아니다** */
  | 'METADATA_UNKNOWN';

/**
 * Gate 현물 주문 하나에 대해 **축마다** 무엇을 했는가.
 *
 * 수량과 가격을 한 칸으로 합치지 않는다 — Gate에서 그 둘은 서로 다른
 * 필드(`amount_precision` / `precision`)에서 오고, 한쪽만 읽히는 경우가
 * 실제로 있다.
 */
export interface GateSpotPrecision {
  venue: 'GATE_SPOT';
  /** 수량 자릿수를 적용했는가 (`amount_precision`) */
  quantityApplied: boolean;
  quantitySkipped: GatePrecisionSkip | null;
  /** 지정가 가격 자릿수를 적용했는가 (`precision`) */
  priceApplied: boolean;
  priceSkipped: GatePrecisionSkip | null;
  requestedQuantity: number | null;
  quantity: number | null;
  requestedPrice: number | null;
  price: number | null;
}

/**
 * Gate가 준 값을 **가격 자릿수**로 확정한다. 이 해석은 여기 한 곳에만 있다.
 *
 * 못 알아보면 `null`이다. 0이 아니다 — **`Number(null)`은 0이고, 0은
 * "정수 단위"라는 뜻이 있는 값이다.** 그래서 숫자로 바꾸기 **전에**
 * 비어 있는지를 먼저 본다. 이 한 줄이 빠져서 규격을 못 읽은 종목의
 * 지정가가 전부 정수로 반올림될 뻔했다.
 *
 * 자릿수 0은 "정수 호가"라는 실제 규격이므로 통과시킨다.
 */
export function gatePriceDecimals(precision: unknown): number | null {
  if (precision == null || precision === '') return null;
  const p = Number(precision);
  if (!Number.isFinite(p) || p < 0 || !Number.isInteger(p)) return null;
  // `toFixed`가 받는 범위 밖이면 만들어내지 않는다.
  if (p > 100) return null;
  return p;
}

export interface GatePriceResult {
  /** 실제로 보낼 가격. 규격을 못 읽었으면 원값 그대로 */
  price: number | null;
  /** 자릿수를 실제로 적용했는가 */
  applied: boolean;
  /** 못 했다면 왜 */
  skipped: GatePrecisionSkip | null;
  /** 값이 바뀌었는가 */
  changed: boolean;
}

/**
 * 지정가를 Gate의 가격 자릿수에 맞춘다.
 *
 * **반올림한다(내림이 아니다).** 지정가는 내려도 올려도 되고 가까운 쪽이
 * 낫다 — `quantize.ts`가 바이낸스에 대해 이미 내린 판단이고, 같은 성질의
 * 값에 다른 정책을 쓸 이유가 없다. 수량은 반대로 언제나 내림인데, 올리면
 * 보유량을 넘기기 때문이다. **두 축의 정책이 다르다는 것 자체가 이 둘을
 * 뭉치면 안 되는 이유다.**
 */
export function roundGatePrice(
  price: number | null | undefined,
  precision: number | null | undefined,
): GatePriceResult {
  const p0 = Number(price);
  if (!Number.isFinite(p0) || p0 <= 0) {
    return { price: null, applied: false, skipped: 'NOT_IN_ORDER', changed: false };
  }
  const d = gatePriceDecimals(precision);
  if (d == null) {
    // **맞춘 척을 하지 않는다.** 원값을 그대로 돌려주되 적용했다고 적지 않는다.
    return { price: p0, applied: false, skipped: 'METADATA_UNKNOWN', changed: false };
  }
  // 자릿수로 직접 반올림한다. 증분으로 바꿨다가 되돌리는 왕복이 없다.
  //
  // 정확히 반 칸(`1.005` 같은 값)에서는 그 수가 이진수로 조금 작게 저장돼
  // 내려간다. 지정가에서 반 칸 아래는 매수엔 유리하고 매도엔 불리하지만
  // 어느 쪽이든 한 칸 차이이고, **어떤 선택을 해도 같은 크기의 임의성**이
  // 남는다. 여기서 우리가 정하지 않고 언어의 판정을 그대로 쓴다.
  const p = Number(p0.toFixed(d));
  if (!Number.isFinite(p) || p <= 0) {
    // 자릿수에 맞추니 0이 됐다. 그런 지정가는 보낼 수 없다.
    return { price: null, applied: true, skipped: null, changed: true };
  }
  return { price: p, applied: true, skipped: null, changed: p !== p0 };
}
