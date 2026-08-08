// src/lib/engine/reconcilePlan.ts
//
// **대조할 것이 여러 개인데 버튼은 하나씩 흩어져 있었다.**
//
// 화면에는 이런 상태가 동시에 떠 있었다:
//
//   결과 미확정 주문 없음        ❌ (10건 남음)
//   앱의 미체결 주문 2건이 거래소에 없습니다
//   거래소 실제 5배 / TRAIGO 의도 49배
//   포지션 모드 확인 실패
//   손절이 청산보다 먼저          ?
//
// 이것들은 **순서가 있다.** 미확정 주문을 먼저 확정하지 않으면 나머지
// 대조가 전부 흔들린다 — 나갔는지 모르는 주문이 있는 상태에서 포지션을
// 비교하면, 그 차이가 미확정 때문인지 진짜 불일치인지 알 수 없다.
//
// 그래서 순서를 코드로 못 박는다
// ──────────────────────────────
// 사용자가 버튼을 순서대로 누르기를 기대하면 안 된다. 한 번 누르면
// 정해진 순서로 도는 것이 맞다.
//
// 이 파일은 **그 순서와 판정만** 정한다. 실제 조회는 라우트가 한다 —
// 순서를 화면 안에서 정하면 "왜 이 순서인가"를 테스트할 수 없다.
//
// 지우지 않는다
// ─────────────
// 앱에는 있는데 거래소에 없는 주문을 **그냥 지우면 안 된다.** 거래소에서
// 최종 상태(체결·취소·거부)를 받아 그것을 증거로 남기고 장부를 고친다.
// 지우는 것은 기록을 없애는 것이고, 그러면 "왜 이 주문이 사라졌지"를
// 나중에 아무도 답할 수 없다.

export type ReconcileStepId =
  | 'OPEN_ORDERS'
  | 'ORDER_HISTORY'
  | 'MATCH_UNKNOWN'
  | 'SETTLE_LOCAL_ONLY'
  | 'POSITIONS'
  | 'LEVERAGE'
  | 'POSITION_MODE'
  | 'LIQUIDATION'
  | 'PROTECTIVE_STOP'
  | 'BALANCE'
  | 'RECHECK';

export interface ReconcileStep {
  id: ReconcileStepId;
  label: string;
  /** 왜 이 자리인가 */
  why: string;
  /**
   * 이 단계가 실패하면 뒤를 이어서 할 수 있는가.
   *
   * **false면 멈춘다.** 미확정 주문을 못 푼 채로 포지션을 비교하면,
   * 차이가 미확정 때문인지 진짜 불일치인지 알 수 없다.
   */
  continueOnFail: boolean;
}

/**
 * 대조 순서.
 *
 * 주문 → 포지션 → 설정 → 재점검. **주문이 먼저인 것이 요점이다.**
 */
export const RECONCILE_STEPS: ReconcileStep[] = [
  { id: 'OPEN_ORDERS', label: '거래소 미체결 주문 조회',
    why: '지금 거래소에 살아 있는 주문이 무엇인지부터 안다', continueOnFail: false },
  { id: 'ORDER_HISTORY', label: '거래소 주문 이력 조회',
    why: '이미 끝난 주문의 최종 상태는 여기에만 있다', continueOnFail: false },
  { id: 'MATCH_UNKNOWN', label: '미확정 주문 대조',
    why: 'clientOrderId로 맞춰 UNKNOWN을 확정한다 — 이걸 안 풀면 뒤가 전부 흔들린다',
    continueOnFail: false },
  { id: 'SETTLE_LOCAL_ONLY', label: '앱에만 있는 주문 확정',
    why: '거래소가 준 최종 상태를 증거로 장부를 고친다 — 지우지 않는다',
    continueOnFail: false },
  { id: 'POSITIONS', label: '실제 포지션 조회',
    why: '주문이 확정된 뒤에야 포지션 비교가 뜻을 가진다', continueOnFail: false },
  { id: 'LEVERAGE', label: '실제 배율 조회',
    why: '의도한 배율이 실제로 걸렸는지 본다 — 화면 49배 / 거래소 5배가 여기서 잡힌다',
    continueOnFail: true },
  { id: 'POSITION_MODE', label: '포지션 모드 조회',
    why: '단방향인지 헤지인지 모르면 positionSide·reduceOnly가 틀린다', continueOnFail: true },
  { id: 'LIQUIDATION', label: '청산가 조회',
    why: '거래소가 준 값이 진실이다 — 우리 공식은 근사다', continueOnFail: true },
  { id: 'PROTECTIVE_STOP', label: '보호 주문 조회',
    why: '열린 포지션에 손절이 실제로 붙어 있는지 본다', continueOnFail: true },
  { id: 'BALANCE', label: '잔고·증거금 조회',
    why: '주문 크기를 정하는 값이다', continueOnFail: true },
  { id: 'RECHECK', label: '점검 다시 실행',
    why: '고친 뒤에 다시 봐야 무엇이 남았는지 안다', continueOnFail: true },
];

