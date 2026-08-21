// src/lib/smoke/cancelOps.ts
//
// **중지를 실제로 끝까지 수행하는 곳.**
//
// 판정은 `cancelRun.ts`가 값으로 하고, 한 회차를 닫는 절차는
// `settleAttempt.ts`가 한다. 여기는 그 둘을 **DB 상태와 이어 붙인다** —
// 그래서 브라우저가 닫혀도 워커가 같은 함수로 이어서 끝낼 수 있다.
//
// 왜 라우트가 아니라 여기인가
// ───────────────────────────
// 부르는 곳이 셋이다: 사람이 누른 `/cancel`, 옛 형식이 남아 있는
// `/advance`의 `stop: true`, 그리고 워커의 이어받기. 세 곳에 각자 절차를
// 두면 **한쪽만 고쳐진다** — 이 저장소에서 가장 자주 난 고장이다.
//
// 절대 하지 않는 것
// ─────────────────
// **Cancel All을 부르지 않는다.** 이 회차가 만든 SL/TP의 정확한 번호만
// 개별 취소한다. 같은 계좌의 다른 전략이 걸어 둔 손절을 지우면 그건
// 정리가 아니라 사고다.

import {
  cancelCompletion, attemptCancelPlan, needsCancelResume,
  LIVE_ATTEMPT_STATES, CANCEL_IN_FLIGHT,
} from './cancelRun';
import { settleAttempt } from './settleAttempt';
import { stepsOf } from './smokePlan';

/** 두 실행기가 같은 순간에 같은 줄을 닫지 않게 하는 유예 */
const CLAIM_TTL_MS = 120_000;

const isMissingColumn = (m: any) =>
  /column .* does not exist|could not find the .* column|schema cache/i.test(String(m ?? ''));
const isMissingTable = (m: any) => /does not exist|schema cache|relation/i.test(String(m ?? ''));

export interface CancelOpResult {
  ok: boolean;
  code: 'STOPPED' | 'CANCELLED' | 'CANCEL_FAILED' | 'IN_PROGRESS'
      | 'NOT_FOUND' | 'MIGRATION_MISSING' | 'TABLE_MISSING' | 'UPDATE_FAILED' | 'ALREADY_DONE';
  /** 지금 DB에 적힌 묶음 상태. **낙관적으로 앞질러 적지 않는다** */
  state: string | null;
  message: string;
  status: number;
  runId: string | null;
}

async function loadRun(sb: any, runId: string, userId?: string | null): Promise<any | null> {
  let q = (sb as any).from('smoke_runs').select('*').eq('id', runId);
  if (userId) q = q.eq('user_id', userId);
  const { data } = await q.maybeSingle();
  return data ?? null;
}

// ── 반복만 중지 ──────────────────────────────────────

/**
 * **다음 회차를 더 열지 않는다.** 지금 회차는 원래 마감 시각에 워커가 닫는다.
 *
 * 이게 지금까지 "중지" 버튼이 하던 일이고, 그 동작 자체는 옳다 —
 * 이름만 "즉시중지"로 읽혔을 뿐이다.
 */
