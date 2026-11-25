// /api/binance/spot/open-orders
//
// 현물 미체결 주문. 선물 미체결과 같은 화면·같은 응답에 섞지 않는다.
// 섞이면 "취소" 한 번이 엉뚱한 시장의 주문을 지운다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { connectionLookupVerdict } from '@/lib/exchanges/connectionLookup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function creds(req: NextRequest) {
  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return { err: NextResponse.json({ error: 'auth_required' }, { status: 401 }) };

  const sb = getSupabaseAdmin();
  if (!sb) return { err: NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 }) };

  const connectionId = req.nextUrl.searchParams.get('connectionId')
    ?? (await req.clone().json().catch(() => ({})))?.connectionId;
  if (!connectionId) return { err: NextResponse.json({ error: 'missing_connectionId' }, { status: 400 }) };

  const { data: conn, error: connErr } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, api_key, api_secret_enc, encrypted_secret, has_withdrawal, is_testnet')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();

  // **못 읽은 것을 "없다"로 적지 않는다.** 판정은 한 곳에 있다 —
  // maybeSingle의 빈 응답만 0행이고, 오류는 전부 503이다.
  const look = connectionLookupVerdict({ data: conn, error: connErr, shape: 'maybeSingle' });
  if (look.kind !== 'FOUND') {
    return { err: NextResponse.json({ error: look.code, message: look.reason }, { status: look.status }) };
  }
  if (String(conn.exchange_id).toLowerCase() !== 'binance') {
    return { err: NextResponse.json({ error: 'not_binance' }, { status: 400 }) };
  }
  if (conn.has_withdrawal === true) {
    return { err: NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 }) };
  }

  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  let secret: string;
  try { secret = decryptSecret(conn.api_secret_enc || conn.encrypted_secret || ''); }
  catch { return { err: NextResponse.json({ error: 'decrypt_failed' }, { status: 500 }) }; }

  return { key: conn.api_key || '', secret, testnet: conn.is_testnet === true };
}

export async function GET(req: NextRequest) {
  const c = await creds(req);
  if ('err' in c) return c.err;

  const symbol = req.nextUrl.searchParams.get('symbol') || undefined;
  try {
    const { getSpotOpenOrders } = await import('@/lib/exchanges/binance');
    const orders = await getSpotOpenOrders(c.key!, c.secret!, symbol, c.testnet);
    return NextResponse.json({
      ok: true, marketType: 'SPOT',
      orders: orders.map((o: any) => ({
        orderId: o.orderId, clientOrderId: o.clientOrderId,
        symbol: o.symbol, side: o.side, type: o.type,
        price: Number(o.price), origQty: Number(o.origQty),
        executedQty: Number(o.executedQty), status: o.status,
        time: Number(o.time),
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    // 조회 실패를 빈 목록으로 돌려주면 "미체결 없음"으로 읽힌다.
    return NextResponse.json(
      { ok: false, error: 'query_failed', message: e?.message || '현물 미체결 조회 실패' },
      { status: 502 });
  }
}

/** 취소 — 현물 주문만 취소한다 */
export async function DELETE(req: NextRequest) {
  const c = await creds(req);
  if ('err' in c) return c.err;

  const symbol = req.nextUrl.searchParams.get('symbol');
  const orderId = req.nextUrl.searchParams.get('orderId');
  if (!symbol || !orderId) {
    return NextResponse.json({ error: 'missing_params', message: 'symbol과 orderId가 필요합니다' }, { status: 400 });
  }

  const { cancelSpotOrder } = await import('@/lib/exchanges/binance');
  const r = await cancelSpotOrder(c.key!, c.secret!, symbol, orderId, c.testnet);
  return NextResponse.json(
    { ok: r.success, marketType: 'SPOT', message: r.message },
    { status: r.success ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
}
