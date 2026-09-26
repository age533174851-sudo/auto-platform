// src/lib/trading/marketScreenContract.ts
//
// **시장마다 무엇이 보여야 하고 무엇이 절대 보이면 안 되는가 — 여기서만 정한다.**
//
// 왜 표가 필요한가
// ────────────────
// 거래 화면 넷(현물 · USDⓈ-M · COIN-M · 주식)은 껍데기를 공유한다. 헤더·
// 차트 서랍·호가·숫자 서식은 넷이 같은 부품을 쓴다. 그게 맞다 — 같은 것을
// 네 벌 만들면 언젠가 한 벌만 고쳐진다(이 저장소가 이름 붙인 2번 고장).
//
// 그런데 **주문의 의미는 공유하면 안 된다.** 현물의 '매도'는 가진 것을
// 파는 것이고 선물의 SHORT는 없는 것을 파는 것이다. COIN-M의 수량은 개수가
// 아니라 계약 수고, 증거금은 달러가 아니라 코인이다. 주식에는 청산가가
// 0이 아니라 **없다.**
//
// 공용 껍데기를 쓰면서 의미를 안 섞으려면, "이 화면에 이 칸이 있어도
// 되는가"를 화면이 스스로 판단하면 안 된다. 판단이 네 파일에 흩어지면
// 언젠가 한 화면에 레버리지가 새어 들어가고, 그건 화면을 봐야만 안다.
//
// 그래서 **표를 정본으로 두고 검사기와 시험이 같은 표를 읽는다.**
//
// 칸을 문자열 testid로 쓰지 않는 이유
// ───────────────────────────────────
// 검사기가 낱말을 찾게 만들면 낱말만 바꾸는 변경에 통과한다. 이 저장소에서
// 그 실수를 이미 여러 번 했다. 그래서 칸은 **열거형**이고, 화면에 붙는
// `data-testid`는 이 파일이 정한다. 검사기·시험·브라우저 프로브가 전부
// 같은 상수를 읽으므로, 이름을 바꾸면 세 곳이 함께 움직인다.
import type { MarketType } from '../markets/marketType';

/** 거래 화면에 나타날 수 있는 칸. **여기 없는 칸은 계약 밖이다.** */
export type ScreenField =
  // ── 공통 ──
  | 'ORDER_BOOK'
  | 'POSITIONS'
  | 'OPEN_ORDERS'
  | 'FILLS'
  | 'CHART_BAR'
  // ── 선물에만 있는 것 ──
  | 'OPEN_CLOSE'
  | 'LONG_SHORT'
  | 'MARGIN_MODE'
  | 'LEVERAGE'
  | 'REDUCE_ONLY'
  | 'TP_SL'
  | 'MARK_PRICE'
  | 'FUNDING'
  | 'LIQUIDATION_PRICE'
  | 'LIQUIDATION_DISTANCE'
  // ── 현물에만 있는 것 ──
  | 'BUY_SELL'
  | 'QTY_TOTAL_TOGGLE'
  | 'BASE_HOLDING'
  | 'QUOTE_AVAILABLE'
  // ── COIN-M에만 있는 것 ──
  | 'CONTRACT_COUNT'
  | 'CONTRACT_MULTIPLIER'
  | 'COLLATERAL_COIN'
  | 'CONVERTED_BASE_QTY'
  | 'PNL_UNIT'
  // ── 주식에만 있는 것 ──
  | 'ORDERABLE_CASH'
  | 'TOTAL_ORDER_AMOUNT'
  | 'HELD_QTY'
  | 'AVG_COST'
  | 'EVAL_PNL'
  | 'AMEND_CANCEL'
  | 'SESSION_INFO';

/**
 * 칸 → 화면에 붙는 표식.
 *
 * **이 표가 유일한 출처다.** 화면은 `fieldTestId(f)`로만 표식을 만들고,
 * 검사기와 프로브는 같은 함수로 찾는다. 문자열을 손으로 적는 자리가
 * 생기면 그 자리가 갈린다.
 */
export const FIELD_TESTID: Record<ScreenField, string> = {
  ORDER_BOOK: 'mkt-order-book',
  POSITIONS: 'mkt-positions',
  OPEN_ORDERS: 'mkt-open-orders',
  FILLS: 'mkt-fills',
  CHART_BAR: 'mkt-chart-bar',

  OPEN_CLOSE: 'mkt-open-close',
  LONG_SHORT: 'mkt-long-short',
  MARGIN_MODE: 'mkt-margin-mode',
  LEVERAGE: 'mkt-leverage',
  REDUCE_ONLY: 'mkt-reduce-only',
  TP_SL: 'mkt-tp-sl',
  MARK_PRICE: 'mkt-mark-price',
  FUNDING: 'mkt-funding',
  LIQUIDATION_PRICE: 'mkt-liquidation-price',
  LIQUIDATION_DISTANCE: 'mkt-liquidation-distance',

  BUY_SELL: 'mkt-buy-sell',
  QTY_TOTAL_TOGGLE: 'mkt-qty-total-toggle',
  BASE_HOLDING: 'mkt-base-holding',
  QUOTE_AVAILABLE: 'mkt-quote-available',

  CONTRACT_COUNT: 'mkt-contract-count',
  CONTRACT_MULTIPLIER: 'mkt-contract-multiplier',
  COLLATERAL_COIN: 'mkt-collateral-coin',
  CONVERTED_BASE_QTY: 'mkt-converted-base-qty',
  PNL_UNIT: 'mkt-pnl-unit',

  ORDERABLE_CASH: 'mkt-orderable-cash',
  TOTAL_ORDER_AMOUNT: 'mkt-total-order-amount',
  HELD_QTY: 'mkt-held-qty',
  AVG_COST: 'mkt-avg-cost',
  EVAL_PNL: 'mkt-eval-pnl',
  AMEND_CANCEL: 'mkt-amend-cancel',
  SESSION_INFO: 'mkt-session-info',
};