export async function stopAfterCurrent(
  sb: any, i: { runId: string; userId?: string | null },
): Promise<CancelOpResult> {
  const runId = String(i.runId);
  const base = { state: null as string | null, runId };

  const patch: Record<string, any> = {
    state: 'STOPPED',
    reason: '사람이 반복을 중지했습니다 — 이미 열린 회차는 원래 마감 시각에 청산됩니다',
    closed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };

  // `stop_intent`는 055에서 생겼다. 없는 배포에서도 **중지 자체는
  // 되어야 한다** — 뜻을 못 적는 것과 못 멈추는 것은 다르다.
  let data: any = null; let error: any = null;
  for (const withIntent of [true, false]) {
    let q = (sb as any).from('smoke_runs')
      .update(withIntent ? { ...patch, stop_intent: 'STOP_AFTER_CURRENT' } : patch)
      .eq('id', runId).eq('state', 'RUNNING');
    if (i.userId) q = q.eq('user_id', i.userId);
    const r = await q.select('id, state');
    data = r.data; error = r.error;
    if (!error) break;
    if (!isMissingColumn(error.message)) break;
  }

  if (error) {
    if (isMissingTable(error.message)) {
      return { ...base, ok: false, code: 'TABLE_MISSING', status: 503,
        message: 'smoke_runs 표가 아직 없습니다 — 마이그레이션 053을 자동으로 적용하는 중입니다' };
    }
    return { ...base, ok: false, code: 'UPDATE_FAILED', status: 500, message: String(error.message) };
  }
  if (!Array.isArray(data) || data.length === 0) {
    const cur = await loadRun(sb, runId, i.userId);
    if (!cur) {
      return { ...base, ok: false, code: 'NOT_FOUND', status: 404,
        message: '그 반복 테스트를 찾지 못했습니다' };
    }
    return { ok: false, code: 'ALREADY_DONE', state: cur.state ?? null, runId, status: 409,
      message: `이미 ${cur.state} 상태입니다 — 진행 중인 반복이 아닙니다` };
  }

  return { ok: true, code: 'STOPPED', state: 'STOPPED', runId, status: 200,
    message: '다음 회차를 더 시작하지 않습니다 — 지금 회차는 원래 마감 시각에 청산됩니다' };
}

// ── 지금 테스트 종료 ─────────────────────────────────

async function setRunState(sb: any, runId: string, patch: Record<string, any>): Promise<boolean> {
  for (const full of [true, false]) {
    const body = full ? patch : stripNewColumns(patch);
    const { error } = await (sb as any).from('smoke_runs')
      .update({ ...body, updated_at: new Date().toISOString() }).eq('id', runId);
    if (!error) return true;
    if (!isMissingColumn(error.message)) return false;
  }
  return false;
}

const NEW_COLUMNS = ['stop_intent', 'cancel_requested_at', 'cancel_claimed_at', 'cancel_note'];
function stripNewColumns(patch: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(patch)) if (!NEW_COLUMNS.includes(k)) out[k] = v;
  return out;
}

/**
 * **지금 회차를 즉시 끝낸다.**
 *
 * 순서가 곧 규칙이다:
 *   1. 묶음을 CANCEL_REQUESTED로 적는다 — 여기서부터 새 회차는 안 열린다
 *   2. 열려 있는 회차를 선점한다 (두 번 눌러도 청산 주문은 한 번만 나간다)
 *   3. reduce-only 전량청산 → **거래소 재조회로 포지션 0 증명**
 *   4. 그 회차가 만든 SL/TP의 **정확한 번호만** 개별 취소 → 재조회 확인
 *   5. 넷 다 확인되면 CANCELLED, 하나라도 못 하면 **CANCEL_FAILED**
 *
 * 5번이 핵심이다. 사람이 버튼을 눌렀다는 사실은 거래소가 비었다는
 * 증거가 아니다.
 */
