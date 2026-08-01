// /api/paper/close — 모의 포지션 청산
// POST { positionId }
//
// 청산가는 **서버가 받는 마크가**다. 화면이 보낸 값을 쓰면 유리한 가격에
// 닫아 장부를 만들 수 있고, 그러면 성적표가 의미를 잃는다.
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
  const { data: pos } = await sb.from('paper_positions')
    .select('id, user_id, symbol, status').eq('id', positionId).maybeSingle();
  if (!pos || pos.user_id !== uid) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  if (pos.status === 'closed') {
    return NextResponse.json({ ok: false, error: 'already_closed', message: '이미 청산된 포지션입니다' }, { status: 409 });
  }

  let markPrice: number | null = null;
  try {
    const { getPremiumIndex } = await import('@/lib/exchanges/binanceFutures');
    const px = await getPremiumIndex(String(pos.symbol), false);
    const v = Number(px?.markPrice);
    markPrice = Number.isFinite(v) && v > 0 ? v : null;
  } catch { markPrice = null; }

  if (markPrice == null) {
    // 시세를 모르면 닫지 않는다. 추측한 가격으로 닫으면 그 손익이 장부에
    // 남고, 그 뒤의 모든 수치가 그 값 위에 쌓인다.
    return NextResponse.json({
      ok: false, error: 'no_price',
      message: '시세를 확인하지 못해 청산하지 않았습니다. 잠시 후 다시 시도하세요.',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }

  const { closePaperPosition } = await import('@/lib/engine/paperStore');
  const r = await closePaperPosition(sb, positionId, markPrice, 'MANUAL');

  if (!r.ok) {
    return NextResponse.json({ ok: false, error: 'close_failed', message: r.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true, paper: true,
    exitPrice: markPrice,
    realizedPnl: r.realizedPnl, pnlPct: r.pnlPct,
    message: `모의 청산 — ${r.realizedPnl != null && r.realizedPnl >= 0 ? '+' : ''}`
           + `${r.realizedPnl?.toFixed(2)} USDT (${r.pnlPct?.toFixed(2)}%)`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
