// /api/reconcile/state
//
// 앱이 아는 상태와 거래소 실제 상태를 대조한다.
//
// 조회는 lib/engine/reconcileCheck.ts, 판정은 lib/engine/stateReconcile.ts에
// 있다. 이 라우트는 인증하고 결과를 형식화할 뿐이다. 주문 경로도 같은 수집
// 함수를 쓰므로, 화면이 보는 판정과 주문이 막히는 근거가 항상 같다.
//
// 조치는 하지 않는다 — 판정만 돌려준다. 일시적인 조회 실패로 실제 포지션을
// 자동 정리하면 되돌릴 수 없다.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { getUserIdFromRequest, getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const userId = await getUserIdFromRequest(req.headers.get('authorization'));
  if (!userId) {
    return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const testnet = new URL(req.url).searchParams.get('mode')?.toUpperCase() !== 'LIVE';

  const { gatherAndReconcile } = await import('@/lib/engine/reconcileCheck');
  const r = await gatherAndReconcile(sb, userId, testnet);

  if (!r.reachable || !r.verdict) {
    return NextResponse.json({
      ok: false, error: 'exchange_unreachable',
      message: `${r.error || '거래소 조회 실패'} — 대조할 수 없습니다`,
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({
    ok: true,
    mode: testnet ? 'TESTNET' : 'LIVE',
    ...r.verdict,
    snapshot: {
      app: { positions: r.appPositions.length },
      exchange: { positions: r.exchangePositions.length },
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