export async function cancelNow(
  sb: any, i: { runId: string; userId?: string | null },
): Promise<CancelOpResult> {
  const runId = String(i.runId);
  const run = await loadRun(sb, runId, i.userId);
  if (!run) {
    return { ok: false, code: 'NOT_FOUND', state: null, runId, status: 404,
      message: '그 반복 테스트를 찾지 못했습니다' };
  }

  const state = String(run.state ?? '').toUpperCase();
  if (state === 'CANCELLED') {
    return { ok: true, code: 'CANCELLED', state, runId, status: 200,
      message: run.cancel_note || '이미 중지가 완료된 테스트입니다' };
  }
  if (state === 'CANCEL_FAILED') {
    return { ok: false, code: 'CANCEL_FAILED', state, runId, status: 200,
      message: run.cancel_note || '중지가 끝나지 않은 테스트입니다 — 거래소에서 직접 확인하세요' };
  }

  // ── 1. 중지 요청됨 ──
  //
  // **여기서부터 새 회차는 열리지 않는다.** `advanceVerdict`가 RUNNING이
  // 아닌 묶음을 시작하지 않고, advance 라우트도 RUNNING만 고른다.
  if (state === 'RUNNING') {
    const okSet = await setRunState(sb, runId, {
      state: 'CANCEL_REQUESTED', stop_intent: 'CANCEL_NOW',
      cancel_requested_at: new Date().toISOString(),
      reason: '사람이 지금 테스트 종료를 눌렀습니다 — 현재 회차를 즉시 청산합니다',
    });
    if (!okSet) {
      return { ok: false, code: 'UPDATE_FAILED', state, runId, status: 500,
        message: '중지 요청을 기록하지 못했습니다 — 거래소에 아무 요청도 보내지 않았습니다' };
    }
  } else if (!needsCancelResume(state)) {
    return { ok: false, code: 'ALREADY_DONE', state, runId, status: 409,
      message: `이미 ${state} 상태입니다 — 진행 중인 반복이 아닙니다` };
  }

  // ── 2. 열려 있는 회차 ──
  const { data: tests } = await (sb as any).from('smoke_tests')
    .select('*').eq('run_id', runId).order('attempt_no', { ascending: true });
  const list: any[] = Array.isArray(tests) ? tests : [];
  const live = [...list].reverse().find(t => LIVE_ATTEMPT_STATES.includes(String(t?.state ?? '').toUpperCase())) ?? null;
  const plan = attemptCancelPlan({ attempt: live });

  if (plan.code === 'ALREADY_CLOSING') {
    // 다른 실행기(마감 청산)가 이미 이 회차를 닫는 중이다. **여기서
    // 청산 주문을 또 보내지 않는다** — 두 개가 나가면 하나는 반대 방향
    // 신규 진입이 된다. 워커가 다음 주기에 이어서 판정한다.
    await setRunState(sb, runId, { state: 'CLOSING' });
    return { ok: true, code: 'IN_PROGRESS', state: 'CLOSING', runId, status: 202, message: plan.reason };
  }

  if (plan.code === 'NOTHING_OPEN') {
    // 연 회차가 하나도 없으면 거래소에 이 묶음이 만든 것이 없다.
    // 있었다면 **그 회차가 남긴 증거로** 판정한다 — 상태 이름이 아니라.
    const last = list.length ? list[list.length - 1] : null;
    const completion = last
      ? completionFromRow(last)
      : cancelCompletion({ positionZero: true, slOrderId: null, tpOrderId: null,
        cancelEntries: [], cancelCode: 'NOTHING_TO_CANCEL',
        residualCode: 'ORDERS_CLEAR', residualMine: 0, residualUnknown: 0 });
    return await finish(sb, runId, completion, last ? '열려 있는 회차가 없습니다' : '연 회차가 없습니다');
  }

  // ── 3. 선점 ──
  //
  // 같은 버튼을 두 번 눌러도 청산 주문은 한 번만 나간다.
  const nowMs = Date.now();
  const claimCutoff = new Date(nowMs - CLAIM_TTL_MS).toISOString();
  let claim = (sb as any).from('smoke_tests')
    .update({ settle_claimed_at: new Date(nowMs).toISOString(), state: 'CLOSING' })
    .eq('id', live.id).in('state', ['PREFLIGHT', 'ENTERING', 'HOLDING']);
  claim = live.settle_claimed_at == null
    ? claim.is('settle_claimed_at', null)
    : claim.lt('settle_claimed_at', claimCutoff);
  const { data: claimed, error: claimErr } = await claim.select('id');

  if (claimErr) {
    await setRunState(sb, runId, { state: 'CANCEL_REQUESTED' });
    return { ok: false, code: 'UPDATE_FAILED', state: 'CANCEL_REQUESTED', runId, status: 500,
      message: `회차를 선점하지 못했습니다: ${claimErr.message} — 거래소에 청산 요청을 보내지 않았습니다` };
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    await setRunState(sb, runId, { state: 'CLOSING' });
    return { ok: true, code: 'IN_PROGRESS', state: 'CLOSING', runId, status: 202,
      message: '다른 실행기가 이미 이 회차를 닫고 있습니다 — 끝나면 이어서 판정합니다' };
  }

  // ── 4. 청산 → 보호주문 정리 ──
  const r = await settleAttempt(sb, { ...live, state: 'CLOSING' }, {
    cancel: true,
    cancelNote: '사람이 지금 테스트 종료를 눌렀습니다 — 유지 시간을 채우지 않았습니다',
    onPhase: async (p) => { await setRunState(sb, runId, { state: p }); },
  });

  // 자격증명을 못 읽어 되돌린 경우다 — 아직 끝나지 않았다.
  if (r.verdict === 'RETRY') {
    await setRunState(sb, runId, { state: 'CANCEL_REQUESTED' });
    return { ok: false, code: 'IN_PROGRESS', state: 'CANCEL_REQUESTED', runId, status: 202,
      message: `${r.reason} — 다음 주기에 워커가 이어서 시도합니다` };
  }

  return await finish(sb, runId, r.completion ?? completionFromRow(live), null);
}

