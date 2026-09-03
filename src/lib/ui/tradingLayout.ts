// src/lib/ui/tradingLayout.ts
//
// **거래화면이 어떤 배치를 쓸지 정하는 곳.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 터미널 껍데기(TerminalShell)는 배치를 이렇게 정했다:
//
//   const tier = tierOf(window.innerWidth);      // 뷰포트로 판단
//   const centerPct = 100 - leftPct - rightPct;  // 폭은 퍼센트
//
// 두 줄 다 틀렸다.
//
// ① **뷰포트로 판단한다.** 이 화면은 앱 탭 안(`.mc`)에 들어가 있고,
//    그 폭은 뷰포트에서 사이드바(240)와 뉴스 레일(300)을 뺀 값이다.
//    1664 화면에서 터미널은 "1664니까 3열"이라고 결정하지만 실제로
//    쓸 수 있는 폭은 1124다.
//
// ② **폭이 퍼센트다.** 그래서 좁아지면 주문판이 같이 줄어든다.
//    실측: 1664에서 주문판 301px, 1440에서 240px, 1366에서 226px.
//    주문판은 라벨·입력·단위·버튼이 한 줄에 들어가야 하는 칸이라
//    좁아지면 글자끼리 겹친다. 실제로 겹쳤다 — 1366에서 14곳.
//
// 여기서 하는 일
// ──────────────
// **쓸 수 있는 폭(px)을 받아서 배치를 돌려준다.** 퍼센트가 아니라
// 픽셀 하한을 먼저 지키고, 못 지키면 우선순위가 낮은 칸을 접는다.
//
// 우선순위 (사용자가 정한 것):
//   1. 중앙 차트   2. 주문   3. 종목 선택   4. 실시간 시세·뉴스
//
// 그래서 폭이 모자라면 뉴스 레일 → 종목 레일 순서로 물러나고,
// 중앙과 주문은 마지막까지 지킨다. 둘 다 못 지키면 그때는 데스크톱
// 배치를 포기하고 태블릿/모바일 배치로 간다 — **줄이지 않고 다시 놓는다.**

import { CENTER_MIN, SIDEBAR_COMPACT } from './panelPrefs';

/**
 * 주문판이 제 일을 하려면 필요한 최소 폭.
 *
 * 라벨 + 값 + 입력 + 단위 + 버튼이 한 행에 들어가야 한다. 이보다 좁으면
 * 글자가 겹치기 시작한다(실측 301px에서 이미 겹침). 글자 크기를 줄여
 * 맞추지 않는다 — 배율이 세 자리가 되거나 청산가가 실제 값으로 바뀌면
 * 같은 자리에서 또 넘친다.
 */
export const ORDER_MIN = 340;

/** 종목 레일을 펼친 채로 쓸 수 있는 최소 폭 (심볼·가격·등락이 안 잘리는 폭) */
export const MARKET_MIN = 200;

/** 열 사이 손잡이(Splitter) 폭. 배치 계산에서 빠뜨리면 1px씩 넘친다. */
export const SPLITTER = 5;

export type MarketMode = 'expanded' | 'compact' | 'drawer';
export type OrderMode = 'persistent' | 'sheet';
export type LayoutKind = 'desktop' | 'tablet' | 'mobile';

export interface TradingLayout {
  kind: LayoutKind;
  market: { mode: MarketMode; width: number };
  /** 중앙 차트가 실제로 갖는 폭 */
  center: number;
  order: { mode: OrderMode; width: number };
  /** 왜 이 배치인가. 화면·테스트·검사기가 같은 이유를 본다 */
  reason: string;
}

/** 데스크톱 배치를 시도할 수 있는 최소 폭 (compact 종목 + 중앙 + 주문) */
export const DESKTOP_MIN = SIDEBAR_COMPACT + SPLITTER + CENTER_MIN + SPLITTER + ORDER_MIN;

