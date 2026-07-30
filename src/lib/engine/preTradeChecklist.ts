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
  | 'MARGIN_SUFFICIENT';

export interface CheckSpec {
  id: CheckId;
  label: string;
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
export const CHECK_SPECS: CheckSpec[] = [
  { id: 'MODE',                 label: '운영 모드가 주문을 허용',      blocking: true,  requiredToKnow: true },
  { id: 'CLOCK_SKEW',           label: '시계가 거래소와 일치',         blocking: true,  requiredToKnow: true },
  { id: 'STATE_RECONCILE',      label: '거래소와 앱 상태 일치',        blocking: true,  requiredToKnow: true },
  { id: 'UNRESOLVED_ORDERS',    label: '결과 미확정 주문 없음',        blocking: true,  requiredToKnow: true },
  { id: 'MARGIN_ISOLATED',      label: '마진 모드 ISOLATED',           blocking: true,  requiredToKnow: true },
  { id: 'STOP_ATTACHED',        label: '손절이 붙어 있음',             blocking: true,  requiredToKnow: true },
  { id: 'LIQUIDATION_DISTANCE', label: '손절이 청산보다 먼저',         blocking: true,  requiredToKnow: true },
  { id: 'MARGIN_SUFFICIENT',    label: '증거금 충분',                  blocking: true,  requiredToKnow: true },
  { id: 'TODAY_ENTRY',          label: '오늘 진입 이력',               blocking: true,  requiredToKnow: false },
  { id: 'LEVERAGE',             label: '배율이 의도와 같음',           blocking: false, requiredToKnow: false },
  { id: 'EXISTING_POSITION',    label: '기존 포지션',                  blocking: false, requiredToKnow: false },
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
  /** 계획된 손절가. 없으면 손절이 안 붙은 것 */
  stopPrice?: number | null;
  liquidationPrice?: number | null;
  side?: 'LONG' | 'SHORT' | null;
  margin?: { required: number | null; available: number | null } | null;
}

export interface ChecklistVerdict {
  /** 주문을 보내도 되는가 */
  allowed: boolean;
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

/** 전체 체크리스트를 돌린다. 순수 함수 — 네트워크를 타지 않는다 */
export function runChecklist(input: ChecklistInput): ChecklistVerdict {
  const results: CheckResult[] = [];

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
  if (!input.todayEntry) {
    results.push(resultFor('TODAY_ENTRY', 'unknown', '오늘 진입 이력을 확인하지 못했습니다'));
  } else if (input.todayEntry.alreadyTraded) {
    results.push(resultFor('TODAY_ENTRY', 'fail',
      input.todayEntry.detail || '오늘 이미 진입했습니다 — 이 전략은 하루 최대 1회입니다'));
  } else {
    results.push(resultFor('TODAY_ENTRY', 'pass', '오늘 진입 없음'));
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

  const blockers = results.filter(r => r.blocks);
  const passed = results.filter(r => r.status === 'pass').length;
  const unknownCount = results.filter(r => r.status === 'unknown').length;

  return {
    allowed: blockers.length === 0,
    results,
    blockers,
    passed,
    total: results.length,
    unknownCount,
    // 확인하지 못한 항목 수를 요약에 넣는다. "9/11 통과"만 적으면 나머지 2개가
    // 실패인지 확인 불가인지 알 수 없고, 둘은 대응이 완전히 다르다.
    summary: blockers.length === 0
      ? (unknownCount > 0
          ? `${passed}/${results.length} 통과 · 확인 못 한 항목 ${unknownCount}개 (막지 않는 항목)`
          : `${passed}/${results.length} 통과`)
      : `${blockers.length}개 항목이 주문을 막습니다: ${blockers.map(b => b.label).join(', ')}`,
  };
}
