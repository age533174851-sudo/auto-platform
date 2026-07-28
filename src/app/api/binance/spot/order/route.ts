// /api/binance/spot/order
//
// 현물 주문 — 사용자용 입구.
//
// 실제 주문 로직은 lib/exchanges/spotOrderExecutor.ts에 있다.
// 이 파일은 **인증만** 하고 그쪽으로 넘긴다.
//
// 왜 나눴나
// ─────────
// 감시 루프(트레일링·예약)도 주문을 내야 하는데, 그건 cron이 관리자
// 시크릿으로 부르므로 사용자 JWT가 없다. 이 라우트를 그대로 부를 수 없다.
// 그렇다고 루프가 자기 주문 코드를 가지면 현물 검사(공매도 차단·보유
// 확인·레버리지 필드 거부)가 두 벌이 되고 언젠가 한쪽만 고쳐진다.
//
// 그래서 구현은 하나, 입구는 둘이다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { placeSpotOrder } from '@/lib/exchanges/spotOrderExecutor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  // 선물 라우트와 같은 확인 토큰을 쓰지 않는다. 값이 같으면 프런트에서
  // 엔드포인트만 바꿔치기해도 통과한다.
  if (body.confirmToken !== 'SPOT_ORDER_CONFIRMED') {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }
  if (!body.connectionId) {
    return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });
  }

  // ── 현물에 없는 것이 들어오면 조용히 무시하지 않고 거부한다 ──
  // 무시하면 호출자는 레버리지가 걸린 줄 알고 수량을 그에 맞춰 보낸다.
  for (const forbidden of ['leverage', 'marginType', 'reduceOnly', 'stopLossPct', 'takeProfitPct']) {
    if (body[forbidden] != null && body[forbidden] !== false) {
      return NextResponse.json({
        error: 'not_supported_on_spot',
        message: `현물 주문에 '${forbidden}'은(는) 존재하지 않습니다. 선물 주문을 의도했다면 시장 유형을 확인하세요.`,
      }, { status: 400 });
    }
  }

  const r = await placeSpotOrder(sb, {
    userId: uid,
    connectionId: String(body.connectionId),
    symbol: String(body.symbol || ''),
    side: String(body.side || '').toUpperCase() as 'BUY' | 'SELL',
    type: String(body.type || 'MARKET').toUpperCase() as 'MARKET' | 'LIMIT',
    quantity: body.quantity,
    quoteOrderQty: body.quoteOrderQty,
    price: body.price,
    signalId: body.signalId,
    strategyId: body.strategyId ?? null,
  });

  const status = r.ok ? 200
    : r.status === 'UNKNOWN' ? 502
    : r.status === 'BLOCKED' ? 400
    : 400;

  return NextResponse.json({
    ok: r.ok, marketType: 'SPOT',
    status: r.status,
    clientOrderId: r.clientOrderId,
    orderId: r.orderId,
    filledQty: r.filledQty,
    avgPrice: r.avgPrice,
    error: r.ok ? undefined : (r.code || 'order_failed'),
    message: r.message,
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}
