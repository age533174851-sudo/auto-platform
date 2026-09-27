// src/lib/trading/ctaVerdict.ts
//
// **실행 버튼이 꺼졌는가 — 한 번만 판정하고 세 곳이 그것을 본다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// USDⓈ-M의 `Cta`가 꺼짐을 **세 번 따로** 계산했다:
//
//     const off = disabled || !!unavailable || locked;   // 색
//     <button disabled={!!unavailable || locked}>        // DOM   ← disabled 빠짐
//     onClick={() => { if (unavailable || locked) return; ... }}  // 클릭 ← 빠짐
//
// 그래서 호출부가 넘긴 `disabled`(= `!gate.ready || busy || intent !== 'OPEN'`)가
// **색에만** 반영됐다. 회색으로 보이는 버튼이 실제로는 눌렸다.
//
// `form.submit()`이 `gate`와 `busy`는 다시 막지만 **`intent`는 모른다.**
// `intent`는 화면의 상태이지 폼의 상태가 아니다. 그래서 청산 탭을 열어 둔
// 채로 진입 주문이 나갈 수 있었다 — 이전에 방향을 골라 둔 상태라면
// 한 번의 클릭으로 `submit()`까지 간다.
//
// 그래서 판정을 값으로 만든다
// ───────────────────────────
// 꺼짐과 "눌렀을 때 할 일"을 함께 돌려준다. 화면은 이 값을 **그대로** 쓰고
// 다시 계산하지 않는다. 계산이 세 곳에 있으면 언젠가 한 곳만 고쳐진다 —
// 이 저장소가 이름 붙인 2번 고장이고, 실제로 그렇게 났다.

/** 눌렀을 때 실제로 하는 일 */
export type CtaAction =
  /** 아무것도 하지 않는다 */
  | 'NONE'
  /** 방향만 고른다. **주문은 나가지 않는다** */
  | 'CHOOSE_SIDE'
  /**
   * 주문 확인 시트를 연다. **여기서 주문이 나가지 않는다.**
   *
   * ★ 예전 이름은 `'SUBMIT'`이었고 실제로 `form.submit()`을 불렀다.
   *   확인 시트가 생긴 뒤에도 이름을 그대로 두면 "SUBMIT인데 보내지 않는"
   *   상태가 되고, 다음 사람이 이름을 믿고 배선을 고친다. 이름과 행동을
   *   갈라 두지 않는다 — 보내는 것은 `confirmVerdict`의 `'SUBMIT'` 하나다.
   */
  | 'OPEN_REVIEW';

export interface CtaVerdictInput {
  /** 정본 판정이 보낼 준비가 됐다고 하는가 */
  gateReady: boolean;
  /** 이미 보내는 중인가 */
  busy: boolean;
  /** 지금 화면이 **진입**인가. 청산 탭에서는 진입 버튼이 꺼져야 한다 */
  intentOpen: boolean;
  /** 거래할 종목이 없다 */
  locked: boolean;
  /** 이 시장에 이 방향이 없다 (현물의 숏 같은 것) */
  unavailable: boolean;
  /** 사용자가 방향을 **실제로 눌렀는가** */
  sideChosen: boolean;
  /** 지금 고른 방향이 이 버튼의 방향인가 */
  sameSide: boolean;
}

export interface CtaVerdict {
  /** 꺼져 있는가. **색 · DOM · 클릭이 전부 이 값 하나를 본다** */
  off: boolean;
  /** 이 버튼이 지금 고른 방향인가 (글자를 바꾸는 데 쓴다) */
  on: boolean;
  action: CtaAction;
  /** 왜 꺼졌는가. 켜져 있으면 null */
  reason: string | null;
}

/**
 * ★ 꺼짐 판정 한 곳.
 *
 * 순서가 뜻을 갖는다 — 먼저 걸린 사유가 사용자에게 보여야 하는 사유다.
 * "종목이 없다"가 "준비가 안 됐다"보다 먼저다. 뒤엣것은 앞엣것의 결과이기
 * 때문이다.
 */
export function ctaVerdict(i: CtaVerdictInput): CtaVerdict {
  const on = !!i.sideChosen && !!i.sameSide;

  const offReason =
    i.unavailable ? '이 시장에는 이 방향이 없습니다'
    : i.locked ? '거래할 종목이 없습니다'
    : !i.intentOpen ? '청산 화면입니다 — 진입 주문은 여기서 보내지 않습니다'
    : i.busy ? '주문을 보내는 중입니다'
    : !i.gateReady ? '아직 주문을 보낼 수 없습니다'
    : null;

  if (offReason) return { off: true, on, action: 'NONE', reason: offReason };

  // 켜져 있다. 아직 방향을 안 골랐으면 **고르기만** 한다 —
  // 한 번의 클릭으로 주문이 나가지 않는다. 골랐으면 **확인 시트를 연다** —
  // 두 번의 클릭으로도 나가지 않는다. 보내는 것은 시트의 확인 버튼이다.
  return { off: false, on, action: on ? 'OPEN_REVIEW' : 'CHOOSE_SIDE', reason: null };
}