export type StepState = 'OK' | 'FAILED' | 'SKIPPED' | 'PENDING';

export interface StepResult {
  id: ReconcileStepId;
  state: StepState;
  /** 이 단계가 고친 건수 */
  fixed?: number | null;
  detail?: string;
}

export interface ReconcileRun {
  results: StepResult[];
  /** 끝까지 갔는가 */
  completed: boolean;
  /** 여기서 멈췄다 */
  stoppedAt: ReconcileStepId | null;
  /** 총 고친 건수. **못 읽은 단계가 있으면 null이다** */
  totalFixed: number | null;
  /** 남은 문제 */
  remaining: string[];
  summary: string;
}

const stepOf = (id: ReconcileStepId) => RECONCILE_STEPS.find(s => s.id === id);

/**
 * 실행 결과를 판정한다.
 *
 * **중간에 멈춘 것을 '완료'라고 하지 않는다.** 열한 단계 중 셋에서
 * 멈췄는데 '대조 완료'라고 적으면, 사용자는 장부가 맞았다고 믿는다.
 */
export function reconcileRunOf(results: StepResult[] | null | undefined): ReconcileRun {
  const list = Array.isArray(results) ? results : [];
  const byId = new Map(list.map(r => [r.id, r]));

  // 정의된 순서대로 채운다 — 넘겨받은 순서를 믿지 않는다.
  const ordered: StepResult[] = RECONCILE_STEPS.map(s =>
    byId.get(s.id) ?? { id: s.id, state: 'PENDING' as StepState });

  let stoppedAt: ReconcileStepId | null = null;
  for (const r of ordered) {
    if (r.state !== 'FAILED') continue;
    if (stepOf(r.id)?.continueOnFail === false) { stoppedAt = r.id; break; }
  }

  const ran = ordered.filter(r => r.state === 'OK' || r.state === 'FAILED');
  const failed = ordered.filter(r => r.state === 'FAILED');
  const pending = ordered.filter(r => r.state === 'PENDING');
  // **실패가 하나라도 있으면 완료가 아니다.** 이어서 할 수 있는 단계라도
  // 실패는 실패다 — '대조 완료'는 장부가 맞았다는 뜻으로 읽힌다.
  const completed = stoppedAt == null && pending.length === 0 && failed.length === 0;

  // **하나라도 못 읽었으면 합계를 내지 않는다.** 아홉 단계에서 고친
  // 건수만 더해 놓고 '총 12건 정리'라고 적으면, 못 돈 두 단계에 남은
  // 문제가 없다는 뜻으로 읽힌다.
  const totalFixed = failed.length === 0 && pending.length === 0
    ? ordered.reduce((s, r) => s + (Number(r.fixed) || 0), 0)
    : null;

  const remaining = [
    ...failed.map(r => `${stepOf(r.id)?.label ?? r.id}${r.detail ? ` — ${r.detail}` : ''}`),
    ...(pending.length > 0 && stoppedAt != null
      ? [`${pending.length}단계가 아직 안 돌았습니다 (앞 단계에서 멈춤)`] : []),
  ];

  let summary: string;
  if (list.length === 0) {
    summary = '아직 대조하지 않았습니다';
  } else if (completed) {
    summary = `대조 완료 · ${ran.length}/${RECONCILE_STEPS.length} 정상`
      + (totalFixed != null && totalFixed > 0 ? ` · ${totalFixed}건 정리` : '');
  } else if (stoppedAt != null) {
    summary = `${stepOf(stoppedAt)?.label ?? stoppedAt}에서 멈췄습니다`
      + ' — 여기가 안 풀리면 뒤 단계의 비교가 뜻을 잃습니다';
  } else {
    summary = `${ran.length}/${RECONCILE_STEPS.length} 진행`;
  }

  return { results: ordered, completed, stoppedAt, totalFixed, remaining, summary };
}

// ── 지금 주문을 내도 되는가 ───────────────────────────────

