// /api/system/deployment
//
// **"지금 무엇이 떠 있나"에 답하는 곳.**
//
// 왜 만드나
// ─────────
// 이 저장소는 같은 사고를 두 번 냈다.
//
//   2026-08-13  fly-deploy가 안 돌아 워커가 8월 9일 코드로 돌았다.
//               예약 폴링 코드는 들어간 적이 없었고, 판단 창을 놓쳤다.
//   2026-08-15  #128(고아 보호주문 정리)·#129(반복 스모크)를 합친 뒤에도
//               Fly에는 #127이 떠 있었다. fly-deploy의 workflow_run 실행은
//               남는데 job은 전부 skipped라 **배포가 도는 것처럼 보였다.**
//               그 상태에서 스모크를 돌렸고, Gate에 조건부 주문 2건이 남았다.
//
// 두 번 다 원인 추적의 절반이 "그래서 지금 배포된 게 뭐냐"였다. 그
// 질문에 답하는 화면도 API도 없었다 — `deploymentVerdict()`는 #133에서
// 만들어 두고 **아무 데도 배선되지 않았다.**
//
// 무엇을 돌려주나
// ───────────────
//   Vercel  이 프로세스가 빌드된 커밋 (VERCEL_GIT_COMMIT_SHA)
//   Fly     워커가 heartbeat에 적은 커밋 (Dockerfile ARG GIT_SHA)
//   main    **서버는 모른다.** 아는 척하지 않는다 — `?main=<sha>`로
//           주면 셋을 대조하고, 안 주면 웹↔워커만 대조한다.
//
// **비밀은 아무것도 내보내지 않는다.** SHA와 시각뿐이다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
// **값을 보여주지 않고 '같은 값인가'만 묻는다.** 워커도 같은 지문을
// 로그에 남기므로, 둘을 비교하면 같은 DB를 보고 있는지 알 수 있다.
import { fingerprintOf } from '@/lib/system/fingerprint';
import { runtimeSkew, deploymentVerdict, workerAlive } from '@/lib/runtime/workerPlan';
// 예약 주 경로가 도는가. **판정은 여기 없다** — 이 파일은 읽어서 넘긴다.
import {
  parseSchedulerReport, pickSchedulerRow, schedulerVerdict,
  type SchedulerReport, type SchedulerVerdict,
} from '@/lib/runtime/schedulerReport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 이 웹 프로세스의 커밋.
 *
 * Vercel이 넣어 주는 값이다. 로컬이나 다른 호스팅에서는 없을 수 있고,
 * **없으면 빈 문자열이다 — 지어내지 않는다.**
 */
function webSha(): { sha: string | null; source: string } {
  const v = String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim();
  if (v) return { sha: v, source: 'VERCEL_GIT_COMMIT_SHA' };
  const g = String(process.env.GIT_SHA || '').trim();
  if (g) return { sha: g, source: 'GIT_SHA' };
  return { sha: null, source: 'none' };
}

