// /api/binance/spot/order
//
// 현물 주문. **선물 라우트와 코드를 공유하지 않는다.**
//
// 왜 파일을 나눴나
// ────────────────
// 하나의 주문 라우트에 `if (marketType === 'SPOT')` 분기를 넣으면,
// 그 분기가 한 번 잘못 평가되는 순간 현물 매도가 선물 SHORT로 나간다.
// 되돌릴 수 없고, 사용자는 자기가 판 줄 알지만 실제로는 빚을 진다.
//
// 분기를 없애는 방법은 분기를 아예 만들지 않는 것이다. 이 파일은
// 선물 함수를 import하지 않는다 — leverage도, marginType도,
// reduceOnly도 여기서는 존재하지 않는 개념이다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { checkIntent, tagSignalId } from '@/lib/markets/marketType';

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

  const { connectionId } = body;
  if (!connectionId) return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });

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

  const symbol = String(body.symbol || '').toUpperCase().replace('/', '');
  const side = String(body.side || '').toUpperCase();
  const type = String(body.type || 'MARKET').toUpperCase();
  if (!symbol) return NextResponse.json({ error: 'missing_symbol' }, { status: 400 });
  if (side !== 'BUY' && side !== 'SELL') {
    return NextResponse.json({ error: 'invalid_side', message: 'BUY 또는 SELL만 가능합니다' }, { status: 400 });
  }
  if (type !== 'MARKET' && type !== 'LIMIT') {
    return NextResponse.json({ error: 'invalid_type' }, { status: 400 });
  }

  const quantity = body.quantity != null ? Number(body.quantity) : null;
  const quoteOrderQty = body.quoteOrderQty != null ? Number(body.quoteOrderQty) : null;
  const price = body.price != null ? Number(body.price) : null;

  // MARKET BUY는 USDT 금액으로도 낼 수 있다. 그 외에는 코인 수량이 필요하다.
  const byQuote = type === 'MARKET' && side === 'BUY' && quoteOrderQty != null;
  if (!byQuote && (!Number.isFinite(quantity as number) || (quantity as number) <= 0)) {
    return NextResponse.json({ error: 'invalid_quantity' }, { status: 400 });
  }
  if (byQuote && (!Number.isFinite(quoteOrderQty as number) || (quoteOrderQty as number) <= 0)) {
    return NextResponse.json({ error: 'invalid_quote_qty' }, { status: 400 });
  }
  if (type === 'LIMIT' && (!Number.isFinite(price as number) || (price as number) <= 0)) {
    return NextResponse.json({ error: 'invalid_price' }, { status: 400 });
  }

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();

  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  }
  if (conn.has_withdrawal === true) {
    return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });
  }

  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const bn = await import('@/lib/exchanges/binance');
  const apiKey = conn.api_key || '';
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }); }

  // ── 매도 전 보유 확인 ──
  // 현물에는 공매도가 없다. 보유량을 모르는 채로 보내면 거래소가 거부하거나,
  // 다른 미체결과 겹쳐 의도보다 많이 나갈 수 있다.
  let heldQty: number | null = null;
  if (side === 'SELL') {
    const base = symbol.replace(/USDT$|BUSD$|USDC$/, '');
    try {
      const balances = await bn.getBalancesBinance(apiKey, secret);
      const hit = (Array.isArray(balances) ? balances : [])
        .find(b => String(b.currency).toUpperCase() === base);
      // 미체결에 묶인 물량(locked)은 팔 수 없다. free만 센다.
      heldQty = hit ? Number(hit.free) || 0 : 0;
    } catch {
      heldQty = null;   // 확인 실패 — 아래 checkIntent가 막는다
    }
  }

  const intent = checkIntent({
    market: 'SPOT', side: side as 'BUY' | 'SELL',
    quantity: byQuote ? 1 : (quantity as number),   // 금액 주문은 수량 검사 대상이 아니다
    heldQty: byQuote ? undefined : heldQty,
  });
  if (!intent.ok) {
    return NextResponse.json({ error: 'intent_rejected', message: intent.reason }, { status: 400 });
  }

  // 수량 정밀도 — 거래소가 정한 단위로 내림한다. 올리면 보유량을 넘긴다.
  let qty = quantity;
  if (!byQuote && qty != null) {
    try {
      const f = await bn.getSpotSymbolFilters(symbol);
      if (f) {
        qty = bn.roundSpotQty(qty, f.stepSize);
        if (qty < f.minQty) {
          return NextResponse.json({
            error: 'below_min_qty',
            message: `최소 주문 수량(${f.minQty})보다 적습니다`,
          }, { status: 400 });
        }
      }
    } catch { /* 필터를 못 읽으면 원 수량으로 보내고 거래소 판단에 맡긴다 */ }
  }

  // ── 의도를 먼저 기록 ──
  // 시장 유형을 signal_id 표식으로 남긴다. market_type 컬럼이 아직 없어서다
  // (lib/markets/marketType.ts 참고). 컬럼이 생기면 컬럼이 우선한다.
  const clientOrderId = `SP${Date.now().toString(36).toUpperCase()}${symbol}`.slice(0, 36);
  const signalId = tagSignalId(String(body.signalId || 'manual-spot'), 'SPOT');

  const intentRow: Record<string, any> = {
    client_order_id: clientOrderId,
    signal_id: signalId,
    user_id: uid,
    connection_id: connectionId,
    exchange: 'binance',
    mode: 'LIVE',
    symbol, side, order_type: type,
    quantity: byQuote ? 0 : (qty as number),
    price: type === 'LIMIT' ? price : null,
    status: 'INTENT',
    market_type: 'SPOT',
  };

  let orderRowId: string | null = null;
  const insert = async (row: Record<string, any>) => {
    const { data, error } = await sb.from('live_orders').insert(row).select('id').single();
    return { data, error };
  };
  let res = await insert(intentRow);
  if (res.error) {
    // market_type 컬럼이 아직 없는 DB — 그 필드만 빼고 다시 넣는다.
    // 표식은 signal_id에 이미 들어 있으므로 유형 정보는 잃지 않는다.
    const { market_type: _drop, ...legacy } = intentRow;
    res = await insert(legacy);
  }
  if (res.error) {
    return NextResponse.json(
      { error: 'intent_log_failed', message: res.error.message }, { status: 500 });
  }
  orderRowId = res.data?.id ?? null;

  const patch = async (p: Record<string, any>) => {
    if (!orderRowId) return;
    try { await sb.from('live_orders').update({ ...p, updated_at: new Date().toISOString() }).eq('id', orderRowId); }
    catch { /* 기록 실패가 주문 결과를 바꾸지는 않는다 */ }
  };

  await patch({ status: 'SENT', sent_at: new Date().toISOString() });

  let r: any;
  try {
    r = await bn.placeOrderBinance(apiKey, secret, {
      symbol, side: side as 'BUY' | 'SELL', type: type as 'MARKET' | 'LIMIT',
      quantity: byQuote ? undefined : (qty as number),
      quoteOrderQty: byQuote ? (quoteOrderQty as number) : undefined,
      price: type === 'LIMIT' ? (price as number) : undefined,
    });
  } catch (e: any) {
    // 응답을 못 받았다. 나갔는지 안 나갔는지 모른다 — 재시도하지 않는다.
    await patch({ status: 'UNKNOWN', error_message: `응답 없음: ${e?.message || e}` });
    return NextResponse.json({
      ok: false, marketType: 'SPOT', status: 'UNKNOWN', clientOrderId,
      message: '주문 전송 후 응답을 받지 못했습니다. 재시도하지 말고 현물 내역을 확인하세요.',
    }, { status: 502 });
  }

  if (!r?.success) {
    await patch({ status: 'REJECTED', error_message: r?.message });
    return NextResponse.json(
      { ok: false, marketType: 'SPOT', error: 'order_rejected', message: r?.message },
      { status: 400 });
  }

  await patch({
    status: 'FILLED',
    exchange_order_id: String(r.orderId ?? ''),
    filled_qty: r.qty ?? null,
    avg_price: r.price ?? null,
    acked_at: new Date().toISOString(),
  });

  return NextResponse.json({
    ok: true, marketType: 'SPOT',
    clientOrderId, orderId: r.orderId,
    symbol: r.symbol, side: r.side,
    filledQty: r.qty, avgPrice: r.price,
    message: `현물 ${side === 'BUY' ? '매수' : '매도'} 체결`,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