export interface BlockCounts {
  ok: number;
  blocked: number;
  unknown: number;
  total: number;
  /** 주문을 내도 되는가 */
  canOrder: boolean;
  /** 먼저 해결해야 하는 것들 — **순서대로** */
  firstFix: string[];
  /** 사람이 읽는 한 줄 */
  label: string;
}

export interface CheckItemLike {
  id?: string;
  label?: string;
  state?: 'ok' | 'bad' | 'unknown' | string;
}

/**
 * 무엇을 먼저 고쳐야 하는가.
 *
 * `11/16`은 성공한 게 11개인지 막힌 게 11개인지 순간적으로 헷갈린다.
 * **세 숫자로 나눈다** — 정상·차단·미확정.
 *
 * 그리고 **미확정을 정상으로 세지 않는다.** 확인하지 못한 것은 통과가
 * 아니다. 다만 차단과도 구분한다 — 차단은 '안 된다'이고 미확정은
 * '모른다'이며, 대응이 다르다.
 */
export function blockCountsOf(items: CheckItemLike[] | null | undefined): BlockCounts {
  const list = Array.isArray(items) ? items : [];
  const bad = list.filter(i => i?.state === 'bad');
  const unknown = list.filter(i => i?.state === 'unknown');
  const ok = list.filter(i => i?.state === 'ok').length;

  // **순서가 있다.** 미확정 주문이 남아 있으면 나머지를 고쳐도 소용없다.
  const PRIORITY = ['unknown_orders', 'pending', 'mismatch', 'leverage', 'position_mode', 'liquidation'];
  const rank = (i: CheckItemLike) => {
    const id = String(i?.id ?? '').toLowerCase();
    const idx = PRIORITY.findIndex(p => id.includes(p));
    return idx === -1 ? PRIORITY.length : idx;
  };

  const firstFix = [...bad, ...unknown]
    .sort((a, b) => rank(a) - rank(b))
    .map(i => String(i?.label ?? i?.id ?? '이름 없는 항목'));

  return {
    ok, blocked: bad.length, unknown: unknown.length, total: list.length,
    // 미확정이 있으면 주문하지 않는다.
    canOrder: list.length > 0 && bad.length === 0 && unknown.length === 0,
    firstFix,
    label: list.length === 0
      ? '점검 항목을 읽지 못했습니다'
      : `정상 ${ok} · 차단 ${bad.length} · 미확정 ${unknown.length}`,
  };
}

// ── 앱에만 있는 주문을 어떻게 처리하는가 ──────────────────

export type LocalOnlyAction =
  /** 거래소 이력에서 최종 상태를 찾았다 — 그것으로 장부를 고친다 */
  | 'SETTLE_FROM_VENUE'
  /** 이력에도 없다 — **지우지 않고 사람에게 넘긴다** */
  | 'ESCALATE'
  /** 아직 반영 전일 수 있다 — 조금 더 기다린다 */
  | 'WAIT';

export interface LocalOnlyVerdict {
  action: LocalOnlyAction;
  reason: string;
  /** 장부에 적을 최종 상태 */
  finalStatus: string | null;
}

/** 거래소에 반영되는 데 이 정도는 걸릴 수 있다 */
export const VENUE_REFLECT_GRACE_MS = 5_000;

/**
 * 앱에는 있는데 거래소 미체결 목록에 없는 주문.
 *
 * **그냥 지우지 않는다.** 이력에서 최종 상태를 찾아 그것을 증거로
 * 남기고, 못 찾으면 사람에게 넘긴다. 지우면 "왜 이 주문이 사라졌지"를
 * 나중에 아무도 답할 수 없다.
 */
export function localOnlyVerdict(input: {
  sentAtMs?: any; nowMs?: any; historyStatus?: any;
} | null | undefined): LocalOnlyVerdict {
  const i = input ?? {};
  const status = String(i.historyStatus ?? '').trim();

  if (status) {
    return {
      action: 'SETTLE_FROM_VENUE',
      finalStatus: status,
      reason: `거래소 이력에서 최종 상태 '${status}'를 찾았습니다 — 이 값으로 장부를 고칩니다`,
    };
  }

  const sent = Number(i.sentAtMs);
  const now = Number(i.nowMs);
  if (Number.isFinite(sent) && Number.isFinite(now) && now - sent < VENUE_REFLECT_GRACE_MS) {
    return {
      action: 'WAIT', finalStatus: null,
      reason: `보낸 지 ${Math.max(0, now - sent)}ms입니다 — 거래소에 아직 안 잡혔을 수 있습니다`,
    };
  }

  return {
    action: 'ESCALATE', finalStatus: null,
    reason: '거래소 미체결 목록에도 이력에도 없습니다 — 지우지 않고 사람이 확인해야 합니다.'
      + ' 지우면 이 주문이 나갔는지 아닌지가 영영 기록에서 사라집니다',
  };
}

