// src/lib/engine/preTradeChecklist.ts
//
// 주문을 보내기 **전에** 확인하는 목록.
//
// 왜 새로 만드는가 — 검사가 없어서가 아니다
// ─────────────────────────────────────────
// 검사는 이미 있다. 운영 모드(operatingMode), 상태 대조(stateReconcile),
// 위험 계산(riskManager), 하루 1회 제한(ladderGate), 포지션 보호
// (positionGuard). 문제는 **흩어져 있다는 것**이다. 주문 경로가 그것들을
// 순서대로 부르고 각자 다른 모양의 실패를 돌려주므로,
//   · 화면은 "왜 주문이 안 나갔는지"를 한 곳에서 말할 수 없고
//   · 검사 하나를 빼먹었는지 아닌지 아무도 확인할 수 없다
// 이 파일은 검사를 다시 구현하지 않는다. 결과를 받아 **하나의 목록**으로
// 만들고, 통과 여부를 한 번에 판정한다.
//
// ─────────────────────────────────────────────────────────────
// 이 파일의 핵심 규칙: 확인하지 못한 것은 통과가 아니다
// ─────────────────────────────────────────────────────────────
// 체크리스트에서 가장 위험한 실패는 빨간 X가 아니다. **확인하지 못한 항목을
// 초록색으로 그리는 것**이다. 거래소 조회가 실패해서 마진 모드를 못 읽었는데
// 화면에 "6/6 확인"이 뜨면, 사용자는 점검이 끝났다고 믿고 주문을 넣는다.
// 그래서 `unknown`은 별도 상태이고, 필수 항목이 `unknown`이면 **막는다.**
//
// 확인하지 못한 것을 초록으로 그리는 체크리스트는 없는 것보다 나쁘다 —
// 없으면 사람이 직접 보지만, 있으면 안 본다.

export type CheckStatus =
  /** 확인했고 문제없다 */
  | 'pass'
  /** 확인했고 문제가 있다 */
  | 'fail'
  /** 확인했고 알아야 할 것이 있지만 막을 정도는 아니다 */
  | 'warn'
  /** **확인하지 못했다.** pass가 아니다 */
  | 'unknown';

export type CheckId =
  /** 운영 모드가 주문을 허용하는가 (가장 바깥 관문) */
  | 'MODE'
  /** 로컬 시계가 거래소와 맞는가 */
  | 'CLOCK_SKEW'
  /** 거래소와 앱의 상태가 일치하는가 */
  | 'STATE_RECONCILE'
  /** 결과를 모르는 주문이 남아 있지 않은가 */
  | 'UNRESOLVED_ORDERS'
  /** 마진 모드가 ISOLATED인가 */
  | 'MARGIN_ISOLATED'
  /** 거래소 배율이 의도와 같은가 */
  | 'LEVERAGE'
  /** 이미 열린 포지션이 있는가 */
  | 'EXISTING_POSITION'
  /** 오늘 이미 진입했는가 */
  | 'TODAY_ENTRY'
  /** 손절이 계획에 붙어 있는가 */
  | 'STOP_ATTACHED'
  /** 손절이 청산보다 먼저 닿는가 */
  | 'LIQUIDATION_DISTANCE'
  /** 증거금이 충분한가 */
  | 'MARGIN_SUFFICIENT'
  /** 오늘 잃은 금액이 한도 안인가 */
  | 'DAILY_LOSS_LIMIT'
  /** 이번 주 잃은 금액이 한도 안인가 */
  | 'WEEKLY_LOSS_LIMIT'
  /** 연속 손절로 잠겨 있지 않은가 */
  | 'LOSS_STREAK'
  /** 지금 시장 국면이 이 방향의 진입에 맞는가 */
  | 'REGIME_FILTER'
  /** AI 합의가 이 방향을 강하게 반대하는가 (거부권만, 진입은 못 만든다) */
  | 'AI_VETO'
  /** 이 주문이 배정한 가상 서브계좌 한도 안인가 */
  | 'SUBACCOUNT_LIMIT'
  /** 지금 이 시장이 열려 있는가 (주식 전용 — 코인은 24시간이다) */
  | 'MARKET_HOURS';

/**
 * 어느 시장의 주문인가.
 *
 * 이 구분이 없으면 현물 주문이 전부 막힌다. 현물에는 마진 모드도 청산가도
 * 레버리지도 **존재하지 않는데**, 선물 체크리스트를 그대로 물리면 그 항목들이
 * `unknown`으로 잡혀 필수 항목 차단에 걸린다.
 *
 * 없는 것을 `pass`로 적는 것도 답이 아니다 — 현물 주문에 "마진 모드
 * ISOLATED ✓"가 뜨면 그건 확인한 것도 아니고 사실도 아니다. 해당 없는 검사는
 * **목록에서 빼는 것**이 맞다.
 */
export type MarketKind = 'SPOT' | 'USDM' | 'COINM' | 'STOCK';

/**
 * 들어가는 주문인가 나오는 주문인가.
 *
 * 청산(reduceOnly)에 진입 검사를 물리면 **나갈 수 없게 된다.** CROSS 포지션을
 * 정리하려는데 "마진 모드가 ISOLATED가 아닙니다"로 막히고, 손절을 안 붙였다고
 * 막히고, 증거금이 부족하다고 막힌다 — 청산은 증거금을 **돌려주는** 동작이다.
 *
 * 커맨드 레지스트리의 `reducing`과 같은 생각이다: 위험을 줄이는 방향은
 * 늘리는 방향과 다르게 다뤄야 한다.
 */
