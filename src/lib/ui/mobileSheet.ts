// src/lib/ui/mobileSheet.ts
//
// **모바일에서 시트가 깨지는 두 자리.**
//
// 1. 뒤로가기
// ───────────
// 안드로이드에서 바텀시트를 열어 두고 뒤로가기를 누르면 시트가 닫히는
// 것이 아니라 **화면을 통째로 벗어난다.** 주문 시트에서 수량까지 다
// 적어 놓고 습관적으로 뒤로가기를 누르면 거래 화면에서 나가 버리고,
// 돌아오면 적어 둔 것이 없다.
//
// 고치는 방법은 하나뿐이다: 시트를 열 때 히스토리에 한 칸을 넣고,
// 뒤로가기(popstate)를 그 칸을 소비하는 것으로 받는다.
//
// 그런데 여기 **함정이 있다.** X 버튼으로 닫을 때 넣어 둔 칸을 안 빼면
// 히스토리에 쓰레기가 쌓인다. 시트를 다섯 번 열고 닫은 뒤 뒤로가기를
// 누르면 다섯 번을 눌러야 화면을 벗어난다 — 사용자에게는 앱이 멈춘
// 것으로 보인다. 반대로 popstate로 닫힌 것까지 history.back()을 부르면
// **뒤로가기 한 번에 두 칸이 물러난다.**
//
// 그래서 셋을 구분해야 한다: 열림 / X로 닫힘 / 뒤로가기로 닫힘.
//
// 2. 키보드
// ─────────
// 시트 아래쪽 입력칸을 누르면 키보드가 올라오면서 **그 입력칸과 [주문]
// 버튼을 덮는다.** 사용자는 자기가 무엇을 적고 있는지 못 본 채 숫자를
// 치고, 버튼을 누르려면 시트를 스크롤해야 하는데 키보드가 떠 있는
// 동안에는 그 스크롤이 잘 안 먹는다.
//
// iOS Safari는 키보드가 올라와도 window.innerHeight를 안 바꾼다.
// 바뀌는 것은 visualViewport.height다 — 둘의 차이가 키보드 높이다.
//
// 판정을 화면에 두지 않는 이유는 늘 같다: 화면에 두면 테스트가 안 붙고,
// 붙지 않으면 "키보드가 올라왔을 때 버튼이 보이는가"를 아무도 확인할 수
// 없다. 그리고 이 저장소에는 시트가 하나가 아니다.

/** 히스토리에 무엇을 할 것인가 */
export type HistoryAction =
  /** 칸을 하나 넣는다 (시트가 열렸다) */
  | 'PUSH'
  /** 넣어 둔 칸을 뺀다 (X·배경 탭으로 닫혔다) */
  | 'POP'
  /** 아무것도 안 한다 */
  | 'NONE';

export interface SheetHistoryState {
  /** 지금 시트가 열려 있는가 */
  open: boolean;
  /** 우리가 넣어 둔 칸이 있는가 */
  pushed: boolean;
  /** 이번 닫힘이 뒤로가기로 일어났는가 */
  closedByPop?: boolean;
}

/**
 * 이 전환에서 히스토리에 할 일.
 *
 * **뒤로가기로 닫힌 것에는 POP을 하지 않는다.** 브라우저가 이미 한 칸을
 * 뺐으므로, 여기서 또 빼면 뒤로가기 한 번에 두 칸이 물러난다.
 */
export function historyAction(
  prev: SheetHistoryState | null | undefined, next: SheetHistoryState,
): HistoryAction {
  const was = !!prev?.open;
  if (next.open && !was) return next.pushed ? 'NONE' : 'PUSH';
  if (!next.open && was) {
    if (!next.pushed) return 'NONE';        // 넣은 적이 없으면 뺄 것도 없다
    return next.closedByPop ? 'NONE' : 'POP';
  }
  return 'NONE';
}

/**
 * 키보드가 올라온 것으로 볼 최소 높이(px).
 *
 * 이보다 작은 차이는 주소창이 접혔다 펴진 것이다. 그걸 키보드로 읽으면
 * 스크롤할 때마다 시트가 들썩인다.
 */
export const KEYBOARD_MIN_PX = 120;

export interface ViewportSample {
  /** window.innerHeight */
  windowHeight?: number | null;
  /** visualViewport.height — 키보드가 올라오면 이쪽만 줄어든다 */
  viewportHeight?: number | null;
  /** visualViewport.offsetTop — 화면이 밀려 올라간 양 */
  offsetTop?: number | null;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * 키보드가 가리는 높이(px).
 *
 * **못 재면 0이다.** visualViewport가 없는 브라우저(구형 안드로이드)에서
 * 아무 값이나 넣으면 키보드가 없는데도 시트 아래에 빈 칸이 생긴다 —
 * 그건 고장으로 보인다. 0이면 지금까지와 똑같이 동작한다.
 */
export function keyboardInset(s: ViewportSample | null | undefined): number {
  const win = num(s?.windowHeight);
  const vis = num(s?.viewportHeight);
  if (win == null || vis == null || win <= 0) return 0;
  const off = num(s?.offsetTop) ?? 0;
  // 화면이 밀려 올라간 만큼도 가려진 높이에 포함된다(iOS).
  const covered = win - vis - off;
  return covered >= KEYBOARD_MIN_PX ? Math.round(covered) : 0;
}

export function isKeyboardOpen(s: ViewportSample | null | undefined): boolean {
  return keyboardInset(s) > 0;
}

export interface SheetMetrics {
  /** 시트가 차지할 최대 높이 */
  maxHeight: string;
  /** 아래쪽 여백 — 키보드 위로 버튼을 밀어 올린다 */
  paddingBottom: string;
  /** 키보드가 올라와 있는가 */
  keyboardOpen: boolean;
}

/**
 * 시트의 높이와 여백.
 *
 * 키보드가 올라오면 **높이를 줄이고 여백을 준다.** 높이만 줄이면 내용이
 * 키보드 뒤로 들어가고, 여백만 주면 시트가 화면 위로 넘친다.
 *
 * 키보드가 없을 때는 지금까지와 똑같은 값을 준다 — 안 쓰는 브라우저에서
 * 화면이 달라지면 안 된다.
 */
export function sheetMetrics(
  s: ViewportSample | null | undefined, maxHeightPct = 88,
): SheetMetrics {
  const inset = keyboardInset(s);
  if (inset <= 0) {
    return {
      maxHeight: `${maxHeightPct}vh`,
      paddingBottom: 'max(env(safe-area-inset-bottom), 8px)',
      keyboardOpen: false,
    };
  }
  // 키보드가 떠 있는 동안에는 보이는 영역만 쓴다. 홈 인디케이터 여백은
  // 키보드가 덮고 있으므로 다시 더하지 않는다.
  return {
    maxHeight: `calc(${maxHeightPct}vh - ${inset}px)`,
    paddingBottom: `${inset}px`,
    keyboardOpen: true,
  };
}