export function fieldTestId(f: ScreenField): string {
  return FIELD_TESTID[f];
}

export const ALL_FIELDS = Object.keys(FIELD_TESTID) as ScreenField[];

export interface MarketScreenContract {
  market: MarketType;
  /** 화면 뿌리에 붙는 표식 */
  root: string;
  /** 소스 파일. **검사기가 이 경로를 읽는다** */
  file: string;
  /**
   * 이 화면 파일이 **직접** 그리는 칸.
   *
   * 시장 고유의 말(계약 수 · 주문가능금액 · 펀딩)은 여기 있다. 공용
   * 부품으로 빼면 네 시장이 한 파일에서 섞인다.
   */
  own: ScreenField[];
  /**
   * 공용 능력표 부품(`SHARED_GATED_COMPONENTS`)이 **능력표에 물어보고**
   * 그려 주는 칸.
   *
   * 배율·마진모드·손절익절은 현물과 선물이 같은 부품을 쓴다. 부품을 두 벌
   * 만들면 언젠가 한쪽 수량 계산만 바뀐다(2번 고장). 그래서 부품은 하나로
   * 두고, **가리는 판단을 능력표 한 곳에** 둔다.
   */
  fromShared: ScreenField[];
  /** **절대 그리지 않는다.** 없는 개념을 0으로 적지 않기 위해서다 */
  never: ScreenField[];
}

/** 이 화면에 있어야 하는 칸 전부 */
export function mustFields(c: MarketScreenContract): ScreenField[] {
  return [...c.own, ...c.fromShared];
}

/**
 * **어느 시장에서든 금지된 적이 있는 칸** = 시장 전용 칸.
 *
 * 순수 공용 껍데기는 이 칸을 하나도 들면 안 된다. 낱말로 목록을 손으로
 * 적지 않고 계약에서 뽑는다 — 계약이 늘면 검사도 같이 는다.
 */
export function marketSpecificFields(): ScreenField[] {
  const out = new Set<ScreenField>();
  for (const c of MARKET_SCREENS) for (const f of c.never) out.add(f);
  return [...out];
}

const DIR = 'src/components/trading/markets';

/**
 * ★ 네 시장의 계약.
 *
 * `never`가 `must`보다 중요하다. 빠진 칸은 사용자가 "안 보이네"라고
 * 알아채지만, **있으면 안 되는 칸은 그럴듯해 보인다** — 현물 화면의
 * 청산가는 틀린 값이 아니라 없는 개념이고, 그걸 보고 위험을 계산하면
 * 답이 나온다. 틀린 답이.
 */
