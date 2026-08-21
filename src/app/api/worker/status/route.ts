// GET /api/worker/status — 실행기(Worker) heartbeat 조회 (정상/지연/중단)
//
// **공급자 이름은 서버가 준다.** 화면에 'Railway'라고 적어 두었더니
// Fly로 옮긴 뒤에도 그 문구가 그대로 남아, 실제로는 Fly 워커가 살아
// 있는데 화면은 "Worker (Railway) · 없음"이라고 말했다. 이름을 값으로
// 내려보내면 다음에 옮길 때 화면을 고칠 일이 없다.
//
// 판정은 lib/jobs/executorHealth.ts에 있다. 여기서 임계값을 따로 갖고 있으면
// 화면은 '정상'인데 주문은 막히는(또는 그 반대) 상태가 생긴다 — 주문 경로도
// 같은 함수를 쓴다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { judgeExecutor } from '@/lib/jobs/executorHealth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  let row: any = null;
  let readFailed = false;
  try {
    const { data, error } = await (sb.from('worker_heartbeat') as any)
      .select('*').order('last_seen', { ascending: false }).limit(1).maybeSingle();
    if (error) readFailed = true;
    else row = data ?? null;
  } catch {
    readFailed = true;
  }

  const v = judgeExecutor(row, Date.now(), readFailed);

  // 어디서 도는가. **워커가 적은 값을 그대로 쓴다.**
  //
  // 이 자리는 두 번 틀렸다. 처음엔 화면 파일에 'Railway'가 글자로 박혀
  // 있었고(Fly로 옮긴 뒤에도 그대로였다), 그 다음엔 `WORKER_PROVIDER`
  // 환경변수로 옮겼는데 **아무도 안 넣어서** 계속 '실행기'였다.
  //
  // 두 번 다 사실을 아는 쪽이 적지 않아서 생긴 일이다. 워커는 자기가
  // Fly 위에 있는 걸 안다(FLY_APP_NAME 등). 이제 워커가 heartbeat에
  // 적고 여기서는 읽기만 한다 — 사람이 넣을 것도, 화면이 지어낼 것도 없다.
  //
  // 없으면 null이다. 화면은 그때 '실행기'라고만 적는다(언제나 참인 말).
  const provider = String(row?.provider || '').trim() || null;

  return NextResponse.json({
    present: v.status !== 'absent' && v.status !== 'unknown',
    provider,
    status: v.status,
    // 이 워커가 돌리고 있는 커밋. **비어 있으면 "같다"가 아니라 "모름"이다**
    version: row?.version ?? null,
    label: v.label,
    // 주문을 넣을 수 있는지를 화면이 직접 계산하지 않게 여기서 준다.
    // 화면이 계산하면 그것이 또 하나의 기준이 되고, 언젠가 주문 경로와 갈린다.
    canQueue: v.canQueue,
    reason: v.reason || null,
    workerId: v.workerId,
    lastSeen: row?.last_seen ?? null,
    ageSec: v.ageSec,
    task: row?.current_task ?? null,
    errorCount: row?.error_count ?? null,
    // 사람이 fly logs를 열지 않아도 되게, 워커가 적은 것을 그대로 준다.
    region: row?.region ?? null,
    machineId: row?.machine_id ?? null,
    startedAt: row?.started_at ?? null,
    tickCount: row?.tick_count ?? null,
    startupOk: row?.startup_ok ?? null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