/** 태블릿 배치를 시도할 수 있는 최소 폭 (중앙만 유지, 주문은 시트) */
export const TABLET_MIN = 560;

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 쓸 수 있는 폭에서 배치를 정한다.
 *
 * @param availW 이 화면이 실제로 쓸 수 있는 폭(px). 뷰포트가 아니라
 *               **담긴 칸의 폭**이다. 부르는 쪽이 ResizeObserver로 잰다.
 */
export function planTradingLayout(availW: unknown): TradingLayout {
  const w = Math.floor(finite(availW));

  // 폭을 모르면 가장 안전한 쪽(모바일 단일 열)으로 간다. 모르는 채로
  // 3열을 그리면 좁은 화면에서 한 번 깨진 뒤에 고쳐진다.
  if (w <= 0) {
    return { kind: 'mobile', market: { mode: 'drawer', width: 0 }, center: 0,
      order: { mode: 'sheet', width: 0 }, reason: '폭을 아직 모름' };
  }

  // ── 데스크톱: 중앙과 주문을 픽셀로 먼저 확보한다 ──
  if (w >= DESKTOP_MIN) {
    const rest = w - ORDER_MIN - SPLITTER;   // 주문판을 뗀 나머지

    // ① 종목 레일을 펼칠 수 있는가
    if (rest - SPLITTER - MARKET_MIN >= CENTER_MIN) {
      // 남는 폭은 중앙에 준다 — 중앙이 핵심 작업 영역이다.
      const market = MARKET_MIN;
      const center = rest - SPLITTER - market;
      return { kind: 'desktop', market: { mode: 'expanded', width: market }, center,
        order: { mode: 'persistent', width: ORDER_MIN },
        reason: '3열 — 종목 펼침' };
    }
    // ② 종목 레일을 좁힌다 (UI-1의 검증된 compact 폭을 그대로 쓴다)
    if (rest - SPLITTER - SIDEBAR_COMPACT >= CENTER_MIN) {
      const center = rest - SPLITTER - SIDEBAR_COMPACT;
      return { kind: 'desktop', market: { mode: 'compact', width: SIDEBAR_COMPACT }, center,
        order: { mode: 'persistent', width: ORDER_MIN },
        reason: '3열 — 종목 접힘(폭 부족)' };
    }
    // ③ 종목 레일을 서랍으로 뺀다
    const center = rest;
    if (center >= CENTER_MIN) {
      return { kind: 'desktop', market: { mode: 'drawer', width: 0 }, center,
        order: { mode: 'persistent', width: ORDER_MIN },
        reason: '2열 — 종목은 서랍' };
    }
  }

  // ── 태블릿: 중앙 중심. 주문은 시트, 종목은 서랍 ──
  // 데스크톱 3열을 억지로 눌러 담지 않는다.
  if (w >= TABLET_MIN) {
    return { kind: 'tablet', market: { mode: 'drawer', width: 0 }, center: w,
      order: { mode: 'sheet', width: 0 },
      reason: '태블릿 — 중앙 전체 · 주문/종목은 시트' };
  }

  // ── 모바일: 단일 열 ──
  return { kind: 'mobile', market: { mode: 'drawer', width: 0 }, center: w,
    order: { mode: 'sheet', width: 0 },
    reason: '모바일 — 단일 열' };
}

