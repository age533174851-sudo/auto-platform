// src/lib/ui/panelPrefs.ts
//
// **PC 껍데기(사이드바·오른쪽 레일·메뉴 보기 방식)의 판단을 한 곳에 둔다.**
//
// 왜 파일을 따로 만드나
// ─────────────────────
// 이 판단들은 전부 "저장된 값을 믿어도 되는가"라는 같은 종류의 질문이다.
// localStorage는 사용자가 손으로 고칠 수 있고, 예전 판에서 쓰던 값이
// 그대로 남아 있기도 하고, 화면 폭이 그 사이에 바뀌기도 한다.
//
//   · `tg_ui_right_width`에 `9999`가 들어 있으면?
//   · 1920에서 420px로 늘려 둔 뒤 1366 노트북에서 열면?
//   · `tg_menu_view`에 옛 이름이 들어 있으면?
//
// 이 셋을 컴포넌트 안에서 각자 처리하면 언젠가 한 곳만 고쳐진다.
// 그래서 **값을 다루는 판단은 여기에만 있고, 컴포넌트는 결과를 쓴다.**
// 테스트도 여기에 붙는다 — 화면을 띄우지 않고 확인할 수 있다.

import { gS, sS } from '../utils';

/* ── 저장 키 ──────────────────────────────────────────────────
   화면 상태는 계정이 아니라 이 브라우저의 것이다. 서버에 올리면
   "회사 모니터에서 접어 둔 것이 노트북에서도 접혀 있다"가 된다. */
export const LEFT_KEY = 'tg_ui_left_panel';
export const RIGHT_KEY = 'tg_ui_right_panel';
export const RIGHT_W_KEY = 'tg_ui_right_width';
export const MENU_VIEW_KEY = 'tg_menu_view';

/* ── 폭 ───────────────────────────────────────────────────────
   숫자를 여기 모아 두는 이유는 CSS와 JS가 같은 값을 봐야 하기
   때문이다. 드래그는 JS가 계산하고 칸은 CSS가 그린다 — 두 곳에
   따로 적으면 손잡이가 멈추는 자리와 칸이 멈추는 자리가 갈린다. */
export const RAIL_MIN = 240;
export const RAIL_MAX = 420;
export const RAIL_DEFAULT = 300;

/**
 * 손으로 누를 수 있는 조작의 최소 크기.
 *
 * **이 값이 여기 있는 이유**
 * ──────────────────────────
 * 처음에 접기 버튼을 26×26으로 만들고 주석에 "마우스가 있는 PC에서만
 * 보인다"고 적었다. 그런데 CSS 계약은 그렇지 않다 — 사이드바는 768px,
 * 오른쪽 레일은 1024px부터 보이고, 834×1194나 1024×768 태블릿은 **손으로
 * 누른다.** 주석이 주장하는 것과 실제 노출 조건이 달랐다.
 *
 * 그래서 크기를 컴포넌트가 각자 고르게 두지 않는다. 여기 한 곳에 두고
 * 버튼도 칸도 이 값을 본다. 그러면 "버튼은 키웠는데 칸은 그대로라
 * 삐져나오는" 상태가 아예 만들어지지 않는다.
 */
export const MIN_CONTROL_TARGET = 40;

/**
 * 접었을 때 남는 세로 띠. 0으로 만들지 않는 이유는 아래 주석 참조.
 *
 * **버튼보다 좁을 수 없다.** 좁으면 펼치기 버튼이 칸 밖으로 나가고,
 * 그것을 음수 마진이나 transform으로 덮는 것은 이번 작업이 없애려는
 * 바로 그 겹침이다. 그래서 최소 크기 + 좌우 여백 4px씩으로 잡는다.
 */
export const RAIL_COLLAPSED = MIN_CONTROL_TARGET + 8;   // 48

export const SIDEBAR_EXPANDED = 220;
export const SIDEBAR_WIDE = 240; // 1440px 이상
export const SIDEBAR_COMPACT = 64;   // MIN_CONTROL_TARGET(40) + 좌우 12px씩

/**
 * 가운데가 이보다 좁아지면 레일을 더 넓히지 않는다.
 *
 * **가운데가 먼저다.** 오른쪽 레일은 곁다리 정보(시세·뉴스)이고,
 * 사용자가 실제로 보는 것은 가운데다. 저장된 폭이 크다는 이유로
 * 1366 화면에서 본문을 400px로 만들면 그건 복원이 아니라 고장이다.
 */
export const CENTER_MIN = 560;

export type LeftMode = 'expanded' | 'compact';
export type RightMode = 'expanded' | 'collapsed';
export type MenuView = 'grid' | 'list';

/* ── 저장된 값 읽기 ───────────────────────────────────────────
   모르는 값은 기본값으로 돌린다. 던지지 않는다 — 화면 껍데기가
   저장값 하나 때문에 안 뜨면 사용자는 앱 전체를 잃는다. */

export function parseLeftMode(raw: string | null | undefined): LeftMode {
  return raw === 'compact' ? 'compact' : 'expanded';
}

export function parseRightMode(raw: string | null | undefined): RightMode {
  return raw === 'collapsed' ? 'collapsed' : 'expanded';
}

export function parseMenuView(raw: string | null | undefined): MenuView {
  // 기본은 목록이다. 지금까지 이 화면은 목록이었고, 저장된 값이 없는
  // 사용자에게 어느 날 갑자기 다른 모양을 보여 주지 않는다.
  return raw === 'grid' ? 'grid' : 'list';
}

/**
 * 저장된 레일 폭을 숫자로 읽는다.
 *
 * `Number('')`은 0이고 `Number(null)`도 0이다. 그대로 쓰면 빈 값이
 * "폭 0"이 되어 레일이 사라진다 — 저장된 적 없는 것과 0으로 저장한
 * 것을 구분해야 한다.
 */
