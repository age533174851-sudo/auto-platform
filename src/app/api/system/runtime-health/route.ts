// GET /api/system/runtime-health — 워커가 성한가, 한자리에서
//
// **`fly logs`를 사람이 스크롤하는 일을 없앤다.**
//
// 2026-08-19에 사흘을 잃었다. 화면은 워커가 죽었다고 했고, 배포는 네 번
// 전부 success였고, Fly는 머신이 started라고 했고, Grafana에는 tick이
// 찍혔다. 넷이 동시에 참일 수 있는가 — 있다. 워커가 살아서 **다른
// 데이터베이스**에 쓰고 있으면 전부 참이다.
//
// 그 사실들이 서로 다른 대시보드 네 곳에 흩어져 있었고, 한자리에 모아
// 모순을 짚어 주는 것이 없었다. 이 라우트가 그 자리다.
//
// 판정은 여기 없다. `src/lib/runtime/runtimeHealth.ts`에 있고 테스트가
// 붙어 있다. 이 파일은 읽어 오기만 한다.
//
// **값은 나가지 않는다.** 지문(sha256 앞 6자)만 비교한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { runtimeHealthOf, autoFixPlan, type WorkerRow } from '@/lib/runtime/runtimeHealth';
import { fingerprintOf } from '@/lib/system/fingerprint';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // **못 읽은 것과 없는 것을 구분한다.** undefined=못 읽음, null=없음.
  let worker: WorkerRow | null | undefined = undefined;
  try {
    const { data, error } = await (sb.from('worker_heartbeat') as any)
      .select('*').order('last_seen', { ascending: false }).limit(1).maybeSingle();
    if (!error) worker = (data ?? null) as any;
  } catch { /* undefined로 남는다 */ }

  // 웹이 보고 있는 것들의 지문. 워커가 적은 것과 비교한다.
  const webSupabaseFp = fingerprintOf(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '');
  const webEncryptionFp = fingerprintOf(process.env.EXCHANGE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '');
  const webSha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim() || null;
  // 서버는 main의 SHA를 모른다. 아는 척하지 않는다 — 워크플로가 넘겨준다.
  const mainSha = String(req.nextUrl.searchParams.get('main') || '').trim() || webSha;

  const health = runtimeHealthOf({
    worker, webSupabaseFp, webEncryptionFp, mainSha, webSha, nowMs: Date.now(),
  });

  // 자동 복구를 계획할 때 **열린 주문 수를 먼저 본다.**
  // 모르면 재시작하지 않는다 — 그 사이 체결을 아무도 안 본다.
  let openOrders: number | null = null;
  try {
    const { count, error } = await (sb as any)
      .from('live_orders').select('id', { count: 'exact', head: true })
      .in('status', ['NEW', 'PARTIALLY_FILLED', 'OPEN', 'PENDING']);
    if (!error && typeof count === 'number') openOrders = count;
  } catch { /* null로 남는다 */ }

  const fix = autoFixPlan(health, { openOrders });

  // ── 청산 감시가 제때 돌고 있는가 ──
  //
  // 워커가 살아 있는 것과 청산 감시가 도는 것은 **다른 사실이다.**
  // 2026-08-03부터 다섯 달 동안 워커는 멀쩡했고 청산 감시만 죽어 있었다.
  const { exitCoverage, exitCoverageLine } = await import('@/lib/engine/exitCoverage');
  const { exitMonitorGate } = await import('@/lib/engine/exitMonitorGate');
  const em = await exitMonitorGate(sb);
  let lastRun: any = null;
  try {
    const { data } = await (sb as any).from('exit_monitor_runs')
      .select('id, started_at, finished_at, status, source, worker_sha, positions_scanned, actions, orphan_cleanups, next_expected_at, errors')
      .order('started_at', { ascending: false }).limit(1);
    lastRun = Array.isArray(data) ? (data[0] ?? null) : null;
  } catch { /* null — 못 읽은 것을 '안 돌았다'로 적지 않는다 */ }

  // ── 배포가 정말 끝났는가 · 시스템이 스스로 고친 적이 있는가 ──
  //
  // **사람이 GitHub Actions 화면을 열 이유가 없어야 한다.** 실행기가
  // 적어 둔 검증 결과와 복구 이력을 그대로 읽는다.
  let deployVerified: any = null;
  let heals: any[] = [];
  try {
    const { data } = await (sb as any).from('deployment_verifications')
      .select('checked_at, main_sha, fly_sha, worker_fresh, migrations_applied, verdict, reason')
      .order('checked_at', { ascending: false }).limit(1);
    deployVerified = Array.isArray(data) ? (data[0] ?? null) : null;
  } catch { /* null — 못 읽은 것을 '검증됨'으로 적지 않는다 */ }
  try {
    const { data } = await (sb as any).from('self_heal_runs')
      .select('started_at, finished_at, trigger, action, attempt, outcome, verified, detail, open_orders')
      .order('started_at', { ascending: false }).limit(5);
    heals = Array.isArray(data) ? data : [];
  } catch { /* [] */ }

  // ── 원장 수집이 돌고 있는가 ──
  //
  // "오늘 손익 확인 불가"만 보고는 원인을 못 고른다. 한 번도 수집되지
  // 않은 것인지 · 매 회차 실패하는 것인지 · 수집기가 멈춘 것인지는
  // 전혀 다른 일이고 대응도 다르다. 그걸 알아내는 방법이 **사람이 Fly
  // 로그를 여는 것**뿐이었다.
  //
  // 표를 새로 만들지 않는다 — `ledger_ingest_state`가 이미 다 갖고 있다.
  let ledgerIngest: any = null;
  try {
    const { ingestTargetsOf } = await import('@/lib/ledger/ingestTargets');
    const { ingestHealthOf } = await import('@/lib/ledger/ingestHealth');

    let targets: any = null;
    try {
      const { data, error } = await (sb as any).from('exchange_connections')
        .select('id, exchange_id, is_testnet, is_active').eq('user_id', uid);
      if (error) throw new Error(error.message);
      targets = ingestTargetsOf(data as any);
    } catch { targets = null; }   // **못 읽은 것을 '대상 없음'으로 적지 않는다**

    let states: any = null;
    try {
      const { data, error } = await (sb as any).from('ledger_ingest_state')
        .select('connection_id, env, covered_from, covered_to, last_run_at, last_written, last_error')
        .eq('user_id', uid);
      if (error) throw new Error(error.message);
      states = (Array.isArray(data) ? data : []).map((r: any) => ({
        connectionId: String(r.connection_id ?? ''),
        env: String(r.env ?? ''),
        coveredFromMs: Date.parse(String(r.covered_from ?? '')) || null,
        coveredToMs: Date.parse(String(r.covered_to ?? '')) || null,
        lastRunAtMs: Date.parse(String(r.last_run_at ?? '')) || null,
        lastWritten: r.last_written == null ? null : Number(r.last_written),
        lastError: r.last_error ?? null,
      }));
    } catch { states = null; }

    ledgerIngest = ingestHealthOf({ targets, states, nowMs: Date.now() });
  } catch (e: any) {
    ledgerIngest = { ok: false, code: 'STATES_UNKNOWN', rows: [],
      summary: '원장 수집 상태를 읽지 못했습니다 — 수집이 안 됐다는 뜻이 아닙니다' };
  }

  // ── 예약청산이 제 시각에 나가고 있는가 ──
  //
  // 워커가 살아 있는 것과 예약청산이 제때 나가는 것은 **다른 사실이다.**
  // 브라우저 없이 도는 실행기가 GitHub 예약뿐이던 동안, 실측 간격은
  // 중앙값 50분·최대 10시간이었고 유예는 30분이다 — 그 사이에 걸린
  // 예약은 유예를 넘겨 도착해 영원히 나가지 않았다.
  //
  // **결과를 본다.** 유예를 넘겨 남아 있는 예약이 그 증거다.
  let scheduledExit: any = null;
  try {
    const { scheduledExitRunnerOf, overdueExitsOf } = await import('@/lib/engine/scheduledExitRunner');
    const { DEFAULT_GRACE_MS } = await import('@/lib/engine/scheduleExit');
    let overdue: number | null = null;
    try {
      const { data, error } = await (sb as any).from('scheduled_exits')
        .select('run_at, fired_at, enabled').eq('user_id', uid)
        .is('fired_at', null).eq('enabled', true);
      if (error) throw new Error(error.message);
      overdue = overdueExitsOf(data as any, Date.now(), DEFAULT_GRACE_MS);
    } catch { overdue = null; }   // **못 셌으면 0이 아니다**
    const seen = worker?.last_seen ? Date.parse(String(worker.last_seen)) : NaN;
    scheduledExit = scheduledExitRunnerOf({
      workerLastSeenMs: Number.isFinite(seen) ? seen : null,
      overdue, nowMs: Date.now(), appOpen: false,
    });
  } catch (e: any) {
    scheduledExit = { code: 'UNKNOWN', canBeOnTime: false, browserFree: false, overdue: null,
      text: '예약청산 실행기 상태를 확인하지 못했습니다', detail: '' };
  }

  return NextResponse.json({
    ok: true,
    health,
    // 원장 수집. **사유는 키처럼 생긴 값을 지운 뒤에 나간다.**
    ledgerIngest,
    // 예약청산. **"제 시각에 나간다"를 근거 없이 적지 않는다.**
    scheduledExit,
    // **검증되지 않은 배포를 '완료'로 적지 않는다.**
    deployment: deployVerified == null ? {
      verdict: 'UNKNOWN',
      reason: '배포 검증 기록이 없습니다 — 검증됐다는 뜻이 아닙니다',
      checkedAt: null,
    } : {
      verdict: deployVerified.verdict,
      reason: deployVerified.reason,
      checkedAt: deployVerified.checked_at,
      mainSha: deployVerified.main_sha, flySha: deployVerified.fly_sha,
      workerFresh: deployVerified.worker_fresh,
      migrationsApplied: deployVerified.migrations_applied,
    },
    // 시스템이 스스로 한 일. 사람이 한 일이 아니다.
    selfHeal: heals.map((h: any) => ({
      startedAt: h.started_at, finishedAt: h.finished_at,
      trigger: h.trigger, action: h.action, attempt: h.attempt,
      outcome: h.outcome, verified: h.verified, detail: h.detail,
      openOrders: h.open_orders,
    })),
    worker: worker == null ? null : {
      workerId: worker.worker_id ?? null,
      // **사람이 넣는 값이 아니다.** 워커가 플랫폼 변수에서 읽어 적은 것이다.
      provider: worker.provider ?? null,
      region: worker.region ?? null,
      machineId: worker.machine_id ?? null,
      status: worker.status ?? null,
      version: worker.version ?? null,
      lastSeen: worker.last_seen ?? null,
      startedAt: worker.started_at ?? null,
      tickCount: worker.tick_count ?? null,
      startupOk: worker.startup_ok ?? null,
      startupDetail: worker.startup_detail ?? null,
      supabaseFingerprint: worker.supabase_fingerprint ?? null,
      encryptionFingerprint: worker.encryption_fingerprint ?? null,
    },
    web: { supabaseFingerprint: webSupabaseFp, encryptionFingerprint: webEncryptionFp, sha: webSha },
    openOrders,
    autoFix: fix,
    // **사람이 Fly 로그나 Actions 화면을 열 이유가 없게** 한 곳에 모은다.
    exitMonitor: {
      code: em.code,
      overdue: em.overdue,
      // ── 무엇을 안 보고 있는가 ──
      //
      // `code: 'OK'`는 **감시가 제때 돌았다**는 뜻이지, 모든 포지션을
      // 봤다는 뜻이 아니다. 감시는 `ladder_daily_trades`만 읽는데 그건
      // 계단식 전용 표라, scalp·my-original-v1 포지션은 트레일링·
      // 본전이동·시간청산·포지션점검을 한 번도 못 받는다.
      //
      // 그 사실이 어디에도 안 적히면 화면은 "청산 감시 정상"만 보여준다.
      // **안 보는 것은 이상 없음이 아니다.**
      coverage: { line: exitCoverageLine(), strategies: exitCoverage() },
      // 밀렸다고 바로 막지는 않는다. 막는 순간은 이 값이 true가 될 때다.
      blocksEntry: em.blockEntry,
      sinceSec: em.sinceSec,
      reason: em.reason,
      lastRun: lastRun == null ? null : {
        startedAt: lastRun.started_at ?? null,
        finishedAt: lastRun.finished_at ?? null,
        status: lastRun.status ?? null,
        source: lastRun.source ?? null,
        workerSha: lastRun.worker_sha ?? null,
        positionsScanned: lastRun.positions_scanned ?? null,
        actions: lastRun.actions ?? null,
        // #142 증거. 포지션이 0인데 남아 있던 보호주문을 정확한 번호로 치운 수.
        orphanCleanups: lastRun.orphan_cleanups ?? null,
        nextExpectedAt: lastRun.next_expected_at ?? null,
        errors: lastRun.errors ?? null,
      },
    },
    checkedAt: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