export async function GET(req: NextRequest) {
  const nowMs = Date.now();
  const web = webSha();
  // main은 **아무도 안 주면 모르는 것이다.** GitHub에 물으려면 토큰이
  // 필요하고, 그 호출이 실패하면 판정 전체가 UNKNOWN이 되어 웹↔워커
  // 대조까지 못 보게 된다. 그래서 선택 입력으로 둔다.
  const mainSha = String(req.nextUrl.searchParams.get('main') || '').trim() || null;

  const sb = getSupabaseAdmin();
  let fly: {
    sha: string | null; workerId: string | null; lastSeen: string | null;
    ageSec: number | null; alive: boolean | null; status: string | null; error: string | null;
  } = { sha: null, workerId: null, lastSeen: null, ageSec: null, alive: null, status: null, error: null };

  // ── 예약 주 경로 ──
  //
  // **undefined = 못 읽었다, null = 워커가 적은 적이 없다.** 둘 다
  // "안 돈다"가 아니다. 073이 아직인 배포에서는 칸 자체가 없다.
  let schedulerReport: SchedulerReport | null | undefined = undefined;
  let schedulerStandbyOnly = false;
  // ── 판정에 쓰는 값은 **전부 같은 워커 줄에서 나온다** ──
  //
  // 예전에는 보고를 main 락을 쥔 줄에서 고르고, 생존 여부는 `rows[0]`
  // (가장 최근 heartbeat)에서 계산해 **둘을 섞어서** 판정기에 넘겼다.
  // 그러면 이런 조합이 통과한다:
  //
  //   Worker A  main=true · 60초 전 폴링 · **죽었다**
  //   Worker B  standby   ·  2초 전 heartbeat
  //
  //   → 보고는 A, 생존은 B → 폴링 허용치(최대 5분) 안에서
  //     WORKER_PRIMARY_ACTIVE가 나온다. **아무도 예약을 안 보고 있는데.**
  //
  // isMain · lastPoll · startedAt · heartbeat 신선도가 모두 같은
  // `worker_id`에 귀속돼야 한다.
  let schedulerStartedIso: string | null = null;
  let schedulerAlive: boolean | null = null;
  let schedulerAgeSec: number | null = null;
  let schedulerWorkerId: string | null = null;

  if (!sb) {
    fly.error = 'supabase_not_configured';
  } else {
    try {
      // 머신이 둘이고 **예약은 main 락을 쥔 쪽만 본다.** 한 줄만 읽으면
      // 예비 워커를 보고 "안 돈다"고 적을 수 있다 — 틀린 빨강이다.
      const COLS = 'worker_id, last_seen, status, current_task, version, started_at';
      let { data, error } = await (sb as any).from('worker_heartbeat')
        .select(`${COLS}, scheduler`)
        .order('last_seen', { ascending: false }).limit(4);
      // 073이 아직인 배포. **생존 신호까지 같이 잃지 않는다** — 칸을 빼고
      // 다시 읽고, 예약 판정만 '모름'으로 둔다.
      if (error && /column|schema cache/i.test(String(error.message))) {
        ({ data, error } = await (sb as any).from('worker_heartbeat')
          .select(COLS).order('last_seen', { ascending: false }).limit(4));
      }
      if (error) throw new Error(error.message);
      const rows: any[] = Array.isArray(data) ? data : [];
      if (rows.some(r => 'scheduler' in (r ?? {}))) {
        const picked = pickSchedulerRow(rows);
        schedulerReport = parseSchedulerReport(picked.row?.scheduler);
        schedulerStandbyOnly = picked.standbyOnly;
        const pr: any = picked.row ?? null;
        // 방금 뜬 워커를 "한 번도 안 봤다"고 적지 않기 위한 기준 시각.
        schedulerStartedIso = pr?.started_at ?? null;
        schedulerWorkerId = pr?.worker_id ?? null;
        // **고른 줄의 heartbeat로 계산한다.** rows[0]을 쓰면 다른 워커의
        // 생존 신호로 이 워커가 살아 있다고 적게 된다.
        const pSeenMs = pr ? Date.parse(String(pr.last_seen)) : NaN;
        schedulerAgeSec = Number.isFinite(pSeenMs)
          ? Math.max(0, Math.round((nowMs - pSeenMs) / 1000)) : null;
        schedulerAlive = workerAlive(nowMs, Number.isFinite(pSeenMs) ? pSeenMs : null);
      }
      const row = rows[0] ?? null;
      if (row) {
        const seenMs = Date.parse(String(row.last_seen));
        fly = {
          // **빈 값은 "모름"이다.** 054가 아직이거나 GIT_SHA 없이 빌드된
          // 이미지다. 어느 쪽이든 "main과 같다"로 읽지 않는다.
          sha: String(row.version || '').trim() || null,
          workerId: row.worker_id ?? null,
          lastSeen: row.last_seen ?? null,
          ageSec: Number.isFinite(seenMs) ? Math.max(0, Math.round((nowMs - seenMs) / 1000)) : null,
          alive: workerAlive(nowMs, Number.isFinite(seenMs) ? seenMs : null),
          status: row.status ?? null,
          error: null,
        };
      } else {
        fly.error = 'heartbeat_empty';
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      fly.error = /column|schema cache/i.test(msg)
        ? 'version_column_missing — 마이그레이션 054를 자동으로 적용하는 중입니다'
        : msg;
    }
  }

  // 판정은 `schedulerReport.ts` 한 곳에 있다. 여기서 다시 판단하지 않는다.
  const scheduler: SchedulerVerdict = schedulerVerdict({
    // **전부 같은 줄에서 나온 값이다.** `fly.*`(가장 최근 heartbeat)를
    // 섞지 않는다 — 섞으면 죽은 main 워커가 살아 있는 예비 워커의
    // 생존 신호를 빌려 쓴다.
    report: schedulerReport, workerAlive: schedulerAlive,
    heartbeatAgeSec: schedulerAgeSec, standbyOnly: schedulerStandbyOnly,
    workerStartedIso: schedulerStartedIso, nowMs,
  });

  const skew = runtimeSkew({ vercelSha: web.sha, flySha: fly.sha });
  // ── 코드가 같아도 DB가 따라오지 않았으면 '배포 완료'가 아니다 ──
  //
  // **SHA 셋이 같다는 것과 그 코드가 제대로 돈다는 것은 다른 사실이다.**
  // 054가 없던 동안 세 SHA는 완벽히 같았고, 워커는 버전을 못 적었다.
  // 그래서 스키마까지 봐야 배포가 끝났다고 말할 수 있다.
  let migrationsApplied: boolean | null | undefined = undefined;
  let migrationCode: string | null = null;
  let pendingMigrations: string[] = [];
  try {
    if (!sb) throw new Error('supabase_not_configured');
    const { migrationGate } = await import('@/lib/system/migrationGate');
    const { migrationsAppliedOf } = await import('@/lib/system/migrationStatus');
    const ms = await migrationGate(sb);
    // **코드의 뜻은 코드가 정의된 곳에서 받는다.**
    //
    // 예전에는 여기서 직접 `code === 'UP_TO_DATE'`만 true로 읽었다.
    // 그래서 `DRIFT`가 false가 됐는데, DRIFT는 `pending: []` ·
    // `failed: []` · `entryAllowed: true`다 — 필수 마이그레이션은 전부
    // 적용돼 있고 과거 파일 내용이 바뀌었다는 경고일 뿐이다.
    // 050(#226)·016(#228)의 의도된 drift가 "DB 스키마가 따라오지
    // 않았습니다"라는 **영구 빨강**이 됐다.
    migrationCode = ms.code;
    migrationsApplied = migrationsAppliedOf(ms.code);
    pendingMigrations = ms.pending;
  } catch {
    migrationsApplied = null;
  }

  const full = deploymentVerdict({
    mainSha, vercelSha: web.sha, flySha: fly.sha, migrationsApplied, pendingMigrations,
  });

  return NextResponse.json({
    ok: true,
    nowIso: new Date(nowMs).toISOString(),
    // 배포가 끝났다고 말하려면 스키마도 따라와야 한다.
    migrations: {
      applied: migrationsApplied,
      // **경고를 숨기지 않는다.** applied는 "배포가 끝났는가"에만 답하고,
      // drift 같은 사실은 이 코드로 그대로 보인다.
      code: migrationCode,
      pending: pendingMigrations.slice(0, 10),
      pendingCount: pendingMigrations.length,
    },
    vercel: { sha: web.sha, short: web.sha ? web.sha.slice(0, 7) : null, source: web.source },
    fly: { ...fly, short: fly.sha ? fly.sha.slice(0, 7) : null },
    main: { sha: mainSha, short: mainSha ? mainSha.slice(0, 7) : null,
      note: mainSha ? '요청에서 받은 값입니다' : '서버는 main의 SHA를 모릅니다 — ?main=<sha>로 주면 셋을 대조합니다' },
    // ── 웹과 워커가 같은 데이터베이스를 보고 있는가 ──
    //
    // 2026-08-19에 이 질문에 답할 방법이 없었다. 워커는 살아서 tick을
    // 찍는데(build=5a45fa2), heartbeat 실패 로그도 없고, 표의 최신 줄은
    // 8/16이었다. 셋이 동시에 참이려면 **쓰기는 성공하는데 다른 곳에
    // 쓰고 있어야** 한다 — 그런데 그걸 확인할 값이 어디에도 없었다.
    //
    // 값은 안 보여준다. 지문 6자리만 준다. 워커도 부팅·heartbeat 로그에
    // 같은 방식의 지문을 남기므로 눈으로 대조하면 끝난다.
    supabase: {
      fingerprint: fingerprintOf(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
      note: '워커 로그의 `[heartbeat] ok ... target=<지문>`과 같아야 같은 DB입니다 — '
        + '다르면 워커가 다른 프로젝트에 쓰고 있습니다',
    },
    // ── 예약 평가를 지금 누가 돌리고 있는가 ──
    //
    // 주 실행자는 Fly Worker(`pollSchedules`)이고 GitHub `autotrade-tick`은
    // 예비다. 그런데 그게 실제로 도는지는 `fly logs`에만 있었다 —
    // **사람이 열어야 읽히는 사실은 없는 사실과 같다.**
    //
    // 이제 워커가 heartbeat에 적고 여기가 그대로 보여 준다. 값은 없다:
    // APP_URL·ADMIN_SECRET은 **있다/없다만** 들어 있다.
    scheduler: {
      code: scheduler.code,
      reason: scheduler.reason,
      evidence: scheduler.evidence,
      standbyOnly: scheduler.standbyOnly,
      // **어느 워커의 보고인지 밝힌다.** `fly.workerId`와 다를 수 있다 —
      // 가장 최근 heartbeat와 예약을 보는 워커가 다른 머신일 수 있고,
      // 그때 판정은 아래 workerId 쪽 값으로만 이뤄진다.
      workerId: schedulerWorkerId,
      heartbeatAgeSec: schedulerAgeSec,
      alive: schedulerAlive,
      report: schedulerReport ?? null,
      note: schedulerReport === undefined
        ? '워커 heartbeat에 예약 상태 칸이 없습니다 — 마이그레이션 073이 적용되고 워커가 다시 뜨면 채워집니다'
        : '값은 들어 있지 않습니다. 환경변수는 있다/없다만 적습니다',
    },
    // 서버가 스스로 답할 수 있는 것.
    skew,
    // main까지 준 경우의 판정. 안 줬으면 UNKNOWN이고 그게 정직한 값이다.
    verdict: full,
    note: '합쳤다고 배포된 것이 아닙니다. Fly SHA가 비어 있으면 "같다"가 아니라 "모름"입니다 — '
      + '마이그레이션 054 적용 후 다음 배포부터 채워집니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
