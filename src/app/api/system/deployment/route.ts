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
// **admin client가 URL을 고르는 바로 그 함수.** 진단이 따로 고르면
// 화면의 지문과 실제로 읽는 DB가 갈린다 — 실제로 그랬다.
import { serverSupabaseUrl } from '@/lib/supabase/url';

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
  // getSupabaseAdmin이 쓴 것과 **같은 해석 결과**다. 따로 계산하지 않는다.
  const supabaseUrl = serverSupabaseUrl();
  /** worker_heartbeat의 최근 몇 줄. **읽기만 한다.** */
  let workerRows: any[] = [];
  let fly: {
    sha: string | null; workerId: string | null; lastSeen: string | null;
    ageSec: number | null; alive: boolean | null; status: string | null; error: string | null;
  } = { sha: null, workerId: null, lastSeen: null, ageSec: null, alive: null, status: null, error: null };

  if (!sb) {
    fly.error = 'supabase_not_configured';
  } else {
    try {
      // ── 한 줄만 보면 모순을 좁힐 수 없다 ──
      //
      // 예전에는 `limit(1)`이었다. 그래서 "최신 줄이 8/21"만 보였고,
      // **지금 도는 Fly machine의 줄이 아예 없는 것인지, 있는데 안
      // 갱신되는 것인지** 구분할 수 없었다. 둘은 완전히 다른 고장이다.
      //
      // 몇 줄만 읽는다. worker_id·machine_id·project ref는 비밀이 아니다.
      const { data, error } = await (sb as any).from('worker_heartbeat')
        .select('worker_id, last_seen, status, current_task, version, provider, region, machine_id, supabase_fingerprint, project_ref, tick_count, startup_ok')
        .order('last_seen', { ascending: false }).limit(8);
      if (error) throw new Error(error.message);
      const rows: any[] = Array.isArray(data) ? data : [];
      workerRows = rows.map(r => {
        const t = Date.parse(String(r.last_seen));
        return {
          workerId: r.worker_id ?? null,
          lastSeen: r.last_seen ?? null,
          ageSec: Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null,
          version: String(r.version || '').trim() || null,
          short: String(r.version || '').trim().slice(0, 7) || null,
          provider: r.provider ?? null,
          region: r.region ?? null,
          machineId: r.machine_id ?? null,
          // **워커가 스스로 적은 값이다.** 위 supabase.projectRef와
          // 대조하면 같은 DB인지를 지문 6자에 기대지 않고 확인할 수 있다.
          projectRef: r.project_ref ?? null,
          supabaseFingerprint: r.supabase_fingerprint ?? null,
          tickCount: r.tick_count ?? null,
          startupOk: r.startup_ok ?? null,
        };
      });
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

  const skew = runtimeSkew({ vercelSha: web.sha, flySha: fly.sha });
  // ── 코드가 같아도 DB가 따라오지 않았으면 '배포 완료'가 아니다 ──
  //
  // **SHA 셋이 같다는 것과 그 코드가 제대로 돈다는 것은 다른 사실이다.**
  // 054가 없던 동안 세 SHA는 완벽히 같았고, 워커는 버전을 못 적었다.
  // 그래서 스키마까지 봐야 배포가 끝났다고 말할 수 있다.
  let migrationsApplied: boolean | null | undefined = undefined;
  let pendingMigrations: string[] = [];
  try {
    if (!sb) throw new Error('supabase_not_configured');
    const { migrationGate } = await import('@/lib/system/migrationGate');
    const ms = await migrationGate(sb);
    // UNKNOWN(기록을 못 읽음)은 null — **모르는 것을 '됐다'로 읽지 않는다**
    migrationsApplied = ms.code === 'UP_TO_DATE' ? true
      : ms.code === 'UNKNOWN' ? null : false;
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
      pending: pendingMigrations.slice(0, 10),
      pendingCount: pendingMigrations.length,
      // ── 이 숫자가 **어느 데이터베이스의 사실인가** ──
      //
      // migrate 워크플로는 `SUPABASE_DB_URL`로 psql을 붙어 "남음 0"이라
      // 하고, 여기는 admin client로 `schema_migrations`를 읽어 62라고
      // 한 적이 있다. 두 숫자가 다른 이유는 세는 방법이 아니라 **세는
      // 대상이 달랐기** 때문이다.
      //
      // 그래서 어디서 읽었는지를 같이 준다. 이 지문이 migrate 로그의
      // 지문과 다르면 두 숫자를 비교하는 것 자체가 틀린 것이다.
      readFrom: {
        fingerprint: supabaseUrl.fingerprint,
        projectRef: supabaseUrl.projectRef,
        source: supabaseUrl.source,
        note: 'admin client가 읽은 곳입니다. migrate 워크플로는 SUPABASE_DB_URL로 붙습니다 — 둘이 다르면 남음 개수도 다릅니다',
      },
      // ── 이 숫자는 **무엇을 근거로** 세는가 ──
      //
      // migrate 워크플로의 "남음 0"과 여기의 62가 다를 수 있는 이유는
      // 데이터베이스만이 아니다. 두 경로는 같은 표(`schema_migrations`)를
      // 보지만 **판정 기준이 다르다**:
      //
      //   migrate   파일을 실행했거나, 카탈로그에 이미 있어 '채택'한 것을
      //             적용됨으로 기록한다 (scripts/apply-migrations.mjs)
      //   여기      코드의 REQUIRED_MIGRATIONS(migrationManifest.ts)와
      //             표의 줄을 대조하고 **체크섬까지 본다**
      //
      // 그래서 같은 DB라도 (a) 매니페스트가 파일보다 앞서거나
      // (b) 체크섬이 어긋나면 여기만 남음으로 센다. 어느 쪽인지 보이게
      // 기준을 적어 둔다 — 두 숫자를 비교하려면 기준부터 같아야 한다.
      basis: {
        source: 'schema_migrations',
        comparedAgainst: 'REQUIRED_MIGRATIONS (src/lib/system/migrationManifest.ts)',
        checksumChecked: true,
        note: 'migrate 워크플로는 실행·채택 기준입니다. 이 값은 매니페스트 대조 + 체크섬 기준이라 같은 DB에서도 다를 수 있습니다',
      },
    },
    vercel: { sha: web.sha, short: web.sha ? web.sha.slice(0, 7) : null, source: web.source },
    fly: { ...fly, short: fly.sha ? fly.sha.slice(0, 7) : null },
    // ── 표에 실제로 어떤 줄들이 있는가 ──
    //
    // "최신 줄이 8/21"과 "지금 도는 machine의 줄이 없다"는 다른 사실이다.
    // 한 줄만 보여 주면 그 둘을 구분할 수 없어서 몇 줄을 그대로 보여 준다.
    // **읽기만 한다.** 값은 없다 — worker_id·machine_id·project ref뿐이다.
    workers: {
      rows: workerRows,
      count: workerRows.length,
      note: workerRows.length === 0
        ? 'worker_heartbeat에 줄이 없습니다 — 워커가 이 데이터베이스에 한 번도 쓰지 못했습니다'
        : '워커가 스스로 적은 projectRef와 위 supabase.projectRef가 다르면 서로 다른 프로젝트입니다',
    },
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
      // **admin client가 실제로 고른 URL의 지문이다.**
      //
      // 예전에는 `SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL`로 따로
      // 계산했다. 그런데 그 줄을 읽는 admin client는
      // `NEXT_PUBLIC_SUPABASE_URL`만 썼다 — 둘이 다르면 **여기 뜨는
      // 지문은 실제로 읽는 DB의 것이 아니었다.** 워커가 heartbeat를
      // 잘 쓰고 있는데도 여기서는 8/20 줄이 최신으로 보인 이유다.
      fingerprint: supabaseUrl.fingerprint,
      projectRef: supabaseUrl.projectRef,
      source: supabaseUrl.source,
      code: supabaseUrl.code,
      // 두 이름이 각각 무엇을 가리켰나. 값이 아니라 지문과 ref다.
      saw: supabaseUrl.saw,
      mismatch: supabaseUrl.code === 'URL_MISMATCH' ? supabaseUrl.message : null,
      note: '워커 로그의 `[heartbeat] ok ... target=<지문>`과 같아야 같은 DB입니다 — '
        + '다르면 워커가 다른 프로젝트에 쓰고 있습니다',
    },
    // 서버가 스스로 답할 수 있는 것.
    skew,
    // main까지 준 경우의 판정. 안 줬으면 UNKNOWN이고 그게 정직한 값이다.
    verdict: full,
    note: '합쳤다고 배포된 것이 아닙니다. Fly SHA가 비어 있으면 "같다"가 아니라 "모름"입니다 — '
      + '마이그레이션 054 적용 후 다음 배포부터 채워집니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
