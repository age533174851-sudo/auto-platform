// src/lib/trading/oneScreen.ts
//
// **한 화면 배치의 숫자 — 추정이 아니라 실측에서 나왔다.**
//
// 호가 열의 바닥은 어디서 오나
// ────────────────────────────
// 실측(360px, 모노스페이스 10px): 가격 `76,704.50` = **53px**,
// 수량 `2.260` = **30px**. 합 83px에 좌우 패딩 16px을 더하면 **99px**이고,
// 여기에 숨 쉴 자리를 조금 주면 **110px**이 바닥이다.
//
// 이 밑으로 내려가면 가격이 잘린다. 그리고 **잘린 숫자는 없는 것보다
// 나쁘다** — 읽는 사람이 자릿수를 잘못 센다. 실기에서 명목가가 그렇게
// 잘렸다.
//
// 왜 50:50이 아닌가
// ─────────────────
// 주문 열에는 비중 슬라이더가 있다. 슬라이더는 짧아질수록 한 번의 드래그가
// 더 큰 비중을 움직여서, 좁으면 원하는 값을 못 고른다. 320px에서 50:50이면
// 주문 열이 152px이고 슬라이더는 그보다 짧아진다.
//
// 그래서 **주문을 넓게** 잡고 호가는 바닥만 지킨다.

/** 호가 열의 절대 하한(px). 가격 53 + 수량 30 + 패딩 16 + 여유 */
export const BOOK_MIN_PX = 110;

/** 바깥 여백과 두 열 사이 간격(px) */
export const GUTTER_PX = 22;

export interface SplitColumns {
  orderPct: number;
  bookPct: number;
  /** 이 폭에서 호가 열이 몇 px가 되는가 */
  bookPx: number;
  /** 바닥을 못 지켰다 — 화면이 세로로 접어야 한다 */
  tooNarrow: boolean;
}

/**
 * 화면 폭에서 두 열의 비율을 정한다.
 *
 * 기본은 주문 60 : 호가 40이고, 그 비율에서 호가가 바닥을 못 지키면
 * **호가에 바닥을 주고 주문이 양보한다** — 호가가 잘리면 시장을 잘못 읽고,
 * 주문 열은 줄이 늘어날 뿐이다.
 */
export function splitColumns(viewportWidth: any): SplitColumns {
  // `Number(null)`은 0이다. 먼저 거르지 않으면 **못 읽은 것이 폭 0**이 되고,
  // 0은 320보다 좁아서 "너무 좁다" 쪽으로 빠진다 — 이 저장소가 반복해서
  // 밟은 함정이고, 여기서도 내 시험이 잡았다.
  const raw = viewportWidth == null || viewportWidth === '' || typeof viewportWidth === 'boolean'
    ? NaN : Number(viewportWidth);
  // 못 읽으면 가장 좁은 기기로 가정한다. 넓게 가정하면 좁은 기기에서 깨진다.
  const w = Number.isFinite(raw) && raw > 0 ? raw : 320;
  const usable = Math.max(0, w - GUTTER_PX);

  const defaultBookPx = usable * 0.40;
  if (defaultBookPx >= BOOK_MIN_PX) {
    return { orderPct: 60, bookPct: 40, bookPx: Math.round(defaultBookPx), tooNarrow: false };
  }
  // 바닥을 지키도록 호가 쪽을 넓힌다.
  const bookPct = usable > 0 ? Math.min(60, (BOOK_MIN_PX / usable) * 100) : 60;
  const bookPx = Math.round((usable * bookPct) / 100);
  return {
    orderPct: Math.round((100 - bookPct) * 10) / 10,
    bookPct: Math.round(bookPct * 10) / 10,
    bookPx,
    tooNarrow: bookPx < BOOK_MIN_PX,
  };
}

/**
 * 첫 화면에 **반드시** 있어야 하는 것.
 *
 * "스크롤 0"을 절대조건으로 두지 않는다 — 320px에서 전부를 욱여넣으면
 * 글자와 버튼이 작아지고 그게 더 위험하다. 대신 이 목록은 접히거나 밀려
 * 나가면 안 된다.
 */
