// src/lib/engine/exitMonitorGate.ts
//
// **못 여는 것은 불편이고 못 닫는 것은 사고다.**
//
// 청산 감시가 죽으면 트레일링도, 본전 이동도, 시간 청산도 안 돈다.
// 그 상태에서 새 포지션을 열면 **닫아 줄 사람이 없는 포지션**이 하나
// 더 생긴다. 2026-08-03부터 다섯 달 동안 정확히 그 상태였다.
//
// 다만 한두 번 밀렸다고 매매를 멈추면 배포 한 번에 하루가 멈춘다.
// 판정은 exitMonitorLease.ts의 `exitMonitorOverdue`가 하고, 여기서는
// 그걸 읽어 오기만 한다.
import { exitMonitorOverdue, type OverdueVerdict } from './exitMonitorLease';
import { EXIT_MONITOR_INTERVAL_MS } from './exitMonitorSchedule';

/**
 * 마지막으로 **성공한** 청산 감시 회차.
 *
 * 실패한 회차는 세지 않는다 — 돌긴 돌았는데 아무것도 못 한 것은
 * 안 돈 것과 같다.
 */
export async function lastExitMonitorSuccess(sb: any): Promise<number | null | undefined> {
  try {
    const { data, error } = await (sb as any)
      .from('exit_monitor_runs')
      .select('finished_at, started_at, status')
      .eq('status', 'OK')
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) {
      // 058이 아직인 배포. **못 읽은 것이 아니라 '아직'이다** —
      // 이 둘을 섞으면 배포 순간 자동매매가 멈춘다.
      if (/does not exist|schema cache|relation/i.test(String(error.message))) return null;
      return undefined;
    }
    const row: any = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    const t = Date.parse(String(row.finished_at || row.started_at || ''));
    return Number.isFinite(t) ? t : null;
  } catch {
    return undefined;   // 못 읽었다 — '안 돌았다'가 아니다
  }
}

/** 청산 감시가 죽은 채로 새 포지션을 열지 않는다 */
export async function exitMonitorGate(sb: any, nowMs?: number): Promise<OverdueVerdict> {
  const last = await lastExitMonitorSuccess(sb);
  return exitMonitorOverdue({
    lastSuccessMs: last,
    nowMs: Number.isFinite(nowMs as number) ? (nowMs as number) : Date.now(),
    intervalMs: EXIT_MONITOR_INTERVAL_MS,
  });
}
