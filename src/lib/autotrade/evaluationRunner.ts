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
import { decisionRecordOf } from '../ui/autoOverview';
import { dueCheck, verdictOfOutcome, resultLineOf, type DueVerdict } from './evaluationLoop';

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
      const res = await doFetch(`${deps.origin}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': deps.adminSecret },
        body: JSON.stringify({
          userId: row.user_id,
          symbol: ctx.symbol,
          mode: ctx.mode,
          connectionId: ctx.connectionId,
          // **평가 주기를 반드시 싣는다.**
          //
          // 안 실으면 받는 쪽이 자기 기본값을 쓴다. scalp은
          // `Number(body.intervalMin ?? 60)`이라 예약에 5분을 저장해도
          // **항상 60분봉으로 돌았다** — 오류 없이 다른 전략이 되는 모양이다.
          intervalMin: ctx.intervalMin ?? null,
          // **`?? null`로 눕혀 보낸다.** undefined는 JSON에서 사라지고,
          // 받는 쪽이 0으로 읽으면 배율 상한 0이 되어 주문이 통째로 막힌다.
          leverageCap: ctx.leverageCap ?? null,
          riskPct: ctx.riskPct ?? null,
          marginPct: ctx.marginPct ?? null,
          idempotencyKey: ctx.idempotencyKey ?? null,
        }),
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
  sb: any, scheduleId: string, rec: { outcome: EvaluationOutcome | string; summary: any; raw?: any },
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
      outcome: 'BLOCKED', summary: due.reason,
    });
    return { due, record: null, saveError: save.error };
  }

  // **건너뛸 때는 `last_run_at`을 건드리지 않는다.** 건너뛴 것을 실행으로
  // 적으면 간격이 매번 갱신돼서 영원히 안 돈다.
  if (!due.due) return { due, record: null, saveError: null };

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
  const save = await recordEvaluation(sb, row.id, record);
  return { due, record, saveError: save.error };
}
