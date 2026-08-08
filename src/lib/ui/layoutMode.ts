// src/lib/ui/layoutMode.ts
//
// **PC 화면을 줄여서 패드에 보여주지 않는다.**
//
// 지금 패드에서 나는 일: 왼쪽 전체 메뉴 + 가운데 매매 + 오른쪽
// 실시간시세/뉴스가 **동시에** 떠서, 가운데 주문판이 눌려 글자와 버튼이
// 겹친다. 오른쪽 시세·뉴스가 300px 가까이 먹는데, 패드에서 그걸 항상
// 보여줄 이유가 없다.
//
// 좁아졌을 때 하면 안 되는 것
// ───────────────────────────
//   글자를 줄인다        → 읽을 수 없게 되고 결국 겹친다
//   패널을 억지로 눌러 넣는다 → 주문 버튼이 호가 위로 올라온다
//   가로 스크롤을 만든다  → 주문 중에 화면이 옆으로 밀린다
//
// **폭이 모자라면 배치를 바꾼다.** 주문판을 차트 옆에서 떼어 아래나
// 시트로 옮기는 것이 맞다. 이건 타협이 아니라 다른 배치다.
//
// 그리고 뷰포트만 보면 안 된다
// ────────────────────────────
// 갤럭시탭에서 다른 앱과 반반 쓰면 `window.innerWidth`는 1280인데 우리
// 앱에 주어진 폭은 700px일 수 있다. 뷰포트만 보고 DESKTOP을 그리면
// 그 700px 안에 3열이 들어가려다 전부 깨진다. **실제로 쓸 수 있는 폭**을
// 기준으로 판정한다.

export type LayoutMode = 'MOBILE' | 'TABLET' | 'DESKTOP' | 'WIDE_DESKTOP';

export const LAYOUT_LABEL: Record<LayoutMode, string> = {
  MOBILE: '모바일', TABLET: '태블릿', DESKTOP: '데스크톱', WIDE_DESKTOP: '와이드',
};

/** 경계값. 한 곳에서만 정한다 — 화면마다 다르면 한 화면 고치고 다른 화면이 깨진다 */
export const BREAKPOINTS = {
  tablet: 768,
  desktop: 1200,
  wide: 1600,
} as const;

function px(v: any): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 지금 어떤 배치인가.
 *
 * **뷰포트가 아니라 실제 가용 폭이 기준이다.** 둘 다 주면 작은 쪽을
 * 쓴다 — 분할화면·사이드패널·확대 때문에 앱에 주어진 폭이 뷰포트보다
 * 작을 수 있고, 그때 큰 쪽을 믿으면 안 들어가는 배치를 그린다.
 *
 * 폭을 아예 모르면 `MOBILE`이다. **모르는 쪽에서 안전한 방향은 좁은
 * 쪽이다** — 좁은 배치를 넓은 화면에 그리면 허전할 뿐이지만, 넓은
 * 배치를 좁은 화면에 그리면 겹쳐서 못 쓴다.
 */
export function layoutModeOf(contentWidthPx: any, viewportWidthPx?: any): LayoutMode {
  const c = px(contentWidthPx);
  const v = px(viewportWidthPx);
  const w = c !== null && v !== null ? Math.min(c, v) : (c ?? v);

  if (w === null || w <= 0) return 'MOBILE';
  if (w >= BREAKPOINTS.wide) return 'WIDE_DESKTOP';
  if (w >= BREAKPOINTS.desktop) return 'DESKTOP';
  if (w >= BREAKPOINTS.tablet) return 'TABLET';
  return 'MOBILE';
}

// ── 최소 폭 ───────────────────────────────────────────────
//
// 이 값들이 배치를 바꾸는 근거다. "이보다 좁아지면 글자를 줄인다"가
// 아니라 **"이보다 좁아지면 다른 배치로 간다"**이다.

export const MIN_WIDTH = {
  /** 주문판. 수량·가격 입력과 버튼이 한 줄에 들어가는 최소 */
  orderPanel: 320,
  /** 호가창 */
  orderbook: 220,
  /** 차트가 차트 구실을 하는 최소 */
  chart: 420,
  /** 왼쪽 메뉴 (펼친 상태) */
  sidebar: 220,
  /** 아이콘만 남긴 rail */
  sidebarRail: 64,
  /** 오른쪽 시세·뉴스 */
  rightRail: 280,
} as const;

