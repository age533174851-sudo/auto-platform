// /api/binance/futures/cancel-all — jobs 큐에 CANCEL_ALL_ORDERS 적재 (Worker 실행)
// POST { connectionId }
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { enqueueJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, is_testnet, has_withdrawal').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  if (conn.has_withdrawal === true) return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });

  const r = await enqueueJob(sb, { userId: uid, connectionId, action: 'CANCEL_ALL_ORDERS', mode: conn.is_testnet ? 'TESTNET' : 'LIVE', priority: 1, maxAttempts: 5 });
  if (!r.ok) return NextResponse.json({ error: 'enqueue_failed', message: r.error }, { status: 500 });
  return NextResponse.json({ ok: true, queued: true, jobId: r.jobId });
}
