// src/lib/smoke/cancelRun.ts
//
// **"중지"가 두 가지였는데 버튼은 하나였다.**
//
// 무엇이 문제였나
// ───────────────
// 카드에 적힌 `즉시중지`는 사용자가 누른 취소 상태가 아니었다. 그건
// 시작할 때 고른 **실패 정책(SAFE)** — "한 회차가 실패하면 다음 회차를
// 안 연다"는 뜻이다. 지금 열린 포지션과는 아무 상관이 없다.
//
// 그리고 실제 중지 버튼은 `다음 회차 중지`였다. 서버도 그 뜻대로 만들어져
// 있다 — 묶음을 STOPPED로 적고, **이미 열린 회차는 그대로 두고** 원래
// 마감 시각에 워커가 닫는다.
//
// 그래서 사람이 "취소"를 눌렀는데 화면에는 포지션이 계속 진행 중이었다.
// 코드가 틀린 게 아니라 **말이 두 가지를 하나로 뭉갠 것**이다.
//
// 그래서 뜻을 둘로 나눈다
// ───────────────────────
//   STOP_AFTER_CURRENT  지금 회차는 원래 마감 시각까지 정상으로 끝내고
//                       다음 회차를 열지 않는다. (기존 동작)
//   CANCEL_NOW          지금 회차를 **당장** 끝낸다 — reduce-only 전량청산 →
//                       포지션 0 재조회 증명 → 그 회차가 만든 SL/TP의
//                       **정확한 번호만** 개별 취소 → 거래소 재조회로
//                       사라진 것 확인 → 그제야 CANCELLED.
//
// **둘을 한 요청에 섞지 않는다.** 섞이면 "무엇을 시켰는지"가 사라지고,
// 그때 사람은 닫힌 줄 알고 화면을 닫는다.
//
// 그리고 여기서 가장 중요한 규칙
// ──────────────────────────────
// **CANCELLED는 증거가 전부 모였을 때만이다.** 청산을 못 했거나, 재조회를
// 못 했거나, 보호주문이 하나라도 UNKNOWN이면 그건 CANCEL_FAILED다.
// 사람이 "중지"를 눌렀다는 사실은 거래소가 비었다는 증거가 아니다.

/** 사용자가 무엇을 시켰는가 */
export type StopIntent = 'STOP_AFTER_CURRENT' | 'CANCEL_NOW';

/**
 * 묶음의 생애.
 *
 * `CANCEL_REQUESTED → CLOSING → CLEANING_PROTECTION`은 **관측된 상태**다.
 * 버튼을 누른 순간 '완료'로 적지 않는다 — 그러면 청산이 실패해도 화면은
 * 끝났다고 말한다.
 */
export type RunLifecycle =
  | 'RUNNING'
  | 'CANCEL_REQUESTED'
  | 'CLOSING'
  | 'CLEANING_PROTECTION'
  | 'CANCELLED'
  | 'CANCEL_FAILED'
  | 'STOPPED'
  | 'PASS'
  | 'FAIL';

/** 중지가 진행 중인 상태들. 이 동안에는 새 회차를 절대 열지 않는다 */
export const CANCEL_IN_FLIGHT: RunLifecycle[] = ['CANCEL_REQUESTED', 'CLOSING', 'CLEANING_PROTECTION'];

/** 워커가 이어받아 끝내야 하는 상태인가 — 브라우저가 닫혀도 끝나야 한다 */
export function needsCancelResume(state: any): boolean {
  return CANCEL_IN_FLIGHT.includes(String(state ?? '').toUpperCase() as RunLifecycle);
}

const upper = (v: any): string => String(v ?? '').trim().toUpperCase();

// ── 무엇을 시켰는가 ──────────────────────────────────

export interface IntentVerdict {
  ok: boolean;
  code: 'OK' | 'MISSING_INTENT' | 'UNKNOWN_INTENT' | 'MIXED_INTENT' | 'MISSING_RUN';
  intent: StopIntent | null;
  runId: string | null;
  message: string;
}