export const FIRST_SCREEN_MUST: string[] = [
  'MARKET_HEADER', 'CHART', 'ORDER_CONTROLS', 'ORDER_BOOK', 'CTA',
];

/** 내리면 나와도 되는 것 */
export const MAY_SCROLL: string[] = ['POSITIONS', 'ORDERS', 'ASSETS'];

export function mustBeOnFirstScreen(part: string): boolean {
  return FIRST_SCREEN_MUST.indexOf(part) >= 0;
}

// ────────────────────────────────────────────────────────────────────
// 세로 예산 — 왜 이것이 필요했나
// ────────────────────────────────────────────────────────────────────
//
// 처음에는 LONG/SHORT 줄을 `position: sticky; bottom: var(--nav-h)`로 붙여
// 두었다. 360×660에서는 멀쩡했다. **320×600에서는 아니었다.**
//
// 실측(320×600):
//
//   주문 칸   366 ─ 724
//   슬라이더  447 ─ 452      ← 여기
//   CTA(붙음) 433 ─ 490      ← 슬라이더를 덮었다
//   손절 2%   550 ─ 576      ← 앱 하단 탭(548 ─ 600) 밑
//
// `elementFromPoint`로 슬라이더 한가운데를 찍으면 `workspace-cta-LONG`이
// 나왔다. 화면에는 슬라이더가 **보이는데 눌리지 않았다.** 손절 2%는 앱
// 하단 탭이 덮고 있었다. 둘 다 "보인다"는 검사만으로는 통과했을 것이다.
//
// 붙은 요소는 제 흐름 위치(787)에서 붙는 위치(490)로 **끌어올려지고, 그
// 사이에 있는 것을 덮는다.** 이건 sticky의 성질이지 버그가 아니다. 그래서
// 고치는 방법은 z-index나 패딩이 아니라 **덮을 일이 없는 배치**다.
//
// 그래서 첫 화면을 고정 높이 세로 통으로 만들고, 그 안에서
//
//   시장정보(잰다) · 차트(계산) · [주문│호가](남는 만큼) · 예상값 · CTA
//
// 로 나눈다. CTA는 통의 마지막 칸에 **그냥 놓인다** — 붙이지 않으니 덮지
// 않고, 통이 하단 탭 위에서 끝나니 탭 밑으로 들어가지도 않는다.
//
// 대신 주문 칸이 좁으면 **그 칸만 안에서 스크롤한다.** 이 저장소는 칸마다
// 스크롤을 주는 것을 꺼려 왔지만(손가락이 어디 닿았는지에 따라 다르게
// 움직인다), `MobileShell`이 이미 같은 이유로 예외를 뒀다 — 넘친 주문
// 버튼이 **말없이 사라지는** 쪽이 훨씬 나쁘다.

/** 시간대·지표 줄(dense) 실측 높이 */
export const TOOLBAR_H = 28;
/** LONG/SHORT 줄 실측 높이 */
export const CTA_H = 57;
/**
 * 수량·증거금·수수료·청산가 + 막힌 사유 + 서버 재계산 단서가 쓰는 높이.
 *
 * 320px에서는 값 네 개가 두 줄로 접힌다. 접히는 쪽을 예산에 넣는다 —
 * 모자라게 잡으면 그만큼 CTA가 밀린다.
 */
export const ESTIMATE_H = 62;
/**
 * 캔들이 캔들로 보이는 최소 높이.
 *
 * 실기에서 시트를 열었을 때 남은 **52px은 격자선과 배경뿐**이었다(색 2종).
 * 그 아래로는 내려가지 않는다. 반대로 130px에서는 캔들 픽셀 4,725개에
 * 색 501종이 나왔다 — 96px은 그 사이에서 캔들이 확실히 읽히는 쪽이다.
 *
 * 왜 130이 아니라 96인가: 320×600에서 **73(시장정보) + 28(시간대) +
 * 130(차트) + 160(호가 3+1+3) + 62(예상값) + 53(CTA) = 506**이고 통은
 * 457px뿐이다. 누군가는 양보해야 한다. 호가 3줄과 CTA는 요구된 것이고
 * 차트는 "캔들이 보일 것"이 요구된 것이라, **차트가 양보한다.**
 * 360·412에서는 이 바닥에 닿지 않는다.
 */