/** 차트가 차트 구실을 하는 최소 높이 */
export const MIN_CHART_HEIGHT = 260;

// ── 배치 계획 ─────────────────────────────────────────────

export type SidebarMode =
  /** 220~240px 펼친 메뉴 */
  | 'FULL'
  /** 64px 아이콘만 */
  | 'RAIL'
  /** 버튼을 눌러야 겹쳐 나오는 서랍 */
  | 'DRAWER';

export type OrderPanelPlacement =
  /** 차트 옆 */
  | 'SIDE'
  /** 차트 아래 */
  | 'BELOW'
  /** 아래에서 올라오는 시트 */
  | 'SHEET';

export interface LayoutPlan {
  mode: LayoutMode;
  sidebar: SidebarMode;
  /** 오른쪽 시세·뉴스를 항상 보여 주는가 */
  rightRailVisible: boolean;
  /** 안 보여 준다면 버튼으로 열 수 있는가 */
  rightRailOnDemand: boolean;
  orderPanel: OrderPanelPlacement;
  /** 차트가 차지할 비율(%). 주문판이 옆에 없으면 100 */
  chartPct: number;
  /** 하단 탭에 몇 개까지 보여 주는가. 나머지는 더보기 */
  bottomTabs: number;
  /** 왜 이렇게 배치했는지 — 화면이 적을 수 있게 */
  reason: string;
}

/**
 * 이 폭에서 무엇을 어디에 둘 것인가.
 *
 * **오른쪽 시세·뉴스는 거래 실행보다 우선순위가 낮다.** 시세를 못 보면
 * 불편하지만, 주문 버튼이 호가 위로 겹치면 잘못된 주문이 나간다.
 * 그래서 좁아지면 시세부터 접는다.
 *
 * @param portrait 세로로 길쭉한가. 패드 세로에서는 폭이 넉넉해도
 *                 차트와 주문판을 옆에 두면 둘 다 답답하다.
 */
export function layoutPlanOf(
  contentWidthPx: any,
  opts?: { viewportWidthPx?: any; portrait?: boolean },
): LayoutPlan {
  const mode = layoutModeOf(contentWidthPx, opts?.viewportWidthPx);
  const c = px(contentWidthPx);
  const v = px(opts?.viewportWidthPx);
  const w = c !== null && v !== null ? Math.min(c, v) : (c ?? v ?? 0);
  const portrait = opts?.portrait === true;

  if (mode === 'MOBILE') {
    return {
      mode, sidebar: 'DRAWER', rightRailVisible: false, rightRailOnDemand: true,
      orderPanel: 'SHEET', chartPct: 100, bottomTabs: 3,
      reason: '거래 실행만 남깁니다 — 차트는 전체 폭, 주문은 시트로 올라옵니다',
    };
  }

  if (mode === 'TABLET') {
    // 세로이거나 분할화면으로 좁아졌으면 차트와 주문판을 나란히 두지 않는다.
    const sideFits = !portrait && w >= (MIN_WIDTH.sidebarRail + MIN_WIDTH.chart + MIN_WIDTH.orderPanel);
    return {
      mode,
      // **패드에서 전체 메뉴를 펼치지 않는다.** 220px는 여기서 너무 비싸다.
      sidebar: 'RAIL',
      rightRailVisible: false, rightRailOnDemand: true,
      orderPanel: sideFits ? 'SIDE' : 'BELOW',
      chartPct: sideFits ? 62 : 100,
      bottomTabs: 4,
      reason: sideFits
        ? '왼쪽 메뉴는 아이콘만, 오른쪽 시세·뉴스는 버튼으로 엽니다 — 그 폭을 차트와 주문판에 돌립니다'
        : '폭이 모자라 주문판을 차트 아래로 내렸습니다 — 나란히 두면 둘 다 못 씁니다',
    };
  }

  // ── 데스크톱 ──
  //
  // 오른쪽 rail을 붙였을 때 가운데가 최소 폭 아래로 내려가면 rail을 접는다.
  const centerWithRail = w - MIN_WIDTH.sidebar - MIN_WIDTH.rightRail;
  const centerNeeds = MIN_WIDTH.chart + MIN_WIDTH.orderPanel;
  const railFits = centerWithRail >= centerNeeds;

  if (mode === 'DESKTOP') {
    return {
      mode, sidebar: 'FULL',
      // **와이드가 아니면 rail은 자리가 남을 때만.**
      rightRailVisible: railFits, rightRailOnDemand: true,
      orderPanel: 'SIDE', chartPct: 65, bottomTabs: 6,
      reason: railFits ? '' :
        '가운데 거래 영역이 좁아져 오른쪽 시세·뉴스를 접었습니다 — 시세를 못 보는 것보다'
        + ' 주문판이 눌리는 쪽이 위험합니다',
    };
  }

  // WIDE_DESKTOP — 여기서만 3열을 상시로 둔다.
  return {
    mode, sidebar: 'FULL',
    rightRailVisible: true, rightRailOnDemand: true,
    orderPanel: 'SIDE', chartPct: 65, bottomTabs: 8,
    reason: '',
  };
}