/**
 * 요청이 무엇을 시켰는지 값으로 확정한다.
 *
 * **옛 `stop: true`와 새 `intent`를 한 요청에 같이 보내면 거절한다.**
 * 둘이 다른 뜻이라 섞이면 서버가 하나를 고르게 되고, 고른 쪽이 사람이
 * 생각한 쪽이라는 보장이 없다. 옛 형식 단독은 계속 받는다 —
 * `stop: true`는 언제나 **다음 회차 중지**였고 그 뜻은 안 바뀐다.
 */
export function stopIntentVerdict(body: any): IntentVerdict {
  const b = (body && typeof body === 'object') ? body : {};
  const hasLegacy = Object.prototype.hasOwnProperty.call(b, 'stop');
  const hasIntent = Object.prototype.hasOwnProperty.call(b, 'intent');
  const runId = String(b.runId ?? '').trim() || null;

  const bad = (code: IntentVerdict['code'], message: string): IntentVerdict =>
    ({ ok: false, code, intent: null, runId, message });

  if (hasLegacy && hasIntent) {
    return bad('MIXED_INTENT',
      'stop과 intent를 같이 보낼 수 없습니다 — 다음 회차 중지(STOP_AFTER_CURRENT)와 '
      + '지금 테스트 종료(CANCEL_NOW)는 다른 요청입니다');
  }

  let intent: StopIntent | null = null;
  if (hasIntent) {
    const raw = upper(b.intent);
    if (raw === 'STOP_AFTER_CURRENT' || raw === 'CANCEL_NOW') intent = raw;
    else return bad('UNKNOWN_INTENT',
      `intent는 STOP_AFTER_CURRENT 또는 CANCEL_NOW입니다 (받은 값: ${String(b.intent)})`);
  } else if (hasLegacy) {
    if (b.stop !== true) return bad('MISSING_INTENT', 'stop은 true일 때만 유효합니다');
    intent = 'STOP_AFTER_CURRENT';
  } else {
    return bad('MISSING_INTENT',
      'intent가 없습니다 — STOP_AFTER_CURRENT(다음 회차 중지) 또는 CANCEL_NOW(지금 테스트 종료)');
  }

  if (!runId) return bad('MISSING_RUN', 'runId가 없습니다');

  return {
    ok: true, code: 'OK', intent, runId,
    message: intent === 'CANCEL_NOW'
      ? '지금 테스트 종료 — 현재 회차를 즉시 청산하고 보호주문까지 정리합니다'
      : '다음 회차 중지 — 지금 회차는 원래 마감 시각에 청산됩니다',
  };
}

// ── 지금 어디까지 왔는가 ─────────────────────────────

export interface CancelPhase {
  state: RunLifecycle;
  /** 화면에 그대로 그리는 한 줄 */
  label: string;
  /** 중지 절차가 도는 중인가 */
  inFlight: boolean;
  /** 끝났는가 (성공이든 실패든) */
  done: boolean;
  /** 증거가 모여 끝난 것인가 */
  ok: boolean;
}

/**
 * 상태 → 사람이 읽는 진행 표시.
 *
 * **누른 직후 '완료'가 없다.** 버튼을 누르면 `중지 요청됨`이고, 그다음은
 * 서버가 관측한 것만 올라온다.
 */
