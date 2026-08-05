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

  const url = new URL(req.url);
  const testnet = url.searchParams.get('mode')?.toUpperCase() !== 'LIVE';
  // ── **어느 연결을 대조하는가** ──
  //
  // 이게 없어서 gatherAndReconcile이 활성 연결 중 **아무거나 하나**를
  // 집었다. 연결이 여럿이면 그건 화면이 보고 있는 것과 다른 거래소일 수
  // 있고, 남의 거래소 상태로 이 거래소의 주문을 막게 된다.
  //
  // 실제로 그랬다 — 바이낸스 실전 진입이 "Gate 401: Invalid key"로 막혔다.
  // Gate 키가 죽은 것과 바이낸스 주문은 아무 관계가 없다.
  //
  // 그 함수는 이미 connectionId를 받는데, 이 라우트만 안 넘기고 있었다.
  const connectionId = url.searchParams.get('connectionId');

  const { gatherAndReconcile } = await import('@/lib/engine/reconcileCheck');
  const r = await gatherAndReconcile(sb, userId, testnet, connectionId);

  if (!r.reachable || !r.verdict) {
    return NextResponse.json({
      ok: false, error: 'exchange_unreachable',
      // **원문을 버리지 않는다.** 화면에 "응답 없음"만 뜨면 원인이
      // 인증인지·망 불일치인지·연결을 잘못 집은 것인지 알 수 없다.
      message: `${r.error || '거래소 조회 실패'} — 대조할 수 없습니다`,
      detail: r.error || null,
      connectionId: connectionId || null,
      mode: testnet ? 'TESTNET' : 'LIVE',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  return NextResponse.json({
    ok: true,
    mode: testnet ? 'TESTNET' : 'LIVE',
    connectionId: connectionId || null,
    ...r.verdict,
    snapshot: {
      app: { positions: r.appPositions.length },
      exchange: { positions: r.exchangePositions.length },
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
