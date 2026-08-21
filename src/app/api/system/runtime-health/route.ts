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

  return NextResponse.json({
    ok: true,
    health,
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
    checkedAt: Date.now(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