// ── 주문 하나하나의 증거 ──────────────────────────────────
//
// **endpoint가 200이라고 그 안의 주문이 다 풀린 것이 아니다.**
//
// 지금 [모두 자동 대조]는 `/api/orders/reconcile`이 200이면 1~4단계를
// 전부 OK로 찍는다. 그런데 그 안에서 열 건 중 세 건이 여전히 미확정일
// 수 있다. 호출이 성공한 것과 장부가 맞은 것은 다르다.
//
// 그래서 **주문마다** 무엇을 근거로 무엇이라고 판정했는지 남긴다.
// 근거 없이 확정하면, 나중에 "왜 이 주문이 체결로 적혔지"를 아무도
// 답할 수 없다.

export type OrderResolution =
  /** 거래소 이력에 체결로 남아 있다 */
  | 'RESOLVED_FILLED'
  /** 일부만 체결됐다 — **전량 체결과 다르다** */
  | 'RESOLVED_PARTIAL'
  | 'RESOLVED_CANCELED'
  | 'RESOLVED_REJECTED'
  | 'RESOLVED_EXPIRED'
  /** 아직 거래소에 안 잡혔을 수 있다 — 조금 더 기다린다 */
  | 'GRACE_PERIOD'
  /** 어디에도 없다 — **지우지 않고 사람에게 넘긴다** */
  | 'STILL_UNKNOWN';

export const RESOLUTION_LABEL: Record<OrderResolution, string> = {
  RESOLVED_FILLED: '체결 확정',
  RESOLVED_PARTIAL: '부분 체결 확정',
  RESOLVED_CANCELED: '취소 확정',
  RESOLVED_REJECTED: '거부 확정',
  RESOLVED_EXPIRED: '만료 확정',
  GRACE_PERIOD: '반영 대기',
  STILL_UNKNOWN: '여전히 미확정',
};

export type EvidenceSource =
  /** 거래소 미체결 목록에 살아 있다 */
  | 'OPEN_ORDERS'
  /** 거래소 주문 이력에서 최종 상태를 찾았다 */
  | 'ORDER_HISTORY'
  /** 아무 근거도 못 찾았다 */
  | 'NONE';

export interface OrderEvidence {
  source: EvidenceSource;
  /** 거래소가 준 상태 문자열 원문 */
  venueStatus: string | null;
  venueOrderId: string | null;
  filledQty: number | null;
  observedAtMs: number | null;
}

export interface OrderVerdict {
  clientOrderId: string;
  resolution: OrderResolution;
  evidence: OrderEvidence;
  reason: string;
  /**
   * 이 주문이 '미확정 주문 없음'을 막는가.
   *
   * **확정되지 않은 것은 전부 막는다.** 반영 대기(GRACE_PERIOD)도
   * 막는다 — 아직 모르는 것이지 괜찮은 것이 아니다.
   */
  blocksClear: boolean;
}

/**
 * 거래소가 준 상태 문자열을 판정으로 옮긴다.
 *
 * **모르는 문자열을 체결로 읽지 않는다.** 거래소마다 표기가 다르고
 * (`FILLED` / `closed` / `finished` / `done`), 새 값이 나오면 조용히
 * 체결로 세는 쪽이 가장 위험하다.
 */
