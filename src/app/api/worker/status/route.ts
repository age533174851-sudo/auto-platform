// GET /api/worker/status — Railway Worker heartbeat 조회 (정상/지연/중단)
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

  return NextResponse.json({
    present: v.status !== 'absent' && v.status !== 'unknown',
    status: v.status,
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
  }, { headers: { 'Cache-Control': 'no-store' } });
}
