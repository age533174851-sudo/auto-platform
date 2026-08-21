// src/lib/system/cronLog.ts
//
// 크론이 돌았다는 사실을 남긴다.
//
// **기록 실패가 작업을 막지 않는다.** 크론은 이미 할 일을 했고, 여기서
// 실패해도 그건 되돌려지지 않는다. 다만 조용히 넘기지 않고 응답에 적는다 —
// 안 그러면 "기록이 없다"가 '안 돌았다'와 '못 적었다' 둘 다를 뜻하게 되고,
// 이 표가 없애려는 모호함이 그대로 돌아온다.

export type CronStatus = 'ok' | 'failed' | 'skipped';

export async function recordCronRun(
  sb: any,
  job: string,
  status: CronStatus,
  detail?: string | null,
  startedAtMs?: number,
): Promise<{ saved: boolean; error: string | null }> {
  try {
    const now = Date.now();
    const { error } = await (sb as any).from('cron_runs').insert({
      job,
      status,
      detail: detail ? String(detail).slice(0, 500) : null,
      duration_ms: Number.isFinite(startedAtMs as any) ? Math.max(0, now - (startedAtMs as number)) : null,
      started_at: new Date(Number.isFinite(startedAtMs as any) ? (startedAtMs as number) : now).toISOString(),
    });
    if (error) throw new Error(error.message);
    return { saved: true, error: null };
  } catch (e: any) {
    const msg = String(e?.message || e);
    const missing = /cron_runs/i.test(msg) && /(does not exist|schema cache|relation)/i.test(msg);
    return {
      saved: false,
      error: missing ? 'cron_runs 표가 아직 없습니다 — 마이그레이션 029를 자동으로 적용하는 중입니다' : msg,
    };
  }
}

/**
 * 최근 실행 이력.
 *
 * **못 읽으면 null이다.** 빈 배열로 바꾸면 화면이 "한 번도 안 돌았다"로
 * 그리고, 그건 이 표가 없애려던 바로 그 거짓말이다.
 */
export async function readCronRuns(
  sb: any, sinceMs: number, limit = 200,
): Promise<Array<Record<string, any>> | null> {
  try {
    const { data, error } = await (sb as any).from('cron_runs')
      .select('job, status, detail, duration_ms, started_at')
      .gte('started_at', new Date(sinceMs).toISOString())
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  }
}