export function resolutionFromVenueStatus(
  status: any, filledQty?: any, orderQty?: any,
): OrderResolution | null {
  const s = String(status ?? '').trim().toUpperCase();
  if (!s) return null;

  const filled = Number(filledQty);
  const total = Number(orderQty);
  const hasFill = Number.isFinite(filled) && filled > 0;
  const knownTotal = Number.isFinite(total) && total > 0;

  if (/^(REJECT|REJECTED)$/.test(s)) return 'RESOLVED_REJECTED';
  if (/^(EXPIRE|EXPIRED)$/.test(s)) return 'RESOLVED_EXPIRED';

  // **취소인데 일부 체결된 것을 '취소'로만 적지 않는다.** 그 체결분은
  // 실제로 포지션이 됐고, 취소라고만 적으면 장부에서 사라진다.
  if (/^(CANCEL|CANCELED|CANCELLED)$/.test(s)) {
    return hasFill ? 'RESOLVED_PARTIAL' : 'RESOLVED_CANCELED';
  }

  if (/^(FILLED|CLOSED|FINISHED|DONE)$/.test(s)) {
    // 체결 수량을 아는데 주문 수량보다 적으면 부분 체결이다.
    if (hasFill && knownTotal && filled < total) return 'RESOLVED_PARTIAL';
    // **체결 수량을 모르면 전량 체결이라고 단정하지 않는다.**
    // 거래소가 'closed'만 주고 수량을 안 주면 취소로 닫힌 것일 수도 있다.
    if (!hasFill && knownTotal) return null;
    return 'RESOLVED_FILLED';
  }
  if (/^(PARTIALLY_FILLED|PARTIAL)$/.test(s)) return 'RESOLVED_PARTIAL';

  // NEW / OPEN / LIVE 같은 것은 아직 살아 있는 것이지 '확정'이 아니다.
  return null;
}

export interface ResolveOrderInput {
  clientOrderId?: any;
  /** 거래소 미체결 목록에서 찾았는가 */
  inOpenOrders?: any;
  /** 거래소 이력에서 찾은 상태 */
  historyStatus?: any;
  historyOrderId?: any;
  filledQty?: any;
  orderQty?: any;
  sentAtMs?: any;
  nowMs?: any;
  /** 이 거래소의 반영 유예(ms) */
  graceMs?: any;
}

/**
 * 주문 한 건을 증거와 함께 판정한다.
 *
 * 순서가 판정이다:
 *   1. 거래소에 살아 있으면 → 아직 안 끝난 것이다(미확정이 아니다)
 *   2. 이력에 최종 상태가 있으면 → 그것으로 확정한다
 *   3. 아직 유예 안이면 → 기다린다
 *   4. 그 외 → **여전히 미확정.** 지우지 않는다
 */
export function resolveOrder(input: ResolveOrderInput | null | undefined): OrderVerdict {
  const i = input ?? {};
  const clientOrderId = String(i.clientOrderId ?? '').trim();
  const now = Number(i.nowMs);
  const sent = Number(i.sentAtMs);
  const grace = Number.isFinite(Number(i.graceMs)) ? Number(i.graceMs) : DEFAULT_RECONCILE_GRACE_MS;

  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const make = (
    resolution: OrderResolution, evidence: OrderEvidence, reason: string,
  ): OrderVerdict => ({
    clientOrderId, resolution, evidence, reason,
    // **확정된 것만 통과다.** 반영 대기도 막는다 — 모르는 것이지
    // 괜찮은 것이 아니다.
    blocksClear: resolution === 'STILL_UNKNOWN' || resolution === 'GRACE_PERIOD',
  });

  // 1. 거래소에 아직 살아 있다.
  if (i.inOpenOrders === true) {
    return make('GRACE_PERIOD', {
      source: 'OPEN_ORDERS', venueStatus: 'OPEN',
      venueOrderId: i.historyOrderId == null ? null : String(i.historyOrderId),
      filledQty: num(i.filledQty), observedAtMs: num(i.nowMs),
    }, '거래소 미체결 목록에 살아 있습니다 — 아직 끝나지 않은 주문입니다');
  }

  // 2. 이력에 최종 상태가 있다.
  const fromHistory = resolutionFromVenueStatus(i.historyStatus, i.filledQty, i.orderQty);
  if (fromHistory) {
    return make(fromHistory, {
      source: 'ORDER_HISTORY',
      venueStatus: String(i.historyStatus),
      venueOrderId: i.historyOrderId == null ? null : String(i.historyOrderId),
      filledQty: num(i.filledQty), observedAtMs: num(i.nowMs),
    }, `거래소 이력의 '${i.historyStatus}'로 확정했습니다`);
  }

  const none: OrderEvidence = {
    source: 'NONE',
    venueStatus: i.historyStatus == null ? null : String(i.historyStatus),
    venueOrderId: null, filledQty: num(i.filledQty), observedAtMs: num(i.nowMs),
  };

  // 이력에 있긴 한데 우리가 못 읽는 상태다. **모르는 문자열을 체결로
  // 읽지 않는다** — 새 표기가 조용히 체결로 세어지는 것이 가장 위험하다.
  if (i.historyStatus != null && String(i.historyStatus).trim() !== '') {
    return make('STILL_UNKNOWN', none,
      `거래소가 '${i.historyStatus}'라고 답했는데 이 값을 해석하지 못했습니다`
      + ' — 체결로 단정하지 않고 사람이 확인해야 합니다');
  }

  // 3. 아직 유예 안이다.
  if (Number.isFinite(now) && Number.isFinite(sent) && now - sent < grace) {
    return make('GRACE_PERIOD', none,
      `보낸 지 ${Math.max(0, now - sent)}ms입니다 (유예 ${grace}ms) — 거래소에 아직 안 잡혔을 수 있습니다`);
  }

  // 4. 어디에도 없다.
  return make('STILL_UNKNOWN', none,
    '거래소 미체결 목록에도 이력에도 없습니다 — 지우지 않고 남겨 둡니다.'
    + ' 지우면 이 주문이 나갔는지 아닌지가 영영 기록에서 사라집니다');
}

