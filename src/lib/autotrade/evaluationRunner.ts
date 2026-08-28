// src/lib/autotrade/evaluationRunner.ts
//
// **예약 한 줄을 평가하는 단 하나의 경로.**
//
// 왜 하나여야 하는가
// ──────────────────
// 이 저장소에서 제일 자주 난 사고가 **"경로가 둘인데 한쪽만 고침"**이다.
// 자동매매에는 지금 부르는 쪽이 둘이다:
//
//   · 예약을 켠 직후의 첫 평가        (schedule POST)
//   · 실행기가 주기적으로 도는 평가    (daily-ladder GET)
//
// 이 둘이 각자 실행기를 부르면, 전략 판정·기록 형식·간격 검사가 두 벌이
// 된다. 그러면 "켰을 때는 되는데 그 뒤로 안 된다" 같은 고장이 난다.
//
// 무엇을 하지 않는가
// ──────────────────
// **여기서 주문을 만들지 않는다.** 기존 실행기(daily-ladder POST·scalp)가
// 크기·배율·안전 관문·주문 경로를 전부 갖고 있다. 그걸 대체하면 수동
// 주문과 자동 주문이 서로 다른 검사를 받게 된다.
//
// 이 파일이 하는 일은 셋뿐이다:
//   1. 이 줄을 지금 평가할 차례인지 본다
//   2. 전략 레지스트리를 통해 맞는 실행기를 부른다
//   3. 결과를 예약 줄에 적는다

import { runStrategy, evaluationKey, type EvaluationOutcome } from '../strategies/runStrategy';
import { strategyIdOfRow } from '../strategies/registry';
import { strategyRunRequest } from '../strategies/runRequest';
import { decisionRecordOf } from '../ui/autoOverview';
import { dueCheck, verdictOfOutcome, resultLineOf, type DueVerdict } from './evaluationLoop';
import { claimVerdict, type ClaimVerdict, type DispatchSource } from './schedulePoll';

/** `autotrade_schedules` 한 줄 중 이 파일이 쓰는 칸만 */
export interface ScheduleRow {
  id: string;
  user_id: string;
  symbol: string;
  connection_id: string | null;
  mode: string;
  enabled?: any;
  last_run_at?: any;
  interval_min?: any;
  leverage_cap?: any;
  risk_pct?: any;
  margin_pct?: any;
  strategy_id?: any;
  strategy_version?: any;
}

export interface EvaluationRecord {
  scheduleId: string;
  symbol: string;
  strategyId: string;
  strategyVersion: string;
  outcome: EvaluationOutcome;
  summary: string;
  /** 실제로 주문이 나갔는가. **'평가했다'와 다르다** */
  executed: boolean;
  raw: any;
}

/** `mode` → 실행 환경. `is_testnet === false`만 실전이라는 저장소 규칙과 같은 방향이다 */
export function envOfMode(mode: any): 'TESTNET' | 'LIVE' {
  const m = String(mode || '').toUpperCase();
  return m.startsWith('LIVE') || m === 'SHADOW_LIVE' ? 'LIVE' : 'TESTNET';
}

export interface DispatchDeps {
  /** 실행기를 부를 기준 주소 (같은 배포의 origin) */
  origin: string;
  /** 실행기 인증. **값은 로그·응답에 절대 싣지 않는다** */
  adminSecret: string;
  fetchImpl?: typeof fetch;
  /** 실행기 한 번에 허용할 시간(ms) */
  timeoutMs?: number;
  /**
   * **누가 깨웠는가.** 기록에 그대로 남는다 — "왜 아무도 안 왔나"를
   * 로그가 아니라 예약 줄에서 답할 수 있어야 한다.
   */
  source?: DispatchSource;
}

/**
 * 예약 한 줄을 평가한다. **간격 검사는 하지 않는다** — 부르는 쪽이 한다.
 *
 * 전략 판정(`runStrategy`)이 앞에 있으므로, 모르는 전략·연구 전용·버전
 * 불일치는 실행기까지 가지 않고 `BLOCKED`로 끝난다.
 */
