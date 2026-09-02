// src/lib/ui/tokens.ts
//
// **화면의 시각 원시값 정본 — 숫자 부분.**
//
// 왜 이 파일이 lib에 있나
// ───────────────────────
// 색을 붙인 스타일 객체는 `components/ui/tokens.ts`에 이미 있다. 그런데
// 그 파일은 `@/lib/constants`를 별칭으로 불러서 테스트 하네스가 컴파일하지
// 못한다(하네스는 src만 복사해 상대경로로 돌린다). 스케일에 테스트를 붙일
// 수 없으면 "정본이라고 적어 둔 파일"이 되고, 값이 어긋나도 아무도 모른다.
//
// 그래서 **숫자와 판단만** 여기 두고, 색이 필요한 스타일은 그대로
// components 쪽에 남긴다. components 쪽은 이 파일을 다시 내보내므로
// 기존 `@/components/ui/tokens` import 경로는 그대로 동작한다.
//
// 값을 어디서 가져왔나
// ────────────────────
// **지어내지 않았다.** 저장소의 인라인 스타일 17,316건을 세서 실제로
// 쓰이는 값을 스케일로 만들었다. 그래서 이 스케일로 옮겨도 화면이
// 달라지지 않는다 — 이번 단계는 리디자인이 아니라 정리다.
//
// 실측에 없는 "예뻐 보이는 값"을 넣지 않았다. 넣으면 다음 사람이 그것을
// 쓰고, 그때 화면이 조용히 달라진다.

import { MIN_CONTROL_TARGET } from './panelPrefs';

/* ── 간격 ─────────────────────────────────────────────────────
   기존 `components/ui/tokens.ts`의 SP를 그대로 옮겼다. 값을 바꾸면
   이미 SP를 쓰는 화면이 움직이므로 손대지 않는다. */
export const SP = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

/* ── 모서리 ───────────────────────────────────────────────────
   sm~pill은 기존 R 그대로다. `card: 18`은 새로 만든 값이 아니라
   **이미 화면에 있는 값**이다 — SharedUI의 Card가 18을 쓰고 그 카드가
   337곳에서 렌더된다. 스케일에 18이 없으면 Card를 토큰으로 옮길 때
   16으로 바꿔야 하고, 그건 정리가 아니라 디자인 변경이다. */
export const R = {
  sm: 8,
  md: 12,
  lg: 16,
  card: 18,
  xl: 20,
  pill: 999,
} as const;

/**
 * 글자 크기.
 *
 * 터미널(`components/terminal/theme.ts`)에 같은 이름의 스케일이 따로
 * 있었다. 같은 개념이 두 곳에 있으면 언젠가 한쪽만 바뀐다 — 이 저장소가
 * 반복해서 겪은 고장이다. 그래서 정본을 여기 두고 터미널이 이것을 쓴다.
 * micro~hero 값은 터미널 것과 **같다**. 터미널 화면은 달라지지 않는다.
 */
export const FS = {
  /**
   * @deprecated 새로 쓰지 않는다.
   *
   * 터미널 스케일은 "10px 아래로 내려가지 않는다 — 그 아래는 정보가
   * 아니라 장식이다"라고 정해 두었다. 그런데 앱 화면에는 9px가 489곳
   * 있다. 스케일에서 빼면 그 489곳은 토큰으로 옮길 방법이 없어 영원히
   * 인라인으로 남는다. 그래서 **옮기기 위해** 남겨 두되, 새 화면에
   * 쓰라는 뜻은 아니라는 것을 이름과 이 주석으로 남긴다.
   */
  nano:  9,
  micro: 10,   // 라벨·단위
  small: 11,   // 표 본문
  body:  12,   // 기본
  lead:  13,   // 버튼·강조
  sub:   14,   // 섹션 소제목
  num:   15,   // 가격
  title: 16,   // 카드 제목
  head:  18,   // 화면 제목
  hero:  20,   // 대표 숫자
} as const;

/** 글자 굵기. 실측에서 700(1536) · 800(599) · 900(213) · 600(129)가 대부분이다. */
export const FW = {
  normal: 500,
  medium: 600,
  bold:   700,
  heavy:  800,
  black:  900,
} as const;

/** 줄 간격. 실측 상위 네 개(1.5 · 1.6 · 1.45 · 1.8)를 이름 붙인 것이다. */
export const LH = {
  tight:   1.4,
  normal:  1.5,
  relaxed: 1.6,
  loose:   1.8,
} as const;

/** 테두리 두께. 이 저장소는 전부 1px이다 — 굵기를 늘리는 대신 색을 낮춘다. */
export const BORDER_W = 1;

/**
 * 누를 수 있는 것의 높이.
 *
 * **최소값을 여기서 다시 선언하지 않는다.** `MIN_CONTROL_TARGET`은
 * panelPrefs에 있고 UI-1에서 그 값 때문에 한 번 되돌린 적이 있다.
 * 같은 숫자를 두 곳에 적으면 한쪽만 고쳐지는 날이 온다.
 */
export const CONTROL = {
  /** 조밀한 자리(칩·카드 안 버튼). 최소 타깃보다 작다 — 아래 주석 참조 */
  sm: 36,
  /** 기본 버튼 */
  md: 44,
  /** 큰 버튼·입력 */
  lg: 48,
  /** 손으로 누를 수 있어야 하는 것의 최소 한 변 */
  min: MIN_CONTROL_TARGET,
} as const;

/**
 * 화면 폭 분기점. globals.css의 미디어쿼리와 **같은 숫자**여야 한다.
 * JS가 이 값을 보고 판단하는데 CSS가 다른 값에서 바뀌면, 두 판단이
 * 어긋나는 구간이 생긴다.
 */
export const BP = {
  xs:  480,
  sm:  640,
  md:  768,   // 사이드바 등장
  lg:  1024,  // 오른쪽 레일 등장
  xl:  1440,  // 사이드바 넓힘
} as const;

/* ── 판단 ─────────────────────────────────────────────────────
   값만 모아 두면 "정본이 있다"고 말할 수는 있어도 아무도 안 쓴다.
   실제로 필요한 판단을 같이 둬야 쓰인다. */

/**
 * 이 조작이 손으로 누르기에 충분한가.
 *
 * UI-1에서 26×26 버튼을 만들어 놓고 주석에 "PC 전용"이라고 적었다가
 * 되돌렸다. 노출 조건(768px·1024px)에는 손으로 누르는 태블릿이 들어
 * 있었다. 주석이 아니라 값으로 판단하게 한다.
 */
export function isTouchSafe(size: number): boolean {
  return Number.isFinite(size) && size >= CONTROL.min;
}

/**
 * 이 화면 폭에서 사이드바가 보이는가 / 오른쪽 레일이 보이는가.
 * CSS 미디어쿼리와 같은 경계를 JS도 쓰게 한다.
 */
export function showsSidebar(viewportW: number): boolean {
  return Number.isFinite(viewportW) && viewportW >= BP.md;
}
export function showsRail(viewportW: number): boolean {
  return Number.isFinite(viewportW) && viewportW >= BP.lg;
}

/** 스케일에 있는 값인가. 검사기와 테스트가 쓴다. */
export function inScale<T extends Record<string, number>>(scale: T, v: number): boolean {
  return Object.values(scale).includes(v);
}