/** 회차 줄에 이미 적혀 있는 증거로 완료를 판정한다 */
function completionFromRow(row: any) {
  const steps = stepsOf(row?.steps);
  const st = (id: string) => steps.find(s => s.id === id)?.state ?? 'PENDING';
  const posState = st('POSITION_ZERO');
  const cancelEv = row?.steps?._cancel ?? null;
  const residual = row?.steps?._residual ?? null;
  return cancelCompletion({
    positionZero: posState === 'PASS' ? true : posState === 'FAIL' ? false : null,
    slOrderId: row?.sl_order_id ?? null,
    tpOrderId: row?.tp_order_id ?? null,
    cancelEntries: Array.isArray(cancelEv?.entries)
      ? cancelEv.entries.map((e: any) => ({ id: String(e?.id ?? ''), state: String(e?.state ?? '') }))
      : [],
    cancelCode: cancelEv?.code ?? null,
    residualCode: residual?.code ?? null,
    residualMine: residual?.mine ?? null,
    residualUnknown: residual?.unknown ?? null,
  });
}

async function finish(
  sb: any, runId: string, completion: ReturnType<typeof cancelCompletion>, prefix: string | null,
): Promise<CancelOpResult> {
  const note = [prefix, completion.reason].filter(Boolean).join(' — ');
  await setRunState(sb, runId, {
    state: completion.code, verdict: completion.code, reason: note, cancel_note: note,
    closed_at: new Date().toISOString(),
  });
  return {
    ok: completion.ok,
    code: completion.code,
    state: completion.code, runId,
    status: 200,
    message: note,
  };
}

// ── 워커가 이어받는다 ────────────────────────────────

/**
 * **브라우저가 닫혀도 끝난다.**
 *
 * 중지는 절차이고 절차는 중간에 끊길 수 있다 — 탭을 닫거나, 서버가
 * 재시작하거나, 청산 중 거래소가 한 번 실패하거나. 그때 묶음은
 * `CANCEL_REQUESTED`/`CLOSING`/`CLEANING_PROTECTION`에 멈춰 있고,
 * 워커가 1분마다 이 함수를 불러 **같은 절차로** 이어서 끝낸다.
 */
export async function resumeCancels(sb: any, limit = 5): Promise<CancelOpResult[]> {
  let runs: any[] = [];
  try {
    const { data, error } = await (sb as any).from('smoke_runs')
      .select('id, state').in('state', CANCEL_IN_FLIGHT)
      // **055가 아직 적용되지 않은 배포에서도 이어받기는 돌아야 한다.**
      // `cancel_requested_at`으로 정렬하면 그 배포에서는 조회 자체가
      // 실패하고, 그러면 끊긴 중지가 영원히 안 끝난다. 053부터 있는
      // 칸으로 정렬한다 — 순서는 오래된 것부터면 충분하다.
      .order('updated_at', { ascending: true }).limit(limit);
    if (error) throw new Error(error.message);
    runs = Array.isArray(data) ? data : [];
  } catch (e: any) {
    if (isMissingTable(e?.message)) return [];
    throw e;
  }
  const out: CancelOpResult[] = [];
  for (const r of runs) out.push(await cancelNow(sb, { runId: String(r.id) }));
  return out;
}