// ── 하단 탭 ───────────────────────────────────────────────

export interface TabItem { id: string; label: string; /** 항상 보인다 */ pinned?: boolean }

export interface TabSplit {
  visible: TabItem[];
  overflow: TabItem[];
  /** 더보기 버튼이 필요한가 */
  needsMore: boolean;
}

/**
 * 하단 탭을 몇 개 보여 주고 몇 개를 더보기로 보낼 것인가.
 *
 * 지금 매매 화면 하단에 열세 개가 있다 — 포지션·데모·미체결·자산·
 * 자금배분·안전장치·손절이동·시간예약·설정·증권사·상태·방송자·로그인.
 * **열세 개가 한 줄에 있으면 매일 쓰는 것과 일 년에 한 번 쓰는 것이
 * 같은 무게로 보이고**, 그래서 매일 쓰는 것이 밀린다.
 *
 * `pinned`는 접히지 않는다 — 지금 열려 있는 탭이 더보기 안으로 숨으면
 * 사용자는 자기가 어디 있는지 모른다.
 */
export function tabSplitOf(
  tabs: TabItem[] | null | undefined,
  limit: number,
  activeId?: string | null,
): TabSplit {
  const list = (Array.isArray(tabs) ? tabs : []).filter(t => t && t.id);
  const n = Math.max(1, Math.floor(Number(limit) || 1));

  if (list.length <= n) return { visible: list, overflow: [], needsMore: false };

  // 더보기 버튼도 한 자리를 먹는다. 그걸 안 세면 한 칸이 넘친다.
  const room = Math.max(1, n - 1);
  const pinned = list.filter(t => t.pinned || t.id === activeId);
  const rest = list.filter(t => !pinned.includes(t));

  const visible = [...pinned, ...rest].slice(0, Math.max(room, pinned.length));
  const overflow = list.filter(t => !visible.includes(t));

  return { visible, overflow, needsMore: overflow.length > 0 };
}

// ── 겹침 방지 ─────────────────────────────────────────────

/**
 * 이 폭에 두 패널이 나란히 들어가는가.
 *
 * **안 들어가면 배치를 바꾸라는 신호다.** 글자를 줄이거나 패딩을
 * 없애서 억지로 넣으면, 숫자가 잘리거나 버튼이 다른 패널 위로 올라간다.
 */
export function fitsSideBySide(availablePx: any, minA: number, minB: number, gap = 8): boolean {
  const w = px(availablePx);
  if (w === null) return false;
  return w >= minA + minB + gap;
}

/**
 * 모든 flex/grid 자식에 필요한 안전 스타일.
 *
 * `min-width: 0`이 없으면 flex 자식은 **내용보다 작아지지 않는다.**
 * 그래서 긴 숫자 하나가 패널 전체를 밀어내고, 옆 패널을 화면 밖으로
 * 내보낸다. 이 저장소에서 패드 레이아웃이 깨진 원인 중 하나다.
 */
export const FLEX_SAFE = {
  minWidth: 0, minHeight: 0,
} as const;

/** 긴 텍스트가 옆 패널을 밀어내지 않게 */
export const TEXT_SAFE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  overflowWrap: 'anywhere',
} as const;
