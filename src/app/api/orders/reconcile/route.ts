// /api/orders/reconcile
// 재시작 복구: SENT/UNKNOWN 상태로 남은 주문을 거래소와 대조해 상태를 확정한다.
// 서버가 죽거나 응답을 못 받은 주문이 유령으로 남지 않게 한다.
// 배포 직후·워커 시작 시 호출하는 것을 권장.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const connectionId = url.searchParams.get('connectionId');
  const dryRun = url.searchParams.get('dry') === '1';

  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const sb = getSupabaseAdmin();

    // 미확정 주문 목록
    const { data: pending } = await sb.from('live_orders')
      .select('id, client_order_id, symbol, side, status, mode, exchange, created_at, error_message')
      .in('status', ['SENT', 'UNKNOWN', 'INTENT'])
      .order('created_at', { ascending: true })
      .limit(50);

    const list = Array.isArray(pending) ? pending : [];

    if (dryRun || !connectionId) {
      return NextResponse.json({
        ok: true, dryRun: true,
        pendingCount: list.length,
        pending: list,
        hint: connectionId ? undefined : 'connectionId를 주면 실제 대조를 수행합니다',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // 연결 정보로 실제 대조
    const { data: conn } = await sb.from('exchange_connections')
      .select('exchange, api_key_enc, api_secret_enc, has_withdrawal, mode')
      .eq('id', connectionId).maybeSingle();

    if (!conn) return NextResponse.json({ ok: false, error: '연결을 찾을 수 없습니다' }, { status: 404 });
    if (conn.has_withdrawal) {
      return NextResponse.json({ ok: false, error: '출금 권한 키는 사용할 수 없습니다' }, { status: 403 });
    }

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { reconcilePendingOrders } = await import('@/lib/engine/orderExecutor');

    const ex = String(conn.exchange || '').toLowerCase().includes('gate') ? 'gate' : 'binance';
    const result = await reconcilePendingOrders(sb, {
      exchange: ex as 'binance' | 'gate',
      apiKey: decryptSecret(conn.api_key_enc),
      apiSecret: decryptSecret(conn.api_secret_enc),
      testnet: String(conn.mode || 'TESTNET').toUpperCase() !== 'LIVE',
    });

    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '대조 실패' }, { status: 500 });
  }
}