export function cancelPhase(state: any): CancelPhase {
  const s = upper(state) as RunLifecycle;
  const make = (label: string, inFlight: boolean, done: boolean, ok: boolean): CancelPhase =>
    ({ state: s, label, inFlight, done, ok });

  switch (s) {
    case 'CANCEL_REQUESTED':    return make('중지 요청됨', true, false, false);
    case 'CLOSING':             return make('포지션 청산 중', true, false, false);
    case 'CLEANING_PROTECTION': return make('보호주문 정리 중', true, false, false);
    case 'CANCELLED':           return make('중지 완료', false, true, true);
    case 'CANCEL_FAILED':       return make('중지 실패 — 거래소에서 직접 확인하세요', false, true, false);
    case 'STOPPED':             return make('반복 중지 — 열린 회차는 마감 시각에 청산됩니다', false, true, false);
    case 'PASS':                return make('완료', false, true, true);
    case 'FAIL':                return make('실패', false, true, false);
    default:                    return make('진행 중', false, false, false);
  }
}

// ── 지금 회차에 무엇을 해야 하는가 ───────────────────

export type AttemptCancelCode =
  /** 열린 회차가 없다 — 거래소에 보낼 것이 없다 */
  | 'NOTHING_OPEN'
  /** 청산하고 보호주문을 정리해야 한다 */
  | 'CLOSE_AND_CLEAN'
  /** 다른 실행기가 이미 이 회차를 닫고 있다 */
  | 'ALREADY_CLOSING';

export interface AttemptCancelPlan {
  code: AttemptCancelCode;
  reason: string;
}

/** 회차가 살아 있다고 보는 상태들 */
export const LIVE_ATTEMPT_STATES = ['PREFLIGHT', 'ENTERING', 'HOLDING', 'CLOSING'];

/**
 * 이 회차에 무엇을 해야 하는가.
 *
 * **진입 전이라도 '아무것도 없다'로 단정하지 않는다.** ENTERING은 진입
 * 주문이 나가 있을 수 있는 상태다 — 거래소를 읽어 보고 없으면 그때
 * 없는 것이지, 상태 이름만 보고 없다고 적으면 그게 유령 포지션이 된다.
 */
export function attemptCancelPlan(i: { attempt: { state?: any } | null | undefined }): AttemptCancelPlan {
  const st = upper(i?.attempt?.state);
  if (!i?.attempt || !st) {
    return { code: 'NOTHING_OPEN', reason: '열려 있는 회차가 없습니다 — 거래소에 보낼 요청이 없습니다' };
  }
  if (!LIVE_ATTEMPT_STATES.includes(st)) {
    return { code: 'NOTHING_OPEN', reason: `현재 회차가 이미 ${st}입니다 — 새로 청산할 것이 없습니다` };
  }
  if (st === 'CLOSING') {
    return { code: 'ALREADY_CLOSING', reason: '이미 청산 절차가 도는 중입니다 — 끝날 때까지 새 청산 주문을 보내지 않습니다' };
  }
  return { code: 'CLOSE_AND_CLEAN', reason: `${st} 회차를 즉시 청산하고 그 회차의 보호주문을 정확한 번호로 취소합니다` };
}

// ── 끝났는가 ─────────────────────────────────────────

export interface CancelCheck {
  label: string;
  /** true 확인됨 · false 실패 · null 확인하지 못함 */
  ok: boolean | null;
  note: string;
}

export interface CancelCompletion {
  code: 'CANCELLED' | 'CANCEL_FAILED';
  ok: boolean;
  checks: CancelCheck[];
  reason: string;
}

/**
 * 중지가 **끝난 것인가**를 증거로 판정한다.
 *
 * 네 가지가 전부 확인돼야 CANCELLED다:
 *   1. 포지션 0 (거래소 재조회로)
 *   2. 저장된 손절 번호가 거래소에 없음
 *   3. 저장된 익절 번호가 거래소에 없음
 *   4. 이 회차 소유의 잔여 주문 0 (모르는 것 포함해서 0)
 *
 * **하나라도 null이면 CANCEL_FAILED다.** "확인하지 못함"은 통과가 아니다 —
 * 이 판정이 무너지면 거래소에 주문이 남은 채로 화면만 '중지 완료'가 된다.
 */
