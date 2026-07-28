// /api/binance/spot/balance
//
// 현물 지갑 잔고. **선물 계좌와 절대 섞지 않는다.**
//
// 현물 잔액을 선물에서 쓸 수 있는 증거금처럼 계산하면, 실제로는 없는
// 증거금을 근거로 포지션 크기를 정하게 된다. 그래서 응답에 선물 관련
// 필드(증거금·미실현손익·포지션)를 아예 담지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const connectionId = req.nextUrl.searchParams.get('connectionId');
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();

  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }
  if (conn.has_withdrawal === true) {
    return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });
  }

  try {
    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { getBalancesBinance } = await import('@/lib/exchanges/binance');
    const secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || '');
    const balances = await getBalancesBinance(conn.api_key || '', secret);

    // 0인 자산은 빼되, 0이 아닌 것은 전부 돌려준다. 임의로 자르면
    // 사용자가 가진 것이 화면에서 사라진다.
    const held = (Array.isArray(balances) ? balances : [])
      .map(b => ({
        asset: String(b.currency || ''),
        free: Number(b.free) || 0,
        locked: Number(b.locked) || 0,
        valueUsd: b.valueUSD ?? null,
      }))
      .filter(b => b.asset && (b.free > 0 || b.locked > 0))
      .sort((a, b) => (b.free + b.locked) - (a.free + a.locked));

    const usdt = held.find(b => b.asset === 'USDT');

    return NextResponse.json({
      ok: true,
      marketType: 'SPOT',
      wallet: 'SPOT_WALLET',
      // 현물에서 "쓸 수 있는 돈"은 USDT 잔고다. 증거금이 아니다.
      availableUsdt: usdt ? usdt.free : 0,
      balances: held,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    // 조회 실패를 잔고 0으로 돌려주면 "돈이 없다"로 읽힌다. 실패는 실패로.
    return NextResponse.json(
      { ok: false, error: 'balance_failed', message: e?.message || '현물 잔고 조회 실패' },
      { status: 502 });
  }
}