export const MARKET_SCREENS: MarketScreenContract[] = [
  {
    market: 'SPOT',
    root: 'spot-trading-screen',
    file: `${DIR}/SpotTradingScreen.tsx`,
    own: [
      'ORDER_BOOK', 'BUY_SELL', 'QTY_TOTAL_TOGGLE',
      'BASE_HOLDING', 'QUOTE_AVAILABLE', 'POSITIONS', 'OPEN_ORDERS', 'FILLS',
    ],
    fromShared: [],
    // 현물에는 이 개념들이 **없다**. 1배·0원으로 적지 않는다.
    never: [
      'LEVERAGE', 'MARGIN_MODE', 'FUNDING', 'LIQUIDATION_PRICE',
      'LIQUIDATION_DISTANCE', 'REDUCE_ONLY', 'LONG_SHORT', 'OPEN_CLOSE',
      'MARK_PRICE', 'CONTRACT_COUNT', 'CONTRACT_MULTIPLIER', 'COLLATERAL_COIN',
      'CONVERTED_BASE_QTY', 'PNL_UNIT', 'ORDERABLE_CASH', 'AMEND_CANCEL',
      'SESSION_INFO',
    ],
  },
  {
    market: 'USDT_FUTURES',
    root: 'usdm-trading-screen',
    file: `${DIR}/UsdtFuturesTradingScreen.tsx`,
    own: [
      'ORDER_BOOK', 'OPEN_CLOSE', 'LONG_SHORT', 'REDUCE_ONLY',
      'MARK_PRICE', 'FUNDING', 'LIQUIDATION_DISTANCE',
      'POSITIONS', 'OPEN_ORDERS',
    ],
    // 배율·마진모드·손절익절·청산가는 능력표가 가리는 공용 부품에서 온다.
    fromShared: ['MARGIN_MODE', 'LEVERAGE', 'TP_SL', 'LIQUIDATION_PRICE'],
    // USDⓈ-M 수량은 코인 개수다. 계약 수·코인 증거금은 COIN-M의 말이다.
    never: [
      'CONTRACT_COUNT', 'CONTRACT_MULTIPLIER', 'COLLATERAL_COIN',
      'CONVERTED_BASE_QTY', 'ORDERABLE_CASH', 'AMEND_CANCEL', 'SESSION_INFO',
      'BUY_SELL', 'QTY_TOTAL_TOGGLE',
    ],
  },
  {
    market: 'COIN_FUTURES',
    root: 'coinm-trading-screen',
    file: `${DIR}/CoinMFuturesTradingScreen.tsx`,
    // ★ COIN-M은 공용 주문 부품을 쓰지 않는다. 수량이 코인 개수가 아니라
    //   **계약 수**고 증거금이 코인이라, 같은 폼을 재사용하면 의미가 섞인다.
    own: [
      'ORDER_BOOK', 'OPEN_CLOSE', 'LONG_SHORT', 'MARGIN_MODE', 'LEVERAGE',
      'REDUCE_ONLY', 'MARK_PRICE', 'FUNDING',
      'LIQUIDATION_PRICE', 'LIQUIDATION_DISTANCE',
      // ★ COIN-M을 COIN-M이게 하는 다섯 칸. 이게 없으면 USDⓈ-M 화면이다.
      'CONTRACT_COUNT', 'CONTRACT_MULTIPLIER', 'COLLATERAL_COIN',
      'CONVERTED_BASE_QTY', 'PNL_UNIT',
      'POSITIONS', 'OPEN_ORDERS',
    ],
    fromShared: [],
    never: [
      'BUY_SELL', 'QTY_TOTAL_TOGGLE', 'ORDERABLE_CASH', 'AMEND_CANCEL',
      'SESSION_INFO', 'HELD_QTY', 'AVG_COST',
    ],
  },
  {
    market: 'STOCK',
    root: 'stock-trading-screen',
    file: `${DIR}/StockTradingScreen.tsx`,
    own: [
      'ORDER_BOOK', 'BUY_SELL', 'AMEND_CANCEL', 'ORDERABLE_CASH',
      'TOTAL_ORDER_AMOUNT', 'HELD_QTY', 'AVG_COST', 'EVAL_PNL',
      'OPEN_ORDERS', 'FILLS', 'SESSION_INFO',
    ],
    fromShared: [],
    // ★ 주식 화면에 선물 개념이 새어 들어가면 사용자는 레버리지가 있는
    //   줄 안다. 이 목록이 이 파일에서 가장 중요하다.
    never: [
      'LEVERAGE', 'MARGIN_MODE', 'FUNDING', 'LIQUIDATION_PRICE',
      'LIQUIDATION_DISTANCE', 'REDUCE_ONLY', 'LONG_SHORT', 'OPEN_CLOSE',
      'MARK_PRICE', 'TP_SL', 'CONTRACT_COUNT', 'CONTRACT_MULTIPLIER',
      'COLLATERAL_COIN', 'CONVERTED_BASE_QTY', 'PNL_UNIT', 'POSITIONS',
    ],
  },
];

export function screenContract(m: MarketType): MarketScreenContract {
  const c = MARKET_SCREENS.find(s => s.market === m);
  // 모르는 시장에 기본 화면을 주지 않는다. 기본값을 주면 COIN-M이
  // USDⓈ-M 화면을 받고, 그 화면은 계약 수를 코인 개수로 읽는다.
  if (!c) throw new Error(`거래 화면 계약이 없는 시장입니다: ${String(m)}`);
  return c;
}

/**
 * 공용 부품이 시장 전용 칸을 무조건 그리면 의미가 섞인다.
 *
 * 그렇다고 공용 부품이 시장 칸을 **하나도** 못 그리게 하면 부품을 네 벌
 * 만들게 된다 — 그게 2번 고장이다. 그래서 규칙은 "그리지 마라"가 아니라
 * **"능력표에 물어보고 그려라"**다.
 *
 * 여기 적힌 부품은 시장 전용 칸을 그려도 되지만, 반드시 능력표
 * (`form.caps` · `capability(market)` · `unsupported()`)로 가려야 한다.
 */
export const SHARED_GATED_COMPONENTS: string[] = [
  'src/components/trading/OrderControls.tsx',
];

/** 시장 의미를 **한 글자도** 들면 안 되는 순수 공용 껍데기 */
export const SHARED_NEUTRAL_COMPONENTS: string[] = [
  `${DIR}/TradingScreenShell.tsx`,
  `${DIR}/ChartDrawer.tsx`,
];
