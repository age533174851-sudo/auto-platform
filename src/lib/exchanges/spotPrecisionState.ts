// src/lib/exchanges/spotPrecisionState.ts
//
// **격자를 적용하지 않았다면, 왜 안 했는가 — 네 가지를 구별한다.**
//
// 왜 이 파일이 생겼나
// ───────────────────
// 4B-2A는 `skipped: applied ? null : 'SPEC_UNKNOWN'` 한 줄이었다. 그런데
// `applied: false`가 되는 길은 하나가 아니다:
//
//   · 규격 조회가 **실패**했다            → source 'UNKNOWN'
//   · 규격은 **읽었는데** 이 주문유형의
//     수량 격자만 없다                     → source 'EXCHANGE'
//
// 둘을 `SPEC_UNKNOWN` 하나로 적으면 **`source: 'EXCHANGE'`인데 사유는
// "규격 미상"**이라는 모순된 응답이 나간다. 못 읽은 것과 해당 없는 것을
// 구별하려고 만든 필드가 정작 세 번째 경우를 앞의 것으로 뭉갠 셈이다.
//
// 그래서 판정을 순수 함수 하나로 꺼내고, 값마다 시험을 붙인다.
// 실행부(`spotOrderExecutor`)는 이 함수를 부르기만 한다 — 같은 판정이
// 두 곳에 있으면 언젠가 갈린다.
//
// ★ 이 파일은 `@/` 별칭을 쓰지 않는다
// ───────────────────────────────────
// 시험 러너는 별칭 없이 tsc로 컴파일한다. 별칭이 섞이면 시험에서
// 이 판정을 직접 부를 수 없고, 그러면 값이 아니라 문자열만 검사하게 된다.
import type { SpecSource, NormalizeCode } from '../markets/venueSpec';

/**
 * 수량 격자를 적용하지 않은 이유.
 *
 * **`null`은 "적용했다"는 뜻이다.** 값이 있으면 그 주문은 격자 위에
 * 있다고 말할 수 없다.
 */
export type PrecisionSkip =
  /**
   * 맞출 **수량 자체가 없다.**
   *
   * 금액 기반 시장가 매수(`quoteOrderQty`)는 결제통화 금액으로 나간다.
   * 수량은 거래소가 체결하며 정한다 — 결손이 아니라 **해당 없음**이다.
   */
  | 'QUOTE_ORDER'
  /**
   * 규격을 **못 읽었다.** 맞춰야 하는데 못 맞췄다.
   *
   * 절충 정책에 따라 주문은 나가지만, 거래소가 거부할 수 있다.
   * 반드시 `source === 'UNKNOWN'`과 함께 나온다.
   */
  | 'SPEC_UNKNOWN'
  /**
   * 규격은 읽었는데 **이 주문유형의** 수량 격자가 없다.
   *
   * `exchangeInfo`가 200을 주고 `LOT_SIZE`도 있는데 `MARKET_LOT_SIZE`만
   * 없는 경우다. 신규 진입이면 `quantizeOrder`가 막으므로 여기까지 오지
   * 않고, **청산(현물 매도)일 때만** 이 상태로 나간다.
   *
   * `source`는 `'UNKNOWN'`이 아니다 — 그게 `SPEC_UNKNOWN`과의 차이다.
   */
  | 'ORDER_TYPE_GRID_UNKNOWN'
  /**
   * 수량이나 venue가 올바르지 않아 격자를 적용할 단계에 **가지도 못했다.**
   *
   * 이걸 `SPEC_UNKNOWN`으로 적으면 규격 조회 장애로 오인된다. 규격은
   * 멀쩡한데 입력이 틀린 것이다.
   */
  | 'INVALID_INPUT';

export interface PrecisionSkipInput {
  /** 금액 기반 시장가 매수인가 */
  byQuote: boolean;
  /** `normalizeForVenue`가 격자를 실제로 적용했는가 */
  applied: boolean;
  /** 어느 격자였는가. 금액 주문이면 규격을 읽지 않으므로 null */
  source: SpecSource | null;
  /** 막혔다면 그 사유 코드 */
  code: NormalizeCode | null;
}

/**
 * 격자를 적용하지 않은 이유를 하나로 판정한다.
 *
 * 순서가 의미를 만든다:
 *
 *   ① 금액 주문이면 다른 것을 볼 필요가 없다 — 맞출 수량이 없다
 *   ② 적용했으면 이유가 없다
 *   ③ **입력이 틀린 것을 규격 장애로 적지 않는다** (code를 source보다 먼저 본다)
 *   ④ 출처가 'UNKNOWN'이면 못 읽은 것이고, 아니면 읽었는데 이 유형의
 *      격자만 없는 것이다
 */
export function precisionSkipOf(i: PrecisionSkipInput): PrecisionSkip | null {
  if (i?.byQuote) return 'QUOTE_ORDER';
  if (i?.applied) return null;
  if (i?.code === 'INVALID_QUANTITY' || i?.code === 'VENUE_UNKNOWN') return 'INVALID_INPUT';
  if (i?.source === 'UNKNOWN' || i?.source == null) return 'SPEC_UNKNOWN';
  return 'ORDER_TYPE_GRID_UNKNOWN';
}

/** 사용자에게 그대로 보여 줄 한 줄. 적용했으면 빈 문자열 */
export const PRECISION_SKIP_TEXT: Record<PrecisionSkip, string> = {
  QUOTE_ORDER:
    '금액으로 내는 시장가 매수라 수량 격자를 적용하지 않았습니다 — '
    + '최소 주문 금액은 거래소가 판단합니다',
  SPEC_UNKNOWN:
    '거래소 규격을 읽지 못해 수량을 맞추지 않았습니다 — 거래소가 거부할 수 있습니다',
  ORDER_TYPE_GRID_UNKNOWN:
    '이 주문 유형의 수량 규격을 거래소가 고시하지 않아 수량을 맞추지 않았습니다',
  INVALID_INPUT:
    '주문 값이 올바르지 않아 거래소 규격을 적용하지 못했습니다',
};

/**
 * 값들이 서로 모순되지 않는가.
 *
 * 시험이 이 함수를 쓴다. 제품 코드가 부르지는 않지만, **무엇이 모순인지를
 * 코드로 적어 두는 것** 자체가 이 파일의 목적이다 — 글로만 적어 두면
 * 다음 사람이 `skipped`만 바꾸고 `source`는 그대로 둔다.
 */
export function precisionStateConsistent(i: PrecisionSkipInput & {
  skipped: PrecisionSkip | null;
}): { ok: boolean; reason: string } {
  const no = (reason: string) => ({ ok: false, reason });

  if (i.skipped == null && !i.applied) {
    return no('격자를 적용하지 않았는데 사유가 없습니다');
  }
  if (i.skipped != null && i.applied) {
    return no('격자를 적용했는데 건너뛴 사유가 적혀 있습니다');
  }
  if (i.skipped === 'QUOTE_ORDER' && !i.byQuote) {
    return no('금액 주문이 아닌데 금액 주문 사유가 적혀 있습니다');
  }
  if (i.skipped === 'SPEC_UNKNOWN' && i.source != null && i.source !== 'UNKNOWN') {
    return no(`규격을 못 읽었다는데 출처가 '${i.source}'입니다`);
  }
  if (i.skipped === 'ORDER_TYPE_GRID_UNKNOWN' && (i.source == null || i.source === 'UNKNOWN')) {
    return no('규격은 읽었다는데 출처가 없습니다');
  }
  return { ok: true, reason: '' };
}
