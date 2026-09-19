// /api/paper/holdings — 모의 현물 보유
// GET ?challengeId=...
//
// **집계는 이 라우트가 하지 않는다.** `paper_holdings`(088) 하나가 한다.
// 여기서 다시 더하면 파는 수량과 보여 주는 수량이 갈린다 — 그 순간
// 사용자는 있지도 않은 것을 팔려고 한다.
//
// 평가손익·수익률은 **내보내지 않는다.** 열린 포지션의 미실현 손익 정본이
// 이 저장소에 없고, 여기서 만들면 세 번째 손익 권위가 생긴다.
// `avgPrice`는 **수수료를 넣지 않은 체결평균가**다. 취득원가(수수료 포함)는
// `totalNotional`·`entryFeeBasis`로 따로 나간다 — 같은 이름으로 섞지 않는다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const { resolveHoldingScope, holdingScopeFailed } =
    await import('@/lib/engine/paperHoldingScope');
  const scope = await resolveHoldingScope(
    sb, uid, req.nextUrl.searchParams.get('challengeId'));
  if (holdingScopeFailed(scope)) {
    return NextResponse.json({
      ok: false,
      error: scope.code === 'UNREADABLE' ? 'scope_unreadable' : 'challenge_not_found',
      message: scope.reason,
    }, { status: scope.status, headers: { 'Cache-Control': 'no-store' } });
  }

  // 생성된 Supabase 타입에는 이 함수가 없다(088이 새로 만든다 — 타입 재생성이
  // 밀려 있다). 같은 이유로 챌린지 라우트들도 이렇게 부른다. 값은 DB에 실재한다.
  const { data, error } = await (sb as any).rpc('paper_holdings', {
    p_user: uid, p_paper_account_id: scope.accountId,
  });
  // **조회 실패는 "보유 0건"이 아니다.** 0건으로 그리면 사용자는 자산이
  // 사라진 화면을 본다.
  if (error) {
    return NextResponse.json({
      ok: false, error: 'holdings_unreadable',
      message: '보유를 읽지 못했습니다 — 보유가 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!Array.isArray(data)) {
    return NextResponse.json({
      ok: false, error: 'holdings_unreadable',
      message: '보유 응답이 목록이 아닙니다 — 보유가 없다는 뜻이 아닙니다',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  const holdings = data.map((r: any) => ({
    symbol: String(r.h_symbol),
    market: String(r.h_market),
    quantity: Number(r.h_quantity),
    // 남은 취득 명목. 수수료는 아래 칸에 따로 있다.
    totalNotional: Number(r.h_notional),
    entryFeeBasis: Number(r.h_fee_basis),
    // 수수료 **제외** 체결평균가. null이면 모르는 것이지 0이 아니다.
    avgPrice: r.h_avg_price == null ? null : Number(r.h_avg_price),
    lots: Number(r.h_lots),
  }));

  return NextResponse.json({
    ok: true, paper: true,
    challengeId: scope.challengeId,
    // 어떤 뜻의 평균가인지 값으로 들고 다닌다. 화면이 라벨을 지어내지 않게.
    avgPriceBasis: 'EXECUTION_AVERAGE_FEE_EXCLUDED',
    unrealizedPnl: 'UNAVAILABLE_NO_AUTHORITY',
    holdings,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
