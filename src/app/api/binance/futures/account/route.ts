// /api/binance/futures/account
// 선물 잔고 + 포지션 조회 (읽기 전용)
// GET ?connectionId=xxx

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/exchanges/crypto';
import { getFuturesBalance, getFuturesPositions } from '@/lib/exchanges/binanceFutures';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn, error } = await (sb.from('exchange_connections') as any)
    .select('*').eq('id', connectionId).eq('user_id', uid).single();
  if (error || !conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }

  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }
  const apiKey = conn.api_key || '';
  const testnet = conn.is_testnet === true;

  const [bal, pos] = await Promise.all([
    getFuturesBalance(apiKey, secret, testnet),
    getFuturesPositions(apiKey, secret, testnet),
  ]);

  return NextResponse.json({
    testnet,
    balances:  bal.success ? bal.balances : [],
    positions: pos.success ? pos.positions : [],
    balanceMsg:  bal.message,
    positionMsg: pos.message,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
