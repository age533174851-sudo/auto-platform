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
// **관측만 한다.** 접속 대상을 고르지 않고, 불일치를 이유로 무엇도 막지 않는다.
import { observeServerSupabaseUrls } from '@/lib/supabase/urlObserve';
// 키의 **역할**만 본다 — 값도 서명도 내보내지 않는다.
import { keyIdentityOf } from '@/lib/supabase/keyIdentity';
// 캐시 A/B — **판정은 여기 없다.** 사실만 모아서 넘긴다.
import { cacheProbeVerdict, noStoreFetch, type ProbeArm } from '@/lib/supabase/cacheProbe';

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

  if (!sb) {
    fly.error = 'supabase_not_configured';
  } else {
    try {
      const { data, error } = await (sb as any).from('worker_heartbeat')
        .select('worker_id, last_seen, status, current_task, version')
        .order('last_seen', { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : null;
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

  // ── 이 client가 worker_heartbeat를 어떻게 보는가 ──
  //
  // **라우트가 실제로 쓰는 `sb`를 그대로 쓴다.** 진단용으로 client를
  // 새로 만들면 "진단은 되는데 실제 경로는 안 되는" 상태를 못 잡는다 —
  // 그게 지금 겪는 고장의 모양이다.
  //
  // 읽기만 한다. count · 최근 8줄 · 특정 worker_id 존재 여부 셋을
  // **같은 client로** 물어서, 어느 단계에서 갈라지는지 본다.
  //
  //   count가 0인데 워커는 RECORDED  → 이 client에게 줄이 안 보인다
  //   count는 있는데 최근 줄이 낡음   → 새 줄만 안 보인다
  //   특정 id를 콕 집으면 보임        → 정렬·필터 쪽 문제다
  //
  // `?worker=<id>`로 찾을 id를 준다. 없으면 그 항목은 건너뛴다 —
  // **id를 코드에 박지 않는다.**
  const wantWorker = String(req.nextUrl.searchParams.get('worker') || '').trim() || null;
  let visibility: any = { probed: false, note: 'supabase 미연결 — 조회하지 않았습니다' };
  if (sb) {
    const v: any = {
      probed: true,
      count: null as number | null,
      countError: null as string | null,
      recent: [] as any[],
      recentError: null as string | null,
      lookup: wantWorker ? { workerId: wantWorker, found: null as boolean | null, lastSeen: null as string | null, error: null as string | null } : null,
      note: '',
    };
    try {
      const r: any = await (sb as any).from('worker_heartbeat')
        .select('*', { count: 'exact', head: true });
      if (r?.error) v.countError = String(r.error.message || r.error);
      else v.count = typeof r?.count === 'number' ? r.count : null;
    } catch (e: any) { v.countError = String(e?.message || e); }

    try {
      const r: any = await (sb as any).from('worker_heartbeat')
        .select('worker_id, last_seen, version, provider, machine_id')
        .order('last_seen', { ascending: false }).limit(8);
      if (r?.error) v.recentError = String(r.error.message || r.error);
      else v.recent = (Array.isArray(r?.data) ? r.data : []).map((x: any) => {
        const t = Date.parse(String(x.last_seen));
        return {
          workerId: x.worker_id ?? null,
          lastSeen: x.last_seen ?? null,
          ageSec: Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null,
          short: String(x.version || '').trim().slice(0, 7) || null,
          provider: x.provider ?? null,
          machineId: x.machine_id ?? null,
        };
      });
    } catch (e: any) { v.recentError = String(e?.message || e); }

    if (wantWorker) {
      try {
        const r: any = await (sb as any).from('worker_heartbeat')
          .select('worker_id, last_seen').eq('worker_id', wantWorker).maybeSingle();
        if (r?.error) v.lookup.error = String(r.error.message || r.error);
        else {
          v.lookup.found = !!r?.data;
          v.lookup.lastSeen = r?.data?.last_seen ?? null;
        }
      } catch (e: any) { v.lookup.error = String(e?.message || e); }
    }

    v.note = v.count === 0
      ? '이 client에게는 worker_heartbeat가 **0줄**입니다 — 워커가 쓰고 있다면 권한/RLS로 가려진 것입니다'
      : v.count == null
        ? '줄 수를 세지 못했습니다 — 0줄이라는 뜻이 아닙니다'
        : `이 client에게 ${v.count}줄이 보입니다`;
    visibility = v;
  }

  // ── 같은 client가 같은 표를 읽는데 왜 한 질의만 낡았나 ──
  //
  // 실측(2026-08-24): 같은 요청 안에서 기존 fly 조회는 8/20을,
  // #195가 새로 넣은 조회는 1초 전을 돌려줬다. 권한도(service_role),
  // 프로젝트도(sameProject=true), 워커 쓰기도(RECORDED) 전부 정상이다.
  //
  // 남은 차이는 **질의의 모양**뿐이다. supabase-js는 PostgREST에 GET으로
  // 가고 컬럼 목록이 URL에 들어가므로, URL 단위로 캐시되는 무엇이 있다면
  // 정확히 이 모양이 된다.
  //
  // **그래도 단정하지 않는다.** 이 라우트에는 이미 force-dynamic이 있고,
  // 문서대로라면 그것만으로 데이터 캐시를 우회해야 한다. 그래서 잰다.
  //
  //   A 기존 질의        위에서 이미 돌았다 — **건드리지 않는다**
  //   B 같은 뜻 · 다른 URL  컬럼 하나만 더한다
  //   C no-store 강제     fetch에 cache:'no-store'를 준 client
  //
  // C는 **대조군 전용 client**다. 운영 경로(getSupabaseAdmin)는 그대로다 —
  // 캐시가 원인이라고 확정된 뒤에 붙일지 정한다.
  let cacheProbe: any = { probed: false, note: 'supabase 미연결 — 재지 않았습니다' };
  if (sb) {
    const armOf = async (run: () => Promise<any>): Promise<ProbeArm> => {
      try {
        const r: any = await run();
        if (r?.error) return { ran: true, lastSeen: null, error: String(r.error.message || r.error) };
        const row = Array.isArray(r?.data) ? r.data[0] : r?.data;
        return { ran: true, lastSeen: row?.last_seen ?? null, error: null };
      } catch (e: any) {
        return { ran: true, lastSeen: null, error: String(e?.message || e) };
      }
    };

    // A — 위에서 이미 돈 기존 질의의 결과를 그대로 쓴다. 다시 부르지 않는다.
    const baseline: ProbeArm = { ran: true, lastSeen: fly.lastSeen, error: fly.error };

    // B — 같은 뜻인데 컬럼 하나(machine_id)를 더해 URL만 다르게 한다.
    const variantUrl = await armOf(() => (sb as any).from('worker_heartbeat')
      .select('worker_id, last_seen, status, current_task, version, machine_id')
      .order('last_seen', { ascending: false }).limit(1));

    // C — 기존과 **완전히 같은 질의**를 no-store client로.
    //     URL이 같으므로 URL 때문인지 캐시 때문인지가 갈린다.
    let noStore: ProbeArm = { ran: false, lastSeen: null, error: 'no-store client를 만들지 못했습니다' };
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (url && key) {
        // **운영 client와 같은 URL·키를 쓴다.** 다른 것은 fetch뿐이다 —
        // 그래야 이 팔의 차이가 캐시 때문이라고 말할 수 있다.
        const probeClient: any = createClient(url, key, {
          auth: { autoRefreshToken: false, persistSession: false },
          global: { fetch: noStoreFetch() },
        });
        noStore = await armOf(() => probeClient.from('worker_heartbeat')
          .select('worker_id, last_seen, status, current_task, version')
          .order('last_seen', { ascending: false }).limit(1));
      }
    } catch (e: any) {
      noStore = { ran: false, lastSeen: null, error: String(e?.message || e) };
    }

    const verdict = cacheProbeVerdict({ baseline, variantUrl, noStore, nowMs });
    cacheProbe = {
      probed: true,
      ...verdict,
      arms: {
        baseline: { lastSeen: baseline.lastSeen, error: baseline.error, shape: 'worker_id,last_seen,status,current_task,version' },
        variantUrl: { lastSeen: variantUrl.lastSeen, error: variantUrl.error, shape: '+ machine_id (URL만 다름)' },
        noStore: { lastSeen: noStore.lastSeen, error: noStore.error, shape: '기존과 같은 컬럼 · fetch에 no-store' },
      },
      note: '이 조회들은 읽기만 합니다. 운영 client(getSupabaseAdmin)는 바꾸지 않았습니다.',
    };
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
      // ⚠ 이 지문은 **`SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL`**에서 온다.
      // 그런데 `getSupabaseAdmin()`은 `NEXT_PUBLIC_SUPABASE_URL`만 쓴다.
      // 둘이 다르면 **여기 뜨는 지문은 실제로 읽는 곳의 것이 아니다.**
      // 아래 `saw`가 그 두 이름을 각각 보여 준다.
      fingerprint: fingerprintOf(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
      note: '워커 로그의 `[heartbeat] ok ... target=<지문>`과 같아야 같은 DB입니다 — '
        + '다르면 워커가 다른 프로젝트에 쓰고 있습니다',

      // ── 두 이름이 각각 무엇을 가리키나 (관측만) ──
      //
      // 2026-08-24 실측: Fly 워커는 `verdict=RECORDED`로 쓰고 다시 읽어
      // 확인까지 했고, **웹과 같은 질의를 워커가 던지면 자기 줄이 최신으로
      // 나왔다.** 즉 DB는 정상이다. 그런데 이 API는 8/20 14:18의 줄을
      // 최신이라고 한다. 질의 모양이 같은데 결과가 다르면 남는 것은
      // **어디에 붙는가**뿐이다.
      //
      // 그래서 그 두 이름을 그대로 보여 준다. **값은 없다** — 있는지 ·
      // project ref · 지문 6자뿐이고, project ref는 브라우저 번들의
      // `NEXT_PUBLIC_SUPABASE_URL`에 이미 들어 있는 공개 값이다.
      //
      // **이 필드는 아무 동작도 바꾸지 않는다.** admin client가 무엇에
      // 붙는지도, 불일치일 때 무엇을 막을지도 여기서 정하지 않는다.
      // 값을 본 뒤에 그것을 정한다.
      ...observeServerSupabaseUrls(),

      // ── 무슨 자격으로 붙는가 ──
      //
      // URL이 같고 표도 같고 질의 모양도 같은데 결과가 다르면 남는 것은
      // **역할**이다. RLS는 역할에 따라 같은 질의를 다른 결과로 만들고,
      // SELECT를 막을 때는 오류가 아니라 **0줄**이다.
      //
      // 값도 서명도 내보내지 않는다 — 형식 · role · ref · 지문 6자뿐이다.
      // 워커도 부팅 때 같은 모양을 로그에 남기므로 눈으로 대조하면 된다.
      serviceKey: keyIdentityOf(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },

    // ── 같은 client인데 왜 한 질의만 낡았나 (A/B) ──
    //
    // 기존 질의는 손대지 않는다. 그 옆에 URL만 다른 팔과 no-store 팔을
    // 나란히 두고 어느 쪽이 신선한지만 본다.
    cacheProbe,

    // ── 이 client에게 worker_heartbeat가 어떻게 보이는가 ──
    //
    // **라우트가 실제로 쓰는 client로 조회한 결과다.** 진단 전용 client를
    // 따로 만들지 않는다.
    visibility,
    // 서버가 스스로 답할 수 있는 것.
    skew,
    // main까지 준 경우의 판정. 안 줬으면 UNKNOWN이고 그게 정직한 값이다.
    verdict: full,
    note: '합쳤다고 배포된 것이 아닙니다. Fly SHA가 비어 있으면 "같다"가 아니라 "모름"입니다 — '
      + '마이그레이션 054 적용 후 다음 배포부터 채워집니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