export type OrderIntent = 'ENTRY' | 'EXIT';

export interface CheckSpec {
  id: CheckId;
  label: string;
  /** 이 시장에서 의미가 있는 검사인가 */
  markets: MarketKind[];
  /** 진입·청산 중 어디서 의미가 있는가 */
  intents: OrderIntent[];
  /**
   * `fail`이면 주문을 막는가.
   *
   * 전부 막지 않는 이유: 이미 포지션이 있다는 것은 사실 전달이고, 추가
   * 진입이 잘못이라고 단정할 수 없다. 막을 것과 알릴 것을 섞으면 사용자는
   * 곧 전부 무시하게 된다.
   */
  blocking: boolean;
  /**
   * `unknown`이면 주문을 막는가.
   *
   * 막는 항목이 곧 "이건 모르고 넘어갈 수 없다"는 선언이다. 마진 모드를
   * 못 읽은 채로 100배 주문을 넣는 것과, 오늘 진입 여부를 못 읽은 것은
   * 무게가 다르다.
   */
  requiredToKnow: boolean;
}

/**
 * 검사 목록과 순서.
 *
 * 순서는 **바깥 관문부터**다. 모드가 막으면 나머지는 볼 필요가 없고,
 * 시계가 틀리면 거래소 응답 자체를 신뢰할 수 없다.
 */
const ALL_MARKETS: MarketKind[] = ['SPOT', 'USDM', 'COINM', 'STOCK'];
/**
 * 주식만.
 *
 * 주식 현물에는 청산도 마진 모드도 레버리지도 **존재하지 않는다.**
 * 없는 것을 pass로 적으면 "청산가 확인 ✓"가 뜨는데 그건 확인한 것도
 * 아니고 사실도 아니다. 해당 없는 검사는 목록에서 뺀다 — 현물에서
 * 이미 쓰고 있는 규칙과 같다.
 *
 * 대신 주식에는 코인에 없는 관문이 하나 있다: **장이 열려 있는가.**
 */
const STOCK_ONLY: MarketKind[] = ['STOCK'];
/** 파생 시장. 마진·청산·배율이 존재하는 곳 */
const DERIV: MarketKind[] = ['USDM', 'COINM'];
const BOTH: OrderIntent[] = ['ENTRY', 'EXIT'];
const ENTRY_ONLY: OrderIntent[] = ['ENTRY'];

