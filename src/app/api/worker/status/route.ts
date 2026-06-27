// GET /api/worker/status — Railway Worker heartbeat 조회 (정상/지연/중단)
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  try {
    const { data, error } = await (sb.from('worker_heartbeat') as any)
      .select('*').order('last_seen', { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return NextResponse.json({ present: false, status: 'absent', label: '워커 없음' });

    const ageMs = Date.now() - new Date(data.last_seen).getTime();
    let status = 'running', label = '정상';
    if (data.status === 'stopped') { status = 'stopped'; label = '중단'; }
    else if (ageMs > 60_000) { status = 'stopped'; label = '중단(heartbeat 끊김)'; }
    else if (ageMs > 25_000 || data.status === 'degraded') { status = 'degraded'; label = '지연'; }

    return NextResponse.json({
      present: true, status, label,
      workerId: data.worker_id, lastSeen: data.last_seen, ageSec: Math.round(ageMs / 1000),
      task: data.current_task, errorCount: data.error_count,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ present: false, status: 'error', label: '조회 실패', error: e?.message });
  }
}