export function cancelCompletion(i: {
  positionZero: boolean | null;
  slOrderId?: string | null;
  tpOrderId?: string | null;
  /** protectionLedger의 항목: { id, state } */
  cancelEntries?: Array<{ id: string; state: string }> | null;
  /** 취소 장부 코드 */
  cancelCode?: string | null;
  /** residualVerdict 코드와 개수 */
  residualCode?: string | null;
  residualMine?: number | null;
  residualUnknown?: number | null;
}): CancelCompletion {
  const checks: CancelCheck[] = [];

  const pos = i?.positionZero === true ? true : i?.positionZero === false ? false : null;
  checks.push({
    label: '포지션 0',
    ok: pos,
    note: pos === true ? '거래소 재조회에서 포지션이 없습니다'
      : pos === false ? '청산 뒤에도 포지션이 남아 있습니다'
        : '포지션을 확인하지 못했습니다',
  });

  const entries = Array.isArray(i?.cancelEntries) ? i.cancelEntries : [];
  const stateOf = (id: any): string | null => {
    const s = String(id ?? '').trim();
    if (!s) return null;
    return entries.find(e => String(e?.id ?? '') === s)?.state ?? null;
  };
  const idCheck = (label: string, id: any): CancelCheck => {
    const s = String(id ?? '').trim();
    // 번호가 없으면 걸린 적이 없다 — 지울 것이 없으므로 통과다.
    if (!s || s === 'null' || s === 'undefined') {
      return { label: `${label} 없음`, ok: true, note: `${label} 주문 번호가 기록되지 않았습니다 (건 적이 없습니다)` };
    }
    const st = stateOf(s);
    if (st === 'CANCEL_CONFIRMED') return { label: `${label} ${s}`, ok: true, note: '재조회에서 사라진 것을 확인했습니다' };
    if (st === 'STILL_PRESENT') return { label: `${label} ${s}`, ok: false, note: '취소 뒤에도 거래소에 남아 있습니다' };
    return { label: `${label} ${s}`, ok: null, note: st === 'CANCEL_UNKNOWN'
      ? '취소 뒤 목록을 읽지 못해 사라졌는지 확인하지 못했습니다'
      : '취소 결과가 기록되지 않았습니다' };
  };
  checks.push(idCheck('손절', i?.slOrderId));
  checks.push(idCheck('익절', i?.tpOrderId));

  const mine = i?.residualMine;
  const unknown = i?.residualUnknown;
  const rcode = upper(i?.residualCode);
  const residualOk: boolean | null =
    rcode === 'ORDERS_UNKNOWN' || rcode === '' || mine == null || unknown == null ? null
      : (Number(mine) === 0 && Number(unknown) === 0);
  checks.push({
    label: '잔여 주문 0',
    ok: residualOk,
    note: residualOk === true ? '이 회차 소유의 잔여 주문이 없습니다'
      : residualOk === false ? `잔여 ${Number(mine) || 0}건 · 판별 못 한 주문 ${Number(unknown) || 0}건`
        : '잔여 주문을 확인하지 못했습니다',
  });

  const failed = checks.filter(c => c.ok === false);
  const unproven = checks.filter(c => c.ok == null);

  if (failed.length > 0) {
    return {
      code: 'CANCEL_FAILED', ok: false, checks,
      reason: `중지가 끝나지 않았습니다 — ${failed.map(c => c.label).join(' · ')}. 거래소에서 직접 확인하세요`,
    };
  }
  if (unproven.length > 0) {
    return {
      code: 'CANCEL_FAILED', ok: false, checks,
      reason: `중지 결과를 확인하지 못했습니다 — ${unproven.map(c => c.label).join(' · ')}. `
        + '확인하지 못한 것은 0이 아닙니다',
    };
  }
  return {
    code: 'CANCELLED', ok: true, checks,
    reason: '포지션 0 · 손절/익절 취소 확인 · 잔여 주문 0 — 거래소 재조회로 확인했습니다',
  };
}
