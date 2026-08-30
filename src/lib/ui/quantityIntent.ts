// src/lib/ui/quantityIntent.ts
//
// **사용자가 낸 의도를 서버까지 가져간다.**
//
// 무엇이 있었나
// ─────────────
// Terminal의 비율·위험 버튼은 수량을 계산한 뒤 `toFixed(6)`(개수) 또는
// `toFixed(2)`(USDT)로 **입력칸 문자열**을 만들었다. 그리고 주문을 낼 때
// 그 문자열을 다시 읽어 거래소로 보냈다. 표시용으로 깎은 숫자가 그대로
// 실행 수량이 된 것이다.
//
// 그래서 이런 일이 가능했다 (조사에서 확인된 실제 수치):
//
//   px 0.0000345 · stepSize 1 · 실제 포지션 1,000,145
//   100% 버튼 → (1000145 × 0.0000345).toFixed(2) = 34.51 USDT
//   주문 시   → 34.51 / 0.0000345 = 1,000,289.855
//   서버 내림 → 1,000,289          **보유보다 +144 많다**
//
// 서버의 `quantizeOrder`는 stepSize로 내림하지만, 반올림 오차가 stepSize
// 보다 크면 되돌리지 못한다. 여기에 세 가지가 더 겹친다:
//
//   · USDT 단위는 버튼을 누른 시각의 가격으로 곱하고 주문 시각의 가격으로
//     나눈다. 가격이 내리면 되돌아온 개수가 원래보다 커진다
//   · 버튼을 누른 뒤 포지션이 줄면(부분 체결·TP) 100%가 초과가 된다
//   · 거래소 규격을 못 읽으면 `quantizeOrder`가 그대로 통과시킨다
//
// 자리수를 늘려도(6 → 8) USDT 되돌림·시점차·포지션 축소는 그대로다.
// **정밀도를 올리는 문제가 아니라 의도를 잃는 문제다.**
//
// 무엇을 하나
// ───────────
// 버튼이 만든 것은 숫자가 아니라 **의도**다:
//
//   "지금 실제 포지션의 100%를 닫아라"        ← 청산 비율
//   "이 개수를 열어라"                        ← 신규 비율·위험
//
// 청산 비율은 개수를 만들지 않고 `percent`를 그대로 보낸다. 서버
// (`/api/binance/futures/close-position`)가 주문 순간의 실제 포지션을 다시
// 읽어 계산한다 — 그 라우트는 애초에 `quantity`를 받지 않는다.
//
// 신규·위험은 **반올림 없는 계산값**을 들고 간다. 입력칸에 적히는 문자열은
// 사람이 읽는 용도이고, 실행에는 쓰이지 않는다.
//
// 사용자가 칸을 고치면 의도는 끝난다
// ──────────────────────────────────
// 100%를 누른 뒤 수량을 직접 고쳤는데 화면에만 100%가 남아 있고 주문은
// 전량으로 나가면, 그건 사용자가 요청하지 않은 거래다. 그래서 **입력칸이
// 우리가 적은 문자열 그대로일 때만** 의도가 살아 있다.

/** 무엇이 이 수량을 만들었나 */
export type IntentSource =
  /** 청산 비율 버튼 — 개수가 아니라 비율이 의도다 */
  | 'PERCENT_CLOSE'
  /** 신규 비율 버튼 */
  | 'PERCENT_ENTRY'
  /** 위험 기준 버튼 */
  | 'RISK';

export interface QuantityIntent {
  source: IntentSource;
  /**
   * 반올림 없는 계산 결과(코인 개수).
   *
   * `PERCENT_CLOSE`는 서버가 다시 계산하므로 참고값이다 — 실행에 쓰지 않는다.
   */
  rawBaseQty: number | null;
  /** 청산 비율(1~100). `PERCENT_CLOSE`에만 있다 */
  percent?: number;
  /** 우리가 입력칸에 적은 문자열. 사용자가 고쳤는지 이걸로 안다 */
  displayValue: string;
}

/**
 * 의도가 아직 살아 있는가.
 *
 * 입력칸이 우리가 적은 그대로여야 한다. **한 글자라도 다르면 사용자가
 * 고친 것이고, 그때는 사용자가 적은 값이 정답이다.**
 */
export function intentStillValid(
  intent: QuantityIntent | null | undefined, currentInput: string,
): boolean {
  if (!intent) return false;
  return String(currentInput) === String(intent.displayValue);
}