export function parseRailWidth(raw: string | null | undefined): number {
  if (raw == null || raw === '') return RAIL_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return RAIL_DEFAULT;
  return n;
}

/**
 * 이 화면 폭에서 실제로 허용되는 레일 최대폭.
 *
 * 사이드바가 이미 자리를 먹고 있으므로 그것도 빼고 계산한다.
 * 결과가 RAIL_MIN보다 작아질 수 있는데(아주 좁은 창), 그때는
 * RAIL_MIN을 돌려준다 — 레일은 어차피 1024px 미만에서 숨는다.
 */
export function railMaxFor(viewportW: number, sidebarW: number): number {
  if (!Number.isFinite(viewportW) || viewportW <= 0) return RAIL_MAX;
  const room = viewportW - sidebarW - CENTER_MIN;
  if (!Number.isFinite(room)) return RAIL_MAX;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.floor(room)));
}

/**
 * 저장된 폭을 지금 화면에 맞게 조인다.
 *
 * **저장된 값을 그대로 강제하지 않는다.** 넓은 모니터에서 420으로
 * 늘려 둔 사람이 1366 노트북을 열면 여기서 줄어든다. 값 자체는
 * 다시 저장하지 않으므로, 넓은 화면으로 돌아가면 원래 폭이 살아난다.
 */
export function clampRailWidth(w: number, viewportW: number, sidebarW: number): number {
  const max = railMaxFor(viewportW, sidebarW);
  if (!Number.isFinite(w)) return Math.min(RAIL_DEFAULT, max);
  return Math.round(Math.max(RAIL_MIN, Math.min(max, w)));
}

/* ── 폭으로 바꾸기 ────────────────────────────────────────── */

export function sidebarWidthFor(mode: LeftMode, viewportW: number): number {
  if (mode === 'compact') return SIDEBAR_COMPACT;
  return viewportW >= 1440 ? SIDEBAR_WIDE : SIDEBAR_EXPANDED;
}

/**
 * 오른쪽 칸이 실제로 차지할 폭.
 *
 * 접었을 때 0이 아니라 얇은 띠를 남긴다. 0으로 만들면 다시 펴는
 * 버튼을 어딘가에 띄워야 하는데, 떠 있는 버튼은 본문 위를 덮는다 —
 * 이번 작업이 없애려는 바로 그 문제다. 띠는 칸 안에 있으므로
 * 무엇도 덮지 않고, 접혀 있다는 사실도 눈에 보인다.
 */
export function railWidthFor(mode: RightMode, width: number): number {
  return mode === 'collapsed' ? RAIL_COLLAPSED : width;
}

export function nextLeftMode(m: LeftMode): LeftMode {
  return m === 'expanded' ? 'compact' : 'expanded';
}

export function nextRightMode(m: RightMode): RightMode {
  return m === 'expanded' ? 'collapsed' : 'expanded';
}

/* ── 키보드로 폭 조절 ─────────────────────────────────────────
   손잡이를 마우스로만 잡을 수 있으면 그 기능은 마우스를 쓰는
   사람만의 것이 된다. 방향키는 한 칸씩, Home/End는 끝까지. */
export const RAIL_STEP = 16;

export function railWidthFromKey(
  key: string,
  cur: number,
  viewportW: number,
  sidebarW: number,
): number | null {
  const max = railMaxFor(viewportW, sidebarW);
  // 손잡이는 레일 **왼쪽**에 있다. 왼쪽 화살표는 손잡이를 왼쪽으로
  // 옮기는 것이고, 그러면 레일은 넓어진다. 화면에서 보이는 방향과
  // 값의 방향이 반대라는 것을 여기 한 번만 적어 둔다.
  if (key === 'ArrowLeft') return clampRailWidth(cur + RAIL_STEP, viewportW, sidebarW);
  if (key === 'ArrowRight') return clampRailWidth(cur - RAIL_STEP, viewportW, sidebarW);
  if (key === 'Home') return max;
  if (key === 'End') return RAIL_MIN;
  return null;
}

/**
 * 드래그 중인 포인터 x좌표를 레일 폭으로.
 *
 * 레일은 오른쪽 끝에 붙어 있으므로 폭은 `창 오른쪽 - 포인터`다.
 */
export function railWidthFromPointer(
  clientX: number,
  viewportW: number,
  sidebarW: number,
): number {
  return clampRailWidth(viewportW - clientX, viewportW, sidebarW);
}

/* ── 읽기/쓰기 ────────────────────────────────────────────────
   컴포넌트가 localStorage 키를 직접 알지 못하게 한다. 키를 두 곳에
   적으면 한쪽만 고쳐지는 날이 온다. */

export function loadLeftMode(): LeftMode {
  return parseLeftMode(gS(LEFT_KEY, 'expanded'));
}
export function loadRightMode(): RightMode {
  return parseRightMode(gS(RIGHT_KEY, 'expanded'));
}
export function loadRailWidth(): number {
  return parseRailWidth(gS(RIGHT_W_KEY, ''));
}
export function loadMenuView(): MenuView {
  return parseMenuView(gS(MENU_VIEW_KEY, 'list'));
}

export function saveLeftMode(m: LeftMode): void { sS(LEFT_KEY, m); }
export function saveRightMode(m: RightMode): void { sS(RIGHT_KEY, m); }
export function saveRailWidth(w: number): void { sS(RIGHT_W_KEY, String(Math.round(w))); }
export function saveMenuView(v: MenuView): void { sS(MENU_VIEW_KEY, v); }