export const CHECK_SPECS: CheckSpec[] = [
  // 어느 시장·어느 방향이든 본다. 모드는 가장 바깥 관문이고, 시계는 서명
  // 요청 자체의 전제다 — 청산도 서명 요청이라 시계가 틀리면 못 나간다.
  { id: 'MODE',       label: '운영 모드가 주문을 허용', markets: ALL_MARKETS, intents: BOTH,
    blocking: true, requiredToKnow: true },
  { id: 'CLOCK_SKEW', label: '시계가 거래소와 일치',    markets: ALL_MARKETS, intents: BOTH,
    blocking: true, requiredToKnow: true },

  // 상태 대조는 USDⓈ-M만이다. gatherAndReconcile이 읽는 것은 선물 포지션
  // (getFuturesPositions)이라, 현물이나 COIN-M 주문에 그 판정을 물리면
  // **다른 시장의 상태로 이 시장의 주문을 막는다.** 없는 검사를 있는 것처럼
  // 두는 것보다, 해당 시장에서 빼는 것이 정직하다.
  { id: 'STATE_RECONCILE',   label: '거래소와 앱 상태 일치', markets: ['USDM'], intents: BOTH,
    blocking: true, requiredToKnow: true },

  // 미확정 주문은 live_orders 기준이라 파생 경로에만 있다.
  // 청산에는 물리지 않는다 — 나가려는데 막히면 그게 더 위험하고, reduceOnly는
  // 최악의 경우 아무 일도 안 하는 주문이 된다(포지션을 뒤집지 못한다).
  { id: 'UNRESOLVED_ORDERS', label: '결과 미확정 주문 없음', markets: DERIV, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // 파생 + 진입에서만. CROSS 포지션을 정리하려는데 "ISOLATED가 아닙니다"로
  // 막으면 나갈 방법이 없어진다.
  { id: 'MARGIN_ISOLATED',      label: '마진 모드 ISOLATED', markets: DERIV, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },
  // 이 둘은 **손절이 존재하는 것을 전제**한다.
  //
  // 한동안 `markets: ['USDM']`이었다. COIN-M 주문 경로가 손절을 붙이지 않아서,
  // 물리면 모든 COIN-M 주문이 차단됐기 때문이다 — 면제가 아니라 못 고친 위험의
  // 표시였다. 이제 `api/binance/coinm/order`가 손절을 붙이고 실패하면 포지션을
  // 되돌리므로, 두 검사를 COIN-M에도 물린다.
  //
  // 현물에는 여전히 없다. 현물에는 청산이 없고 손절도 별도 주문이라, 없는 것을
  // 검사 목록에 두면 그 항목은 영원히 unknown이 된다.
  { id: 'STOP_ATTACHED',        label: '손절이 붙어 있음',   markets: DERIV, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },
  { id: 'LIQUIDATION_DISTANCE', label: '손절이 청산보다 먼저', markets: DERIV, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // 증거금은 파생에만 둔다. 청산은 증거금을 돌려주는 동작이라 보지 않는다.
  //
  // 현물에서 뺀 이유가 두 개다:
  //  1. 시장가+수량 주문은 체결가를 모르므로 필요 금액을 계산할 수 없다.
  //     시세를 추측해 채우면 `required: 0`이나 추측값으로 판정하게 되고,
  //     그건 **껍데기 통과**다 — 이 파일이 막으려는 바로 그 실패다
  //  2. 현물 자금 부족은 거래소가 주문을 통째로 거부한다. 선물처럼 일부만
  //     체결되어 어중간한 포지션이 남는 실패가 없다
  { id: 'MARGIN_SUFFICIENT', label: '증거금 충분', markets: [...DERIV, 'STOCK'], intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // **장이 열려 있는가.** 주식에만 있는 관문이다.
  //
  // 코인은 24시간이라 지금까지 이 질문을 한 코드가 없었다. 주식에서
  // 그대로 두면 크론이 새벽 3시에 주문을 내고, 증권사는 그걸 거부하거나
  // 다음 영업일 예약주문으로 받는다. **둘 다 화면에는 에러로 안 뜬다** —
  // 전략은 진입했다고 믿고 손절 감시를 시작하는데 포지션은 없다.
  //
  // 청산(EXIT)에도 건다. 장외에 파는 것도 안 되기 때문이다. 다른 검사들과
  // 달리 여기서는 '나가는 길을 막는다'가 문제가 아니다 — 애초에 시장이
  // 닫혀 있어서 나갈 수가 없고, 그 사실을 알려 주는 쪽이 낫다.
  { id: 'MARKET_HOURS', label: '장이 열려 있음', markets: STOCK_ONLY, intents: BOTH,
    blocking: true, requiredToKnow: true },

  // 오늘 얼마를 잃었는가. **진입에만** 건다 —
  // 한도에 걸렸다고 나갈 수 없게 만들면 그건 손실을 키우는 잠금이다.
  //
  // 모든 시장에 건다. 한도는 계좌 단위이지 시장 단위가 아니다 — 선물에서
  // 한도를 채운 뒤 현물로 옮겨 계속하면 잠근 의미가 없다.
  { id: 'DAILY_LOSS_LIMIT', label: '오늘 손실 한도', markets: ALL_MARKETS, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // 주간 한도. **하루 한도가 못 보는 자리다** — 매일 −2.9%씩 닷새면 하루
  // 잠금은 한 번도 안 걸리는데 한 주에 −14%다.
  { id: 'WEEKLY_LOSS_LIMIT', label: '이번 주 손실 한도', markets: ALL_MARKETS, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // 연패 잠금. 다섯 번 연속 손절은 '운이 나빴다'일 수도 있지만, 전략이
  // 지금 시장과 안 맞는다는 신호일 때가 더 많다.
  { id: 'LOSS_STREAK', label: '연속 손절', markets: ALL_MARKETS, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // 시장 국면. **필터를 켠 경우에만** 목록에 나온다 (옵션 regimeFilter).
  //
  // 왜 옵션인가: 이 검사는 피해 크기를 제한하는 것이 아니라 **어떤 거래를
  // 할지 자체를 바꾼다.** 사용자가 만들어 둔 전략의 신호를 조용히 거부하기
  // 시작하면 그건 다른 전략이 된다. 켜는 것은 명시적 선택이어야 하고,
  // 켜지 않았으면 '확인 못 함'으로 남겨서도 안 된다.
  { id: 'REGIME_FILTER', label: '시장 국면 적합', markets: ALL_MARKETS, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // AI 거부권. **켠 경우에만** 목록에 나온다 (옵션 aiVeto).
  //
  // 국면 필터와 같은 이유로 옵션이다 — 어떤 거래를 할지 자체를 바꾼다.
  //
  // requiredToKnow가 true인 이유: judgeAiVeto가 판단하지 못한 경우를
  // 'abstain'(warn)으로 돌려주므로 평소에는 여기 걸리지 않는다. strict를
  // 켠 사람만 'unknown'을 받고 막힌다. 즉 "AI를 못 불렀으면 멈춘다"를
  // 고른 사람에게만 적용된다 — 기본값으로 AI 장애가 매매 장애가 되지 않는다.
  { id: 'AI_VETO', label: 'AI 합의 거부권', markets: ALL_MARKETS, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // 가상 서브계좌 한도.
  //
  // 배분표(portfolio/allocation)가 "성장 600만 · 안정 250만"을 그려주는데
  // 지금까지 **주문이 그 숫자를 보지 않았다.** 계산만 하고 안 막는 안전장치는
  // 없는 것보다 나쁘다 — 있다고 믿으면 사람이 직접 안 센다.
  //
  // 바구니를 안 만들었으면 판정이 'ok'로 나오므로(subAccount.ts) 쓰지 않는
  // 사람에게는 아무 일도 일어나지 않는다. 그래서 옵션이 아니라 항상 건다.
  //
  // 진입에만 건다. 한도를 넘었다고 못 나가게 하면 그건 손실을 키우는 잠금이다.
  { id: 'SUBACCOUNT_LIMIT', label: '서브계좌 한도', markets: ALL_MARKETS, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: true },

  // 하루 1회 제한이 있는 전략에서만 (옵션 dailyLimit). 수동 주문에는
  // 그런 제한이 없어서, 켜지 않으면 목록에 나오지 않는다.
  { id: 'TODAY_ENTRY', label: '오늘 진입 이력', markets: ALL_MARKETS, intents: ENTRY_ONLY,
    blocking: true, requiredToKnow: false },

  // 막지 않는 항목
  { id: 'LEVERAGE',          label: '배율이 의도와 같음', markets: DERIV, intents: ENTRY_ONLY,
    blocking: false, requiredToKnow: false },
  { id: 'EXISTING_POSITION', label: '기존 포지션',        markets: DERIV, intents: BOTH,
    blocking: false, requiredToKnow: false },
];

const SPEC_BY_ID: Record<CheckId, CheckSpec> =
  CHECK_SPECS.reduce((acc, s) => { acc[s.id] = s; return acc; }, {} as Record<CheckId, CheckSpec>);

export interface CheckResult {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** 사용자에게 보여줄 한 줄. 통과일 때도 근거를 적는다 */
  detail: string;
  /** 이 항목 때문에 주문이 막히는가 */
  blocks: boolean;
}

// ── 개별 검사 ────────────────────────────────────────────────

/**
 * 시계 오차.
 *
 * 바이낸스는 요청에 timestamp를 요구하고 `recvWindow`(이 프로젝트는 5000ms)
 * 밖의 요청을 -1021로 거절한다. 지금 이 실패는 주문을 보낸 **뒤에** 알게
 * 되고, 화면에는 그냥 '주문 실패'로 보인다. 원인이 시계라는 것을 알 방법이
 * 없다 — 그래서 보내기 전에 본다.
 *
 * 여유를 60%로 잡는 이유: recvWindow는 timestamp부터 거래소 도착까지의
 * 예산이다. 왕복 지연이 그 안에서 같이 소모되므로, 오차가 이미 4.9/5.0초면
 * 실제로는 매번 실패한다. 경계에 붙은 값을 통과로 적으면 "가끔 실패하는"
 * 상태가 되고, 그건 원인을 찾기 가장 어려운 모양이다.
 */
export function checkClockSkew(
  localMs: number | null | undefined,
  serverMs: number | null | undefined,
  recvWindowMs = 5000,
  safetyRatio = 0.6,
): CheckResult {
  const spec = SPEC_BY_ID.CLOCK_SKEW;
  const base = { id: spec.id, label: spec.label };

  if (localMs == null || serverMs == null
      || !Number.isFinite(localMs) || !Number.isFinite(serverMs)) {
    return { ...base, status: 'unknown', blocks: true,
      detail: '거래소 서버 시각을 읽지 못했습니다 — 시계 오차를 확인할 수 없습니다' };
  }

  const skew = localMs - serverMs;
  const abs = Math.abs(skew);
  const limit = recvWindowMs * safetyRatio;

  if (abs > limit) {
    return { ...base, status: 'fail', blocks: true,
      detail: `시계가 ${skew > 0 ? '앞서' : '뒤처져'} 있습니다 (${abs}ms, 허용 ${Math.round(limit)}ms). `
        + '이 상태로 주문하면 거래소가 -1021로 거절합니다' };
  }
  return { ...base, status: 'pass', blocks: false,
    detail: `오차 ${abs}ms (허용 ${Math.round(limit)}ms)` };
}

/** 마진 모드 */
export function checkMarginIsolated(marginType: string | null | undefined): CheckResult {
  const spec = SPEC_BY_ID.MARGIN_ISOLATED;
  const base = { id: spec.id, label: spec.label };

  if (marginType == null || String(marginType).trim() === '') {
    // positionGuard가 같은 판단을 하지만 거기는 '이미 열린 포지션'을 본다.
    // 여기는 주문 전이라 아직 포지션이 없을 수 있고, 그때도 거래소의 심볼별
    // 마진 모드는 읽을 수 있다. 못 읽었으면 모르는 것이다.
    return { ...base, status: 'unknown', blocks: true,
      detail: '마진 모드를 읽지 못했습니다 — CROSS인지 확인할 수 없습니다' };
  }
  if (String(marginType).toLowerCase() !== 'isolated') {
    return { ...base, status: 'fail', blocks: true,
      detail: `${marginType} 입니다. ISOLATED가 아니면 한 종목의 손실이 계좌 전체로 번집니다` };
  }
  return { ...base, status: 'pass', blocks: false, detail: 'ISOLATED' };
}

/**
 * 손절이 청산보다 먼저 닿는가.
 *
 * riskManager가 주문 계획을 만들 때 같은 것을 보지만(LIQUIDATION_BEFORE_STOP),
 * 그건 계획 단계의 계산이다. 여기서 다시 보는 이유는 거래소가 알려준 실제
 * 청산가로 확인하기 위해서다 — 배율이나 증거금이 계획과 다르면 청산가도
 * 달라진다.
 *
 * 방향이 중요하다. LONG은 가격이 내려갈 때, SHORT는 올라갈 때 청산된다.
 * 부호를 잘못 보면 가장 위험한 주문이 통과한다.
 */
export function checkLiquidationDistance(input: {
  side?: 'LONG' | 'SHORT' | null;
  stopPrice?: number | null;
  liquidationPrice?: number | null;
}): CheckResult {
  const spec = SPEC_BY_ID.LIQUIDATION_DISTANCE;
  const base = { id: spec.id, label: spec.label };
  const { side, stopPrice, liquidationPrice } = input;

  if (!side || stopPrice == null || liquidationPrice == null
      || !Number.isFinite(stopPrice) || !Number.isFinite(liquidationPrice)
      || stopPrice <= 0 || liquidationPrice <= 0) {
    return { ...base, status: 'unknown', blocks: true,
      detail: '손절가 또는 청산가를 확인할 수 없습니다' };
  }

  // LONG: 손절이 청산보다 **위**여야 한다 (청산에 닿기 전에 손절이 먼저)
  // SHORT: 손절이 청산보다 **아래**여야 한다
  const safe = side === 'LONG' ? stopPrice > liquidationPrice : stopPrice < liquidationPrice;
  if (!safe) {
    return { ...base, status: 'fail', blocks: true,
      detail: `${side} 손절 ${stopPrice} / 청산 ${liquidationPrice} — 손절보다 청산이 먼저 닿습니다. `
        + '손절은 작동할 기회가 없고 증거금 전액이 사라집니다' };
  }
  const gapPct = Math.abs(stopPrice - liquidationPrice) / stopPrice * 100;
  return { ...base, status: 'pass', blocks: false,
    detail: `손절 ${stopPrice} · 청산 ${liquidationPrice} (여유 ${gapPct.toFixed(2)}%)` };
}

// ── 조립 ─────────────────────────────────────────────────────

/**
 * 각 검사에 넣을 사실들.
 *
 * `null`/`undefined`는 전부 **"확인하지 못했다"**는 뜻이다. 기본값을 두지
 * 않는 것이 이 타입의 요점이다 — 예를 들어 marginType의 기본값을
 * 'isolated'로 두면, 조회 실패가 통과로 바뀐다.
 */
export interface ChecklistInput {
  /** operatingMode.gateOrder 결과 */
  mode?: { disposition: 'SEND' | 'RECORD' | 'BLOCK'; reason?: string } | null;
  clock?: { localMs: number; serverMs: number; recvWindowMs?: number } | null;
  /** stateReconcile / reconcileCheck 결과 */
  reconcile?: { reachable: boolean; blockNewOrders: boolean; summary?: string } | null;
  unresolvedOrderCount?: number | null;
  marginType?: string | null;
  leverage?: { actual: number | null; intended: number | null } | null;
  /** 지금 열려 있는 포지션 수량. 0이면 없음, null이면 모름 */
  existingPositionQty?: number | null;
  /** ladderGate 결과 */
  todayEntry?: { alreadyTraded: boolean; detail?: string } | null;
  /**
   * 오늘 손실 한도 판정 (risk/dailyLoss의 judgeDailyLoss 결과).
   *
   * 넘기지 않으면 `unknown`이고, 필수 항목이라 진입이 막힌다. 한도를 안
   * 걸어 둔 계정도 judgeDailyLoss가 'ok'를 돌려주므로 그대로 넘기면 된다 —
   * '검사를 안 건 것'과 '확인에 실패한 것'은 다르고, 그 구분을 여기서
   * 지우면 안 된다.
   */
  dailyLoss?: { status: 'ok' | 'locked' | 'unknown'; reason: string } | null;
  /**
   * 이번 주 손실 한도 판정 (risk/lossStreak의 judgeWeeklyLoss 결과).
   * 하루 한도와 같은 규칙: null이면 '확인 못 함'이고 진입이 막힌다.
   */
  weeklyLoss?: { status: 'ok' | 'locked' | 'unknown'; reason: string } | null;
  /** 연패 잠금 판정 (risk/lossStreak의 judgeLossStreak 결과) */
  lossStreak?: { status: 'ok' | 'locked' | 'unknown'; reason: string } | null;
  /**
   * 시장 국면 판정 (risk/regimeGate의 judgeRegime 결과).
   *
   * `opts.regimeFilter`를 켰는데 이 값이 없으면 `unknown`이고 막힌다 —
   * 필터를 켠 채로 국면을 못 본 것은 필터가 없는 것과 같다.
   */
  regime?: { status: 'ok' | 'blocked' | 'unknown'; reason: string } | null;
  /**
   * AI 합의 거부권 판정 (ai/tradeVeto의 judgeAiVeto 결과).
   *
   * 'abstain'은 **막지 않는다.** AI를 못 부른 것은 손실 한도를 못 읽은 것과
   * 다르다 — 한쪽은 안전장치이고 한쪽은 덧댄 의견이다. AI 장애가 매매
   * 장애가 되면 그 순간 AI를 안전장치로 쓴 것이 된다.
   *
   * 그렇다고 통과로도 적지 않는다. 'abstain'은 warn으로 화면에 남는다.
   */
  aiVeto?: { status: 'ok' | 'blocked' | 'abstain' | 'unknown'; reason: string } | null;
  /**
   * 가상 서브계좌 한도 판정 (portfolio/subAccount의 judgeSubAccount 결과).
   *
   * 넘기지 않으면 `unknown`이고 진입이 막힌다. 손실 한도와 같은 규칙이다 —
   * 사용자가 "600만 원까지"라고 정해 둔 것이 조회 실패 한 번으로 무제한이
   * 되면 안 된다. 바구니를 안 만든 사람은 judgeSubAccount가 'ok'를
   * 돌려주므로 그대로 넘기면 된다.
   */
  subAccount?: { status: 'ok' | 'over' | 'unassigned' | 'unknown'; reason: string } | null;
  /** 계획된 손절가. 없으면 손절이 안 붙은 것 */
  stopPrice?: number | null;
  liquidationPrice?: number | null;
  side?: 'LONG' | 'SHORT' | null;
  margin?: { required: number | null; available: number | null } | null;
  /**
   * 장 시간 판정 (주식 전용).
   *
   * `marketPhase()`의 결과를 그대로 넣는다. 여기서 다시 판정하지 않는
   * 이유는 늘 같다 — 규칙이 두 벌이 되면 화면이 말하는 것과 실제로
   * 주문을 막는 것이 갈린다.
   *
   * **넣지 않으면 'unknown'이고, 그건 막는다.** 주식 주문 경로가 이
   * 값을 안 넘기는 상태로 배포되면 그 사실이 바로 드러나야 한다.
   */
  marketHours?: {
    canOrder: boolean;
    reason: string;
    /** 휴장일 목록을 들고 있었는가 */
    holidaysKnown?: boolean;
  } | null;
}

export interface ChecklistOptions {
  /** 기본 'USDM' — 기존 호출자(daily-ladder)의 동작을 바꾸지 않는다 */
  market?: MarketKind;
  /** 기본 'ENTRY' */
  intent?: OrderIntent;
  /**
   * 하루 1회 제한이 있는 전략인가. 기본 false.
   *
   * 켜지 않으면 '오늘 진입 이력'이 목록에 아예 안 나온다. 수동 주문에는
   * 그런 제한이 없는데 "확인 못 함"으로 남겨 두면, 사용자는 확인해야 할
   * 것이 있다고 읽는다.
   */
  dailyLimit?: boolean;
  /**
   * 시장 국면 필터를 목록에 넣을 것인가.
   *
   * 켜지 않으면 REGIME_FILTER가 아예 빠진다 — 보지 않기로 한 검사를
   * '확인 못 함'으로 남기면 확인할 것이 있다고 읽힌다.
   */
  regimeFilter?: boolean;
  /**
   * AI 거부권을 목록에 넣을 것인가. 기본 false.
   *
   * 켜지 않으면 AI_VETO가 아예 빠진다. AI를 안 쓰기로 한 사람에게
   * '확인 못 함'으로 남기면 확인할 것이 있다고 읽힌다.
   */
  aiVeto?: boolean;
}

export interface ChecklistVerdict {
  /** 주문을 보내도 되는가 */
  allowed: boolean;
  /** 어떤 조건으로 판정했는가 — 응답만 보고도 알 수 있어야 한다 */
  market: MarketKind;
  intent: OrderIntent;
  results: CheckResult[];
  /** 막고 있는 항목들 */
  blockers: CheckResult[];
  /** 통과 / 전체 — 화면에 그대로 쓴다 */
  passed: number;
  total: number;
  /** 확인하지 못한 항목 수. 이 숫자를 화면에서 지우면 안 된다 */
  unknownCount: number;
  summary: string;
}

function resultFor(
  id: CheckId,
  status: CheckStatus,
  detail: string,
): CheckResult {
  const spec = SPEC_BY_ID[id];
  const blocks =
    (status === 'fail' && spec.blocking) ||
    (status === 'unknown' && spec.requiredToKnow);
  return { id, label: spec.label, status, detail, blocks };
}

/** 이 시장·이 방향에서 의미가 있는 검사인가 */
export function appliesTo(
  id: CheckId, market: MarketKind, intent: OrderIntent, dailyLimit: boolean,
  regimeFilter = false, aiVeto = false,
): boolean {
  const spec = SPEC_BY_ID[id];
  if (!spec) return false;
  if (id === 'TODAY_ENTRY' && !dailyLimit) return false;
  if (id === 'REGIME_FILTER' && !regimeFilter) return false;
  if (id === 'AI_VETO' && !aiVeto) return false;
  return spec.markets.includes(market) && spec.intents.includes(intent);
}

/**
 * 전체 체크리스트를 돌린다. 순수 함수 — 네트워크를 타지 않는다.
 *
 * 해당 없는 검사는 **목록에서 빠진다.** pass로 적지 않는다 — 현물 주문에
 * "마진 모드 ISOLATED ✓"가 뜨면 확인한 것도 아니고 사실도 아니다.
 */
export function runChecklist(
  input: ChecklistInput,
  opts: ChecklistOptions = {},
): ChecklistVerdict {
  const market = opts.market ?? 'USDM';
  const intent = opts.intent ?? 'ENTRY';
  const dailyLimit = opts.dailyLimit ?? false;
  const regimeFilter = opts.regimeFilter ?? false;
  const aiVeto = opts.aiVeto ?? false;

  const all: CheckResult[] = [];
  const results = all;   // 아래 push는 그대로 두고, 마지막에 걸러낸다

  // 1. 운영 모드 — 가장 바깥 관문
  if (!input.mode) {
    results.push(resultFor('MODE', 'unknown', '운영 모드를 확인하지 못했습니다'));
  } else if (input.mode.disposition === 'BLOCK') {
    results.push(resultFor('MODE', 'fail', input.mode.reason || '이 모드에서는 주문을 보내지 않습니다'));
  } else if (input.mode.disposition === 'RECORD') {
    // Shadow Live·모의는 정상 동작이다. 실패가 아니라 '보내지 않고 기록한다'는
    // 사실을 알려야 한다 — 이걸 pass로만 적으면 사용자는 실제로 주문이
    // 나갔다고 믿는다.
    results.push(resultFor('MODE', 'warn', (input.mode.reason || '기록만 합니다') + ' (거래소로 보내지 않습니다)'));
  } else {
    results.push(resultFor('MODE', 'pass', input.mode.reason || '주문을 보냅니다'));
  }

  // 2. 시계
  results.push(input.clock
    ? checkClockSkew(input.clock.localMs, input.clock.serverMs, input.clock.recvWindowMs ?? 5000)
    : checkClockSkew(null, null));

  // 3. 상태 대조
  if (!input.reconcile) {
    results.push(resultFor('STATE_RECONCILE', 'unknown', '상태 대조를 실행하지 못했습니다'));
  } else if (!input.reconcile.reachable) {
    results.push(resultFor('STATE_RECONCILE', 'unknown',
      input.reconcile.summary || '거래소 조회 실패 — 일치 여부를 알 수 없습니다'));
  } else if (input.reconcile.blockNewOrders) {
    results.push(resultFor('STATE_RECONCILE', 'fail',
      input.reconcile.summary || '거래소와 앱 상태에 심각한 불일치가 있습니다'));
  } else {
    results.push(resultFor('STATE_RECONCILE', 'pass', input.reconcile.summary || '일치'));
  }

  // 4. 미확정 주문
  if (input.unresolvedOrderCount == null) {
    results.push(resultFor('UNRESOLVED_ORDERS', 'unknown', '미확정 주문 수를 확인하지 못했습니다'));
  } else if (input.unresolvedOrderCount > 0) {
    results.push(resultFor('UNRESOLVED_ORDERS', 'fail',
      `결과를 모르는 주문 ${input.unresolvedOrderCount}건이 있습니다. `
      + '먼저 확정해야 합니다 — 그 주문이 체결되면 포지션이 지금과 달라집니다'));
  } else {
    results.push(resultFor('UNRESOLVED_ORDERS', 'pass', '없음'));
  }

  // 5. 마진 모드
  results.push(checkMarginIsolated(input.marginType));

  // 6. 손절 부착
  if (input.stopPrice == null) {
    results.push(resultFor('STOP_ATTACHED', 'fail',
      '손절가가 없습니다. 손절 없는 주문은 포지션 크기를 정당화할 근거가 없습니다'));
  } else if (!Number.isFinite(input.stopPrice) || input.stopPrice <= 0) {
    results.push(resultFor('STOP_ATTACHED', 'fail', `손절가가 올바르지 않습니다 (${input.stopPrice})`));
  } else {
    results.push(resultFor('STOP_ATTACHED', 'pass', `손절 ${input.stopPrice}`));
  }

  // 7. 청산 거리
  results.push(checkLiquidationDistance({
    side: input.side, stopPrice: input.stopPrice, liquidationPrice: input.liquidationPrice,
  }));

  // 8. 증거금
  if (!input.margin || input.margin.required == null || input.margin.available == null) {
    results.push(resultFor('MARGIN_SUFFICIENT', 'unknown', '증거금을 확인하지 못했습니다'));
  } else if (input.margin.required > input.margin.available) {
    results.push(resultFor('MARGIN_SUFFICIENT', 'fail',
      `필요 ${input.margin.required} / 가용 ${input.margin.available} — 부족합니다`));
  } else {
    results.push(resultFor('MARGIN_SUFFICIENT', 'pass',
      `필요 ${input.margin.required} / 가용 ${input.margin.available}`));
  }

  // 9. 오늘 진입
  // ── 시장 국면 ──
  if (!input.regime) {
    results.push(resultFor('REGIME_FILTER', 'unknown',
      '시장 국면을 확인하지 못했습니다 — 필터를 켠 채로 못 보면 필터가 없는 것과 같습니다'));
  } else if (input.regime.status === 'blocked') {
    results.push(resultFor('REGIME_FILTER', 'fail', input.regime.reason));
  } else if (input.regime.status === 'unknown') {
    results.push(resultFor('REGIME_FILTER', 'unknown', input.regime.reason));
  } else {
    results.push(resultFor('REGIME_FILTER', 'pass', input.regime.reason));
  }

  // ── 서브계좌 한도 ──
  if (!input.subAccount) {
    results.push(resultFor('SUBACCOUNT_LIMIT', 'unknown',
      '서브계좌 한도를 확인하지 못했습니다 — 정해 둔 한도가 있는지 알 수 없습니다'));
  } else if (input.subAccount.status === 'over' || input.subAccount.status === 'unassigned') {
    results.push(resultFor('SUBACCOUNT_LIMIT', 'fail', input.subAccount.reason));
  } else if (input.subAccount.status === 'unknown') {
    results.push(resultFor('SUBACCOUNT_LIMIT', 'unknown', input.subAccount.reason));
  } else {
    results.push(resultFor('SUBACCOUNT_LIMIT', 'pass', input.subAccount.reason));
  }

  // ── AI 거부권 ──
  //
  // 'abstain'을 pass로 적지 않는 이유: AI에게 못 물어봤는데 초록으로 그리면
  // 사용자는 AI가 확인해 줬다고 읽는다. 그렇다고 막지도 않는다 — 이건
  // 안전장치가 아니라 덧댄 의견이다. 그래서 warn이다.
  if (!input.aiVeto) {
    results.push(resultFor('AI_VETO', 'warn',
      'AI 합의를 받지 못했습니다 — AI 판단 없이 진행합니다'));
  } else if (input.aiVeto.status === 'blocked') {
    results.push(resultFor('AI_VETO', 'fail', input.aiVeto.reason));
  } else if (input.aiVeto.status === 'unknown') {
    results.push(resultFor('AI_VETO', 'unknown', input.aiVeto.reason));
  } else if (input.aiVeto.status === 'abstain') {
    results.push(resultFor('AI_VETO', 'warn', input.aiVeto.reason));
  } else {
    results.push(resultFor('AI_VETO', 'pass', input.aiVeto.reason));
  }

  // ── 오늘 손실 한도 ──
  if (!input.dailyLoss) {
    results.push(resultFor('DAILY_LOSS_LIMIT', 'unknown',
      '오늘 손실을 확인하지 못했습니다 — 한도를 넘었는지 알 수 없습니다'));
  } else if (input.dailyLoss.status === 'locked') {
    results.push(resultFor('DAILY_LOSS_LIMIT', 'fail', input.dailyLoss.reason));
  } else if (input.dailyLoss.status === 'unknown') {
    results.push(resultFor('DAILY_LOSS_LIMIT', 'unknown', input.dailyLoss.reason));
  } else {
    results.push(resultFor('DAILY_LOSS_LIMIT', 'pass', input.dailyLoss.reason));
  }

  // 주간 한도 · 연패 — 하루 한도와 **같은 규칙**으로 판정한다.
  // 셋이 서로 다른 규칙을 쓰면 어떤 잠금이 왜 걸렸는지 화면에서 못 읽는다.
  for (const [id, v] of [
    ['WEEKLY_LOSS_LIMIT', input.weeklyLoss],
    ['LOSS_STREAK', input.lossStreak],
  ] as const) {
    if (!v) {
      results.push(resultFor(id, 'unknown', '판정 결과를 받지 못했습니다'));
    } else if (v.status === 'locked') {
      results.push(resultFor(id, 'fail', v.reason));
    } else if (v.status === 'unknown') {
      results.push(resultFor(id, 'unknown', v.reason));
    } else {
      results.push(resultFor(id, 'pass', v.reason));
    }
  }

  if (!input.todayEntry) {
    results.push(resultFor('TODAY_ENTRY', 'unknown', '오늘 진입 이력을 확인하지 못했습니다'));
  } else if (input.todayEntry.alreadyTraded) {
    results.push(resultFor('TODAY_ENTRY', 'fail',
      input.todayEntry.detail || '오늘 이미 진입했습니다 — 이 전략은 하루 최대 1회입니다'));
  } else {
    results.push(resultFor('TODAY_ENTRY', 'pass', '오늘 진입 없음'));
  }

  // 장 시간 (주식 전용).
  //
  // **못 받았으면 통과가 아니다.** 주식 주문 경로가 이 값을 안 넘기면
  // 그 순간 모든 주식 주문이 막힌다 — 그게 맞다. 조용히 통과시키면
  // 새벽에 주문이 나가기 시작하고, 그건 아무도 안 본다.
  if (!input.marketHours) {
    results.push(resultFor('MARKET_HOURS', 'unknown', '장이 열려 있는지 확인하지 못했습니다'));
  } else if (!input.marketHours.canOrder) {
    results.push(resultFor('MARKET_HOURS', 'fail', input.marketHours.reason));
  } else {
    // 열려 있다. 다만 휴장일 목록이 없으면 그 사실을 같이 적는다 —
    // '열림'이라고만 적으면 설날에도 초록 체크가 뜬다.
    results.push(resultFor('MARKET_HOURS',
      input.marketHours.holidaysKnown === false ? 'warn' : 'pass',
      input.marketHours.reason));
  }

  // 10. 배율 (막지 않는다)
  if (!input.leverage || input.leverage.actual == null || input.leverage.intended == null) {
    results.push(resultFor('LEVERAGE', 'unknown', '배율을 확인하지 못했습니다'));
  } else if (input.leverage.actual !== input.leverage.intended) {
    results.push(resultFor('LEVERAGE', 'warn',
      `거래소 ${input.leverage.actual}배 / 의도 ${input.leverage.intended}배 — 주문 전에 맞추세요`));
  } else {
    results.push(resultFor('LEVERAGE', 'pass', `${input.leverage.actual}배`));
  }

  // 11. 기존 포지션 (막지 않는다 — 사실 전달)
  if (input.existingPositionQty == null) {
    results.push(resultFor('EXISTING_POSITION', 'unknown', '기존 포지션을 확인하지 못했습니다'));
  } else if (input.existingPositionQty !== 0) {
    results.push(resultFor('EXISTING_POSITION', 'warn',
      `이미 ${input.existingPositionQty} 보유 중입니다. 이 주문은 그 위에 얹힙니다`));
  } else {
    results.push(resultFor('EXISTING_POSITION', 'pass', '없음'));
  }

  // 여기서 걸러낸다. 위에서 조건마다 분기하면 검사 하나 추가할 때 적용
  // 규칙을 두 곳에 적게 되고, 언젠가 한 곳만 고친다.
  const scoped = all.filter(r => appliesTo(r.id, market, intent, dailyLimit, regimeFilter, aiVeto));

  const blockers = scoped.filter(r => r.blocks);
  const passed = scoped.filter(r => r.status === 'pass').length;
  const unknownCount = scoped.filter(r => r.status === 'unknown').length;

  return {
    allowed: blockers.length === 0,
    market,
    intent,
    results: scoped,
    blockers,
    passed,
    total: scoped.length,
    unknownCount,
    // 확인하지 못한 항목 수를 요약에 넣는다. "9/11 통과"만 적으면 나머지 2개가
    // 실패인지 확인 불가인지 알 수 없고, 둘은 대응이 완전히 다르다.
    summary: blockers.length === 0
      ? (unknownCount > 0
          ? `${passed}/${scoped.length} 통과 · 확인 못 한 항목 ${unknownCount}개 (막지 않는 항목)`
          : `${passed}/${scoped.length} 통과`)
      : `${blockers.length}개 항목이 주문을 막습니다: ${blockers.map(b => b.label).join(', ')}`,
  };
}
