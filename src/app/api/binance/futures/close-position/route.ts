// /api/binance/futures/close-position
// 거래소 직접 호출 X → jobs 큐에 CLOSE_POSITION 적재. Worker가 실행.
// POST { connectionId, symbol, positionSide: 'LONG'|'SHORT', quantity, percent }

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

  const { connectionId, symbol, positionSide, quantity, percent = 100 } = body;
  if (!connectionId || !symbol || !positionSide || quantity == null) {
    return NextResponse.json({ error: 'missing_params', message: 'connectionId·symbol·positionSide·quantity 필수' }, { status: 400 });
  }
  if (positionSide !== 'LONG' && positionSide !== 'SHORT') {
    return NextResponse.json({ error: 'invalid_position_side' }, { status: 400 });
  }

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, is_testnet, has_withdrawal').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  if (conn.has_withdrawal === true) return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });

  const r = await enqueueJob(sb, {
    userId: uid, connectionId, action: 'CLOSE_POSITION',
    mode: conn.is_testnet ? 'TESTNET' : 'LIVE', symbol, side: positionSide,
    quantity: Math.abs(Number(quantity)), percent: Number(percent) || 100,
    priority: 2,
  });
  if (!r.ok) return NextResponse.json({ error: 'enqueue_failed', message: r.error }, { status: 500 });
  return NextResponse.json({ ok: true, queued: true, jobId: r.jobId });
}