/**
 * 거래 탭에서 네 번째 영역(오른쪽 시세·뉴스 레일)을 **칸으로 상주**시켜도
 * 되는가.
 *
 * 하한만으로는 부족하다는 것이 1664에서 드러났다
 * ────────────────────────────────────────────────
 * 한동안 이 판단은 "칸으로 두고도 거래 최소폭(DESKTOP_MIN)이 남는가"
 * 하나였다. 1664에서 계산하면 1664 - 240 - 300 = 1124 >= 974라 통과한다.
 * 그런데 그렇게 통과한 1664의 실제 배치는 이랬다:
 *
 *   종목 200 · 차트 574 · 주문 340 · 뉴스 300
 *
 * 네 칸이 전부 하한이다. 차트는 560 하한 바로 위, 주문판은 정확히 340,
 * 종목은 정확히 200. 어느 것도 여유가 없다. **사용자가 처음 결함을
 * 발견한 화면이 바로 이 1664였다.** 겹치지만 않을 뿐 다시 빽빽하다.
 *
 * 그래서 "최소폭만 넘으면 4열"이 아니라 **폭이 정말 남을 때만 4열**로
 * 바꿨다. 우선순위 4위인 정보 레일은 앞의 셋이 하한을 겨우 넘는 자리를
 * 나눠 가질 자격이 없다.
 *
 *   1024 ~ 1919 — 상주 금지. 접어 두고, 열면 겹쳐서 연다.
 *   1920 이상   — 상주 가능. 단 그때도 거래 최소폭을 실제로 확인한다.
 *
 * 1920을 넘겼다고 무조건 칸을 주지는 않는다. 사이드바가 넓거나 레일이
 * 넓어져 거래영역이 하한 아래로 내려가면 그때도 겹쳐서 연다 —
 * 두 조건을 **모두** 만족해야 상주한다.
 */
export const FOUR_REGION_MIN = 1920;

function canHostFourthRegion(viewportW: unknown, sidebarW: unknown, railW: unknown): boolean {
  const v = finite(viewportW), s = finite(sidebarW), r = finite(railW);
  // 폭을 모르는 동안에는 화면을 건드리지 않는다. 접거나 덮어 놓고
  // 되돌리지 못하는 쪽이 더 나쁘다.
  if (v <= 0 || r <= 0) return true;
  if (v < FOUR_REGION_MIN) return false;
  return v - s - r >= DESKTOP_MIN;
}

/**
 * 뉴스 레일을 **어떻게** 열 것인가.
 *
 * 자동으로 접힌 레일을 사용자가 다시 열면, 예전에는 그대로 300px짜리
 * 격자 칸을 되찾았다. 1440에서 그러면 거래영역이 1152 → 900이 되고,
 * 데스크톱 하한(974)을 못 넘어 **태블릿 배치로 떨어졌다.**
 * 우선순위 4위인 뉴스를 열었다고 1·2위인 차트와 상주 주문판이 사라진
 * 것이다 — 정해 둔 순서와 정반대다.
 *
 * 겹침으로 열면 거래영역의 폭이 그대로라 배치가 바뀌지 않는다. 뉴스는
 * 곁다리 정보이므로 잠깐 덮어도 되지만, 차트와 주문판이 사라지는 것은
 * 안 된다. 한 번 더 누르면 걷힌다.
 */
export type RailPresentation = 'column' | 'overlay';

export function railPresentationFor(
  viewportW: unknown, sidebarW: unknown, railW: unknown,
): RailPresentation {
  return canHostFourthRegion(viewportW, sidebarW, railW) ? 'column' : 'overlay';
}

/**
 * 앱 껍데기의 오른쪽 뉴스 레일을 (거래 탭에서) 접어야 하는가.
 *
 * 뉴스 레일은 곁다리 정보라 우선순위가 가장 낮다(사용자가 정한 순서:
 * 중앙 > 주문 > 종목 > 시세·뉴스). 그런데 레일이 300px를 먼저 가져가고
 * 거래화면이 그 나머지를 나눠 썼다 — 1664에서 주문판이 301px가 된
 * 직접 원인이다.
 *
 * **거래 탭일 때만** 판단한다. 다른 화면에서 레일을 접으면 이번 작업이
 * 건드리지 않기로 한 화면들이 같이 바뀐다.
 *
 * 접을지와 어떻게 열지는 **같은 판단**이다(`canHostFourthRegion`).
 * 두 곳에 따로 두면 언젠가 한쪽만 바뀐다.
 *
 * @param viewportW 창 폭
 * @param sidebarW  왼쪽 메뉴가 차지하는 폭
 * @param railW     뉴스 레일 폭
 */
export function shouldCollapseNewsRail(
  viewportW: unknown, sidebarW: unknown, railW: unknown,
): boolean {
  return !canHostFourthRegion(viewportW, sidebarW, railW);
}
