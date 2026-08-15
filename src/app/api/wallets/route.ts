// /api/wallets
//
// 통합 자산 트리. 현물 지갑과 선물 지갑을 **각각** 조회해서 나란히 돌려준다.
//
// 두 조회를 따로 하는 이유
// ────────────────────────
// 하나가 실패해도 나머지는 보여줘야 한다. 그런데 실패한 쪽을 0으로 채우면
// 총자산이 줄어든 것처럼 보이고 사용자는 손실이 난 줄 안다.
// 그래서 실패는 ok:false로 남기고, 합계는 lib/markets/wallets.ts가
// "한쪽이라도 모르면 null"로 처리한다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { readConnectionWallet } from '@/lib/markets/readWallet';

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

  // **조회는 readWallet 한 곳에 있다.** 지갑 개요(연결 여럿)가 같은
  // 함수를 쓴다 — 라우트 안에 두면 개요 쪽이 사본을 갖게 되고,
  // 그때 한쪽만 고쳐진다.
  const r = await readConnectionWallet(sb, uid, connectionId);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, ...(r.message ? { message: r.message } : {}) },
      { status: r.status });
  }
  const tree = r.tree!;

  return NextResponse.json({
    ok: true,
    tree,
    allocation: r.allocation,
    // 화면이 이 문장을 그대로 쓸 수 있게 여기서 정해 둔다.
    // 각 화면이 알아서 쓰면 어딘가는 "총자산으로 주문 가능"이라고 쓴다.
    note: '현물 잔고는 선물 증거금이 아닙니다. 선물에서 쓰려면 이체가 필요합니다.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