export async function evaluateSchedule(
  row: ScheduleRow, deps: DispatchDeps,
): Promise<EvaluationRecord> {
  const strategyId = strategyIdOfRow(row);
  const env = envOfMode(row.mode);
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const result = await runStrategy(strategyId, row.strategy_version, {
    symbol: row.symbol,
    connectionId: String(row.connection_id || ''),
    mode: String(row.mode || ''),
    env,
    intervalMin: row.interval_min ?? null,
    leverageCap: row.leverage_cap ?? null,
    riskPct: row.risk_pct ?? null,
    marginPct: row.margin_pct ?? null,
    idempotencyKey: evaluationKey({
      userId: String(row.user_id), strategyId, symbol: row.symbol,
      connectionId: String(row.connection_id || ''),
      // 주기 버킷. 같은 버킷 안에서는 같은 키다 — 시각을 그대로 넣으면
      // 1초 차이로 다른 키가 되어 아무것도 못 막는다.
      slot: bucketOf(row),
    }),
  }, {
    call: async (route, ctx) => {
      // **본문을 여기서 짜지 않는다.** 화면의 [점검]·첫 평가와 같은
      // 함수로 만든다 — 세 곳이 각자 적으면 전략을 추가할 때 한 곳이
      // 빠지고, 그때 예약에 저장한 전략과 실제로 도는 전략이 갈린다.
      const req = strategyRunRequest({
        strategyId, strategyVersion: row.strategy_version,
        env, symbol: ctx.symbol, connectionId: ctx.connectionId, mode: ctx.mode,
        intervalMin: ctx.intervalMin, leverageCap: ctx.leverageCap,
        riskPct: ctx.riskPct, marginPct: ctx.marginPct,
        userId: row.user_id, idempotencyKey: ctx.idempotencyKey,
      });
      // resolveStrategy는 runStrategy가 앞에서 이미 통과시켰다. 여기서
      // 막히면 그 사이에 규칙이 바뀐 것이므로 그대로 실패로 올린다.
      if (!req.ok || !req.route || !req.body) {
        return { httpOk: false, status: null, body: { ok: false, message: req.message } };
      }
      const res = await doFetch(`${deps.origin}${req.route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': deps.adminSecret },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null);
      return { httpOk: res.ok, status: res.status, body };
    },
  });

  const b = result.raw ?? {};
  return {
    scheduleId: row.id,
    symbol: row.symbol,
    strategyId: result.strategyId,
    strategyVersion: result.strategyVersion,
    outcome: result.outcome,
    summary: result.summary,
    // **'엔진이 답했다'와 '진입했다'는 다르다.** 대부분의 평가는 진입하지
    // 않고 그건 정상이다. 둘을 같은 '성공'으로 세면 화면에 "성공 1건"이
    // 뜨고, 사람은 포지션이 생긴 줄 안다.
    executed: result.outcome === 'ENTERED',
    raw: b?.battle ?? null,
  };
}

/**
 * 이 평가가 속한 주기 버킷.
 *
 * 마지막 평가 시각을 간격으로 나눈 칸이다. 같은 칸 안의 중복 호출은
 * 같은 키를 갖는다.
 */
function bucketOf(row: ScheduleRow): string {
  const last = row.last_run_at ? Date.parse(String(row.last_run_at)) : NaN;
  if (!Number.isFinite(last)) return 'first';
  const interval = Number(row.interval_min);
  const gap = (Number.isFinite(interval) && interval >= 1 ? interval : 1440) * 60_000;
  return `b${Math.floor(last / gap) + 1}`;
}

/**
 * 평가 결과를 예약 줄에 적는다.
 *
 * **기록이 실행보다 중요할 수는 없다.** `last_decision` 칸이 아직 없으면
 * (마이그레이션 043 전) 그 칸만 빼고 다시 쓴다 — 칸 하나 때문에
 * `last_run_at`까지 못 남기면 간격 검사가 통째로 망가져서, 조건이 맞는
 * 동안 매 분 진입한다.
 */
export async function recordEvaluation(
  sb: any, scheduleId: string,
  rec: { outcome: EvaluationOutcome | string; summary: any; raw?: any; source?: DispatchSource },
): Promise<{ saved: boolean; error: string | null }> {
  const base = {
    last_run_at: new Date().toISOString(),
    last_result: resultLineOf(rec.outcome, rec.summary),
  };
  // 옛 화면이 읽는 `verdict`와 새 값 `outcome`을 **둘 다** 적는다.
  // 하나만 적으면 다른 쪽 화면이 조용히 '기록 없음'을 그린다.
  const decision = {
    ...decisionRecordOf(verdictOfOutcome(rec.outcome), rec.summary, rec.raw ?? null),
    outcome: String(rec.outcome),
    // 누가 깨웠는지. **모르면 적지 않는다** — 'MANUAL'로 채우면
    // 사람이 누른 것과 구분이 안 된다.
    ...(rec.source ? { source: rec.source, sourceAt: new Date().toISOString() } : {}),
  };

  try {
    const { error } = await sb.from('autotrade_schedules')
      .update({ ...base, last_decision: decision }).eq('id', scheduleId);
    if (!error) return { saved: true, error: null };
    // last_decision 때문이 아니면 다시 시도해도 같은 이유로 실패한다.
    if (!/last_decision/i.test(String(error.message))) {
      return { saved: false, error: String(error.message) };
    }
    const retry = await sb.from('autotrade_schedules').update(base).eq('id', scheduleId);
    return retry.error
      ? { saved: false, error: String(retry.error.message) }
      : { saved: true, error: '판단 기록 칸(last_decision)이 없어 요약만 남겼습니다 — 마이그레이션 043' };
  } catch (e: any) {
    return { saved: false, error: String(e?.message || e) };
  }
}

/**
 * **이 예약을 지금 내가 평가한다고 못 박는다.**
 *
 * 왜 필요한가
 * ───────────
 * 이제 예약을 보는 곳이 둘이다 — GitHub Actions(`autotrade-tick`)와
 * 24시간 도는 Fly Worker. 둘이 같은 순간에 같은 줄을 보면 **평가가 두 번
 * 돌고, 조건이 맞았으면 주문도 두 번 나간다.**
 *
 * 어떻게 막는가
 * ─────────────
 * `last_run_at`을 지금으로 바꾸되 **읽었을 때와 값이 같을 때만** 바꾼다.
 * 그 사이 다른 쪽이 먼저 바꿨으면 0줄이 갱신되고, 그때는 물러난다.
 *
 * 새 표도 새 칸도 필요 없다. 이미 있는 칸이 그대로 번호표다.
 *
 * **선점에 실패한 것과 남이 가져간 것은 다르다.** 조회 오류를 '남이
 * 가져갔다'로 읽으면 그 예약은 아무도 안 도는데 로그는 정상으로 보인다.
 */
export async function claimSchedule(
  sb: any, row: ScheduleRow, nowMs: number,
): Promise<ClaimVerdict> {
  try {
    let q = sb.from('autotrade_schedules')
      .update({ last_run_at: new Date(nowMs).toISOString() })
      .eq('id', row.id)
      // ── 취소가 먼저 커밋됐으면 여기서 진다 ──
      //
      // 워커는 `enabled = true`인 줄을 **읽고 나서** 선점한다. 그 사이에
      // 사용자가 취소하면, 예전에는 이 UPDATE가 그대로 성공해서 **취소된
      // 예약이 주문을 냈다.** 읽은 시점의 사실로 쓰는 것이기 때문이다.
      //
      // 조건을 여기 붙이면 그 경합이 DB 한 문장 안에서 끝난다:
      // 취소가 먼저면 이 UPDATE가 0줄을 고치고 `LOST`가 된다.
      .eq('enabled', true)
      .is('cancelled_at', null);
    // **null과 값은 다른 조건이다.** `.eq(col, null)`은 SQL에서 항상
    // 거짓이라 첫 평가를 영원히 못 가져온다.
    q = row.last_run_at == null ? q.is('last_run_at', null)
      : q.eq('last_run_at', row.last_run_at);

    const { data, error } = await q.select('id');
    if (error) return claimVerdict(null, error);
    return claimVerdict(Array.isArray(data) ? data.length : null);
  } catch (e: any) {
    return claimVerdict(null, e);
  }
}

/**
 * 예약 한 줄을 **차례일 때만** 평가하고 기록까지 한다.
 *
 * 부르는 쪽이 둘(첫 평가·주기 실행)이라 간격 검사와 기록을 여기 묶어
 * 둔다. 한쪽에서 빼먹으면 그쪽만 매 분 진입한다.
 */
export async function evaluateIfDue(
  sb: any, row: ScheduleRow, deps: DispatchDeps, nowMs: number,
): Promise<{ due: DueVerdict; record: EvaluationRecord | null; saveError: string | null }> {
  const due = dueCheck({
    nowMs, enabled: row.enabled, connectionId: row.connection_id ?? '',
    lastRunAtMs: row.last_run_at, intervalMin: row.interval_min,
  });

  // 연결이 없는 것은 **그 사실을 예약 줄에 남긴다.** 조용히 건너뛰면
  // 화면에는 '켜짐'만 보이고 왜 아무 일도 없는지가 어디에도 없다.
  if (due.code === 'NO_CONNECTION') {
    const save = await recordEvaluation(sb, row.id, {
      outcome: 'BLOCKED', summary: due.reason, source: deps.source,
    });
    return { due, record: null, saveError: save.error };
  }

  // **건너뛸 때는 `last_run_at`을 건드리지 않는다.** 건너뛴 것을 실행으로
  // 적으면 간격이 매번 갱신돼서 영원히 안 돈다.
  if (!due.due) return { due, record: null, saveError: null };

  // ── 선점 ──
  //
  // 예약을 보는 곳이 둘(GitHub 실행기 · Fly Worker)이다. 여기서 한 번
  // 못 박지 않으면 같은 순간에 둘 다 평가하고, 조건이 맞았으면 주문이
  // 두 번 나간다. **부르는 쪽마다 막지 않고 이 한 곳에서 막는다.**
  const claim = await claimSchedule(sb, row, nowMs);
  if (!claim.ok) {
    return {
      due: { ...due, due: false, code: claim.code === 'LOST' ? 'TOO_SOON' : due.code,
        reason: claim.reason },
      record: null, saveError: claim.code === 'FAILED' ? claim.reason : null,
    };
  }

  let record: EvaluationRecord;
  try {
    record = await evaluateSchedule(row, deps);
  } catch (e: any) {
    record = {
      scheduleId: row.id, symbol: row.symbol,
      strategyId: strategyIdOfRow(row), strategyVersion: String(row.strategy_version ?? ''),
      outcome: 'FAILED', summary: `평가를 부르지 못했습니다 — ${e?.message || e}`,
      executed: false, raw: null,
    };
  }
  const save = await recordEvaluation(sb, row.id, { ...record, source: deps.source });
  return { due, record, saveError: save.error };
}
