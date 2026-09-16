// /api/paper/close — 모의 포지션 청산
// POST { positionId }
//
// 청산가는 **서버가 읽는 값**이다. 화면이 보낸 값을 쓰면 유리한 가격에
// 닫아 장부를 만들 수 있고, 그러면 성적표가 의미를 잃는다.
//
// **어느 시장의 가격인가**
// ────────────────────────
// 여기가 고장이었다. 이 라우트는 `pos.market`을 한 번도 보지 않고 언제나
// 선물 `getPremiumIndex`를 불렀다. 그래서 현물로 산 포지션이 선물 마크가로
// 닫혔다 — **같은 포지션의 가격 권위가 진입과 청산에서 달랐다.**
//
// 진입 라우트는 이미 시장을 보고 출처를 갈랐고, 그 이유를 스스로 적어
// 두었다: "선물 마크가로 현물을 채우면 펀딩·베이시스만큼 다른 가격에 산
// 장부가 된다." 그 말은 청산에도 똑같이 해당한다. 사고 싶은 가격과 팔리는
// 가격이 다른 시장에서 오면 아무것도 안 해도 손익이 생긴다.
//
// 지금은 진입과 청산이 **같은 함수**(`readPaperMarkPrice`)를 부른다. 시장별
// 출처가 한 파일에만 있으므로 둘이 갈릴 수가 없다. 모르는 시장은 USDM으로
// 흘려보내지 않고 **거기서 멈춘다**(fail-closed).
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const positionId = String(body?.positionId || '');
  if (!positionId) return NextResponse.json({ ok: false, error: 'missing_params' }, { status: 400 });

  // **소유권을 확인한다.** closePaperPosition은 id만 받으므로, 여기서
  // 확인하지 않으면 남의 포지션 id를 넣어 닫을 수 있다.
  // **`market`을 함께 읽는다.** 이 칸을 안 읽었기 때문에 현물이 선물
  // 가격으로 닫히고 있었다.
  // 생성된 Supabase 타입에는 `market`이 없다(`025`가 나중에 더한 칸이라
  // 타입 재생성이 밀려 있다). 값은 DB에 실재하므로 여기서만 캐스팅한다.
  const { data: pos } = await (sb as any).from('paper_positions')
    .select('id, user_id, symbol, status, market').eq('id', positionId).maybeSingle();
  if (!pos || pos.user_id !== uid) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (pos.status === 'closed') {
    return NextResponse.json({ ok: false, error: 'already_closed', message: '이미 청산된 포지션입니다' }, { status: 409 });
  }

  // **진입과 같은 함수, 같은 계약.** 시장별 출처는 `paperPriceSource` 한
  // 곳에만 있다.
  const { readPaperMarkPrice, paperPriceFailed } =
    await import('@/lib/engine/paperPriceSource');
  const px = await readPaperMarkPrice(pos.market, String(pos.symbol));

  if (paperPriceFailed(px)) {
    // 모르는 시장은 **닫지 않는다.** 선물 가격으로 대신 닫으면 이 변경이
    // 없애려던 고장이 이름만 바꿔 돌아온다.
    if (px.code === 'UNSUPPORTED_MARKET') {
      return NextResponse.json({
        ok: false, error: 'unsupported_market', message: px.reason,
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    // 시세를 모르면 닫지 않는다. 추측한 가격으로 닫으면 그 손익이 장부에
    // 남고, 그 뒤의 모든 수치가 그 값 위에 쌓인다.
    return NextResponse.json({
      ok: false, error: 'no_price',
      message: '시세를 확인하지 못해 청산하지 않았습니다. 잠시 후 다시 시도하세요.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const markPrice = px.price;

  const { closePaperPosition } = await import('@/lib/engine/paperStore');
  const r = await closePaperPosition(sb, positionId, markPrice, 'MANUAL');

  if (!r.ok) {
    return NextResponse.json({ ok: false, error: 'close_failed', message: r.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true, paper: true,
    exitPrice: markPrice,
    // 어느 시장의 가격으로 닫혔는지 적는다. 적어 두지 않으면 나중에
    // "이 청산가가 어디서 왔나"를 화면에서 확인할 방법이 없다.
    market: px.market, priceSource: px.source,
    realizedPnl: r.realizedPnl, pnlPct: r.pnlPct,
    message: `모의 청산 — ${r.realizedPnl != null && r.realizedPnl >= 0 ? '+' : ''}`
           + `${r.realizedPnl?.toFixed(2)} USDT (${r.pnlPct?.toFixed(2)}%)`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
