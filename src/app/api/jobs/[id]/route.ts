// GET /api/jobs/[id] — 작업 상태 조회 (요청접수/처리중/성공/실패)
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { data, error } = await (sb.from('jobs') as any)
    .select('id, action, status, symbol, attempts, max_attempts, result, error, created_at, completed_at')
    .eq('id', params.id).eq('user_id', uid).single();
  if (error || !data) return NextResponse.json({ error: 'job_not_found' }, { status: 404 });

  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
