// src/lib/autotrade/scheduleProbe.ts
//
// **"fly logs를 열어 확인해 주세요"를 없애는 코드.**
//
// 무엇이 없었나
// ─────────────
// 2026-10-26 09:16 KST 틱의 응답은 이랬다:
//
//   {"scheduled":2,"results":[
//     {"symbol":"BTCUSDT","mode":"TESTNET","skipped":true,
//      "code":"WAITING","detail":"다음 평가까지 54분 남았습니다"}, …]}
//
// 여기서 **답할 수 없는 것**이 셋이다:
//
//   · 이 예약은 **어느 전략**인가 (09:00 강제 진입인가, 09:10 원본인가,
//     계단식인가)
//   · 마지막 평가는 **언제** 있었나 — "54분 남음"을 간격으로 역산해야
//     09:10을 알 수 있다. 사람이 암산할 일이 아니다
//   · 그 평가는 **무엇을 결정했나** — 진입했나, 관망했나, 막혔나
//
// 세 가지 모두 예약 줄에 이미 적혀 있다(`strategy_id` · `last_run_at` ·
// `last_outcome` · `last_reason`). 라우트가 `select('*')`로 읽어 놓고
// **응답에 넣지 않았을 뿐이다.**
//
// 그래서 "오늘 9시에 뭐가 돌았나"의 답이 Fly 로그에만 있었다. 주 실행기가
// 선점을 이기면 GitHub 쪽은 평가를 **보지도 못하므로**, 예비 경로의 로그는
// 영원히 `skipped`만 적는다.
//
// 이 저장소의 최상위 규칙 그대로다 — 사람이 대시보드를 돌아다녀야 하는
// 절차가 생기면, 그 절차를 없애는 코드를 먼저 쓴다.
//
// 무엇을 넣지 않는가
// ──────────────────
// 키·시크릿은 물론이고 **예외 문구를 새로 끌어오지 않는다.** 여기 실리는
// 값은 전부 예약 줄에 우리 코드가 적어 둔 것이고, 같은 라우트가 이미
// `detail`로 내보내는 것과 같은 종류다. 이 응답은 `x-admin-secret`
// 또는 로그인 토큰이 있어야 받는다.

import { strategyIdOfRow } from '../strategies/registry';
import { entryWindowOf } from './entryWindowDue';

export interface ScheduleProbe {
  /** 이 예약이 실제로 돌리는 전략. 값이 없으면 계단식으로 되돌린다 */
  strategyId: string;
  /** 마지막 평가 시각. **없으면 null — 0이나 빈 문자열로 적지 않는다** */
  lastRunAt: string | null;
  /** 그 평가의 결론 (ENTERED · NO_TRADE · BLOCKED · FAILED …) */
  lastOutcome: string | null;
  /** 그 결론의 이유 */
  lastReason: string | null;
  /**
   * 이 예약이 **시각 창을 가진 전략인가.** 가졌으면 "HH:MM~HH:MM KST".
   *
   * 9시 창을 기대했는데 창이 없는 전략이면 그 사실이 여기서 바로 보인다 —
   * 지금까지는 DB를 열어야 알 수 있었다.
   */
  entryWindowKst: string | null;
}

const text = (v: any): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * 예약 줄에서 "무엇이 돌고 있고 마지막에 뭘 했나"를 뽑는다.
 *
 * **읽기만 한다.** 없는 값을 지어내지 않고, 모르면 null이다.
 */
export function scheduleProbeOf(row: any): ScheduleProbe {
  const strategyId = strategyIdOfRow(row);
  const w = entryWindowOf(strategyId, {
    profileId: row?.execution_profile_id,
    presetId: row?.execution_preset_id,
  });
  return {
    strategyId,
    lastRunAt: text(row?.last_run_at),
    lastOutcome: text(row?.last_outcome),
    lastReason: text(row?.last_reason),
    entryWindowKst: w
      ? `${hhmm(w.startMin)}~${hhmm(w.endMin)}${w.graceMin > 0 ? ` (+${w.graceMin}분 유예)` : ''}`
      : null,
  };
}