export const CHART_MIN_H = 96;
/** 이보다 커지면 차트 대신 주문 칸에 준다 */
export const CHART_PREF_H = 220;
/**
 * 미니 호가(매도 3 + 현재가 + 매수 3)의 실측 높이.
 *
 * 줄 16px × 6 + 현재가 줄 + 가격/수량 머리줄. 이 아래로 내려가면 매도
 * 3줄 중 일부가 밀려 나가는데, **화면만 보고는 밀렸는지 알 수 없다.**
 */
export const BOOK_H = 146;
/**
 * 열린 포지션 한 줄이 쓰는 높이.
 *
 * **포지션이 있을 때만** 예산에서 뺀다. 없을 때까지 자리를 비워 두면
 * 대부분의 시간에 차트가 그만큼 작아진다.
 */
export const POSITION_ROW_H = 34;
/** [주문│호가] 칸의 세로 여백 + 호가 테두리 */
export const SPLIT_PAD_H = 10;
/** [주문│호가] 칸의 바닥 — 호가가 통째로 들어가는 높이 */
export const SPLIT_MIN_H = BOOK_H + SPLIT_PAD_H;

export interface CoreBudget {
  chartHeight: number;
  /** [주문│호가]에 남는 높이 */
  splitHeight: number;
  /** 주문 칸이 제 높이를 다 못 받았다 — 그 칸만 안에서 스크롤한다 */
  orderScrolls: boolean;
  /**
   * 열린 포지션 줄을 **첫 화면 통 안에** 넣어도 되는가.
   *
   * 통이 짧으면 이 줄 34px이 호가에서 나온다. 그러면 매수 3줄 중 하나가
   * 밀려 나가는데, **화면만 보고는 밀렸는지 알 수 없다** — 호가는 원래
   * 위아래로 이어지는 것처럼 보이기 때문이다.
   *
   * 그래서 자리가 없으면 통 안에 넣지 않고 통 **밖**(바깥 스크롤)에 둔다.
   * 조금 내려야 보이지만 잘리지는 않는다. 320×600이 여기 해당한다.
   */
  positionInCore: boolean;
}

/**
 * 첫 화면 높이를 띠별로 나눈다.
 *
 * 시장정보 높이는 **재서 넣는다.** 상수로 박으면 종목 이름이 길거나 줄이
 * 접힐 때 차트가 그만큼 아래로 밀려 CTA가 화면 밖으로 나간다 —
 * `MobileShell`이 헤더에서 이미 같은 이유로 재고 있다.
 */
export function coreBudget(
  coreHeight: any, headerHeight: any, hasPosition = false,
): CoreBudget {
  const core = finitePx(coreHeight, 380);
  const header = finitePx(headerHeight, 0);

  const bands = core - header - TOOLBAR_H - CTA_H - ESTIMATE_H;

  // 포지션 줄을 통 안에 넣고도 **차트 바닥과 호가 바닥이 둘 다** 남는가.
  // 하나라도 못 지키면 넣지 않는다 — 넣어서 호가를 자르는 쪽이 나쁘다.
  const positionInCore = hasPosition
    && (bands - POSITION_ROW_H - CHART_MIN_H) >= SPLIT_MIN_H;

  const avail = bands - (positionInCore ? POSITION_ROW_H : 0);
  const want = avail - SPLIT_MIN_H;
  const chartHeight = Math.round(
    Math.min(CHART_PREF_H, Math.max(CHART_MIN_H, want)),
  );
  const splitHeight = Math.max(0, Math.round(avail - chartHeight));
  return {
    chartHeight, splitHeight,
    orderScrolls: splitHeight < SPLIT_MIN_H,
    positionInCore,
  };
}

/** `Number(null)`은 0이다. 못 읽은 값이 0이 되면 차트가 사라진다. */
function finitePx(v: any, fallback: number): number {
  if (v == null || v === '' || typeof v === 'boolean') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