/** 이 의도를 비율 청산으로 보낼 수 있는가 */
export function closePercentOf(
  intent: QuantityIntent | null | undefined, currentInput: string,
): number | null {
  if (!intentStillValid(intent, currentInput)) return null;
  if (intent!.source !== 'PERCENT_CLOSE') return null;
  const p = Number(intent!.percent);
  // **말이 안 되는 비율로 실제 주문을 내지 않는다.** 서버도 다시 거르지만
  // 여기서 통과시키면 화면이 무엇을 보냈는지 설명할 수 없다.
  if (!Number.isFinite(p) || p <= 0 || p > 100) return null;
  return p;
}

/**
 * 비율 청산을 지금 보낼 수 있는가.
 *
 * **주문유형의 의도도 수량만큼 중요하다.** 비율 청산 경로(서버
 * `close-position`)는 언제나 시장가 reduce-only로 나간다. 사용자가
 * 지정가를 골라 놓았는데 버튼 하나로 시장가가 되면, 수량을 지키려다
 * **다른 축의 의도를 깨는** 것이다.
 *
 * 자동으로 시장가로 바꾸지 않는다 — 그것도 같은 종류의 암묵적 변경이다.
 * 막고, 왜 막았는지 말한다.
 */
export type ClosePlan =
  /** 비율 청산으로 보낸다 */
  | { kind: 'PERCENT_CLOSE'; percent: number }
  /** 비율 청산이 아니다 — 기존 수량 경로로 간다 */
  | { kind: 'NOT_PERCENT_CLOSE' }
  /** 보내면 안 된다. 네트워크 요청 전에 멈춘다 */
  | { kind: 'BLOCKED'; reason: string };

export function closePlanOf(i: {
  intent: QuantityIntent | null | undefined;
  currentInput: string;
  reduceOnly: boolean;
  /** 모의 계좌에는 이 경로가 없다 */
  isPaper: boolean;
  orderType: 'MARKET' | 'LIMIT';
}): ClosePlan {
  if (!i.reduceOnly || i.isPaper) return { kind: 'NOT_PERCENT_CLOSE' };
  const percent = closePercentOf(i.intent, i.currentInput);
  if (percent == null) return { kind: 'NOT_PERCENT_CLOSE' };
  // 지정가를 고른 사용자의 주문을 시장가로 바꾸지 않는다.
  if (i.orderType !== 'MARKET') {
    return {
      kind: 'BLOCKED',
      reason: '비율 청산은 현재 시장가에서만 지원합니다. '
        + '시장가로 바꾸거나, 지정가 청산은 수량을 직접 입력하세요',
    };
  }
  return { kind: 'PERCENT_CLOSE', percent };
}

export interface ExecutionQuantity {
  /** 거래소로 나갈 개수 */
  qty: number | null;
  /** 어디서 왔나 — 화면이 그대로 적을 수 있다 */
  from: 'INTENT' | 'MANUAL';
}

/**
 * 실제로 보낼 개수.
 *
 * 의도가 살아 있으면 **반올림 없는 계산값**을, 사용자가 고쳤으면 사용자가
 * 적은 값을 쓴다. 표시용 문자열을 다시 파싱하는 경로는 여기 없다.
 */
export function executionQuantityOf(
  intent: QuantityIntent | null | undefined,
  currentInput: string,
  manualBaseQty: number | null | undefined,
): ExecutionQuantity {
  if (intentStillValid(intent, currentInput)) {
    const raw = Number(intent!.rawBaseQty);
    if (Number.isFinite(raw) && raw > 0) return { qty: raw, from: 'INTENT' };
  }
  const m = Number(manualBaseQty);
  return { qty: Number.isFinite(m) && m > 0 ? m : null, from: 'MANUAL' };
}

/**
 * 의도를 만들면서 입력칸에 적을 문자열도 같이 만든다.
 *
 * **표시는 깎아도 되고 실행은 깎지 않는다.** 둘을 같은 함수에서 만들어야
 * `displayValue`와 실제로 칸에 적히는 값이 갈리지 않는다.
 */
export function makeIntent(i: {
  source: IntentSource;
  rawBaseQty: number | null;
  percent?: number;
  /** 칸에 보일 값. 개수 칸이면 rawBaseQty, USDT 칸이면 환산값 */
  displayNumber: number;
  /** 표시 자리수 — 실행에는 영향이 없다 */
  displayDecimals: number;
}): { intent: QuantityIntent; display: string } {
  const shown = Number.isFinite(i.displayNumber) && i.displayNumber > 0
    ? String(Number(i.displayNumber.toFixed(i.displayDecimals)))
    : '';
  return {
    intent: {
      source: i.source,
      rawBaseQty: i.rawBaseQty,
      ...(i.percent != null ? { percent: i.percent } : {}),
      displayValue: shown,
    },
    display: shown,
  };
}