export interface ReconcileOrdersSummary {
  total: number;
  resolved: number;
  stillUnknown: number;
  inGrace: number;
  /** '미확정 주문 없음'을 통과시켜도 되는가 */
  canClear: boolean;
  /** 판정별 개수 */
  byResolution: Record<OrderResolution, number>;
  reason: string;
}

/**
 * 주문 판정들을 모은다.
 *
 * **한 건이라도 확정 안 됐으면 '미확정 주문 없음'은 통과하지 않는다.**
 * 아홉 건이 풀리고 한 건이 남았으면 그건 90%가 아니라 '아직 미확정이
 * 있다'이다 — 그 한 건이 중복 주문을 만든다.
 */
export function reconcileOrdersSummary(
  verdicts: OrderVerdict[] | null | undefined,
): ReconcileOrdersSummary {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const byResolution: Record<OrderResolution, number> = {
    RESOLVED_FILLED: 0, RESOLVED_PARTIAL: 0, RESOLVED_CANCELED: 0,
    RESOLVED_REJECTED: 0, RESOLVED_EXPIRED: 0, GRACE_PERIOD: 0, STILL_UNKNOWN: 0,
  };
  for (const v of list) {
    if (v?.resolution && v.resolution in byResolution) byResolution[v.resolution]++;
  }

  const stillUnknown = byResolution.STILL_UNKNOWN;
  const inGrace = byResolution.GRACE_PERIOD;
  const resolved = list.length - stillUnknown - inGrace;

  const bits: string[] = [];
  if (stillUnknown > 0) bits.push(`미확정 ${stillUnknown}건`);
  if (inGrace > 0) bits.push(`반영 대기 ${inGrace}건`);

  return {
    total: list.length, resolved, stillUnknown, inGrace,
    canClear: list.length >= 0 && stillUnknown === 0 && inGrace === 0,
    byResolution,
    reason: bits.length === 0
      ? ''
      : `${bits.join(' · ')}이 남아 있습니다 — 이 상태로 새 주문을 내면 중복될 수 있습니다`,
  };
}

// ── 거래소마다 반영 속도가 다르다 ─────────────────────────

/** 어느 거래소인지 모를 때 */
export const DEFAULT_RECONCILE_GRACE_MS = 5_000;

/**
 * 주문 이력에 반영되는 데 걸리는 시간.
 *
 * **하드코딩 5초는 거래소를 하나로 본 것이다.** Gate와 바이낸스는 빠르고,
 * 국내 증권사(KIS)는 체결 통보가 훨씬 늦다. 짧게 잡으면 멀쩡한 주문을
 * '미확정'으로 몰고, 길게 잡으면 진짜 사고를 늦게 안다.
 *
 * 값 자체는 정밀하지 않다 — **거래소마다 다르다는 사실을 구조에 남기는
 * 것**이 목적이고, 실측이 쌓이면 여기만 고치면 된다.
 */
export const VENUE_RECONCILE_GRACE_MS: Record<string, number> = {
  BINANCE: 3_000,
  GATE: 5_000,
  UPBIT: 3_000,
  BITHUMB: 3_000,
  // 국내 증권사는 체결 통보가 느리고 장 마감·동시호가에서 더 늦는다.
  KIS: 15_000,
};

export function reconcileGraceMs(venue: any): number {
  const v = String(venue ?? '').trim().toUpperCase();
  // **모르는 거래소를 가장 빠른 쪽으로 가정하지 않는다.** 짧게 잡으면
  // 멀쩡한 주문을 미확정으로 몰고, 그러면 사람이 경고에 무뎌진다.
  return VENUE_RECONCILE_GRACE_MS[v] ?? DEFAULT_RECONCILE_GRACE_MS;
}
