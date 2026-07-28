// /api/reconcile/state
//
// 앱이 아는 상태와 거래소 실제 상태를 대조한다.
//
// 판정 로직은 lib/engine/stateReconcile.ts의 순수 함수에 있고, 이 라우트는
// 양쪽 스냅샷을 모아서 넘기는 역할만 한다. 그래야 판정을 테스트로 고정할 수
// 있고, 조회 방식이 바뀌어도 판정 규칙은 그대로 남는다.
//
// 조치는 하지 않는다 — 판정만 돌려준다. 일시적인 조회 실패로 실제 포지션을
// 자동 정리하면 되돌릴 수 없다.
import { NextRequest, NextResponse } from 'next/server';
import { reconcileState, type PositionView, type OrderView } from '@/lib/engine/stateReconcile';

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

  // 본인 연결만 조회한다 — connectionId를 받아 쓰면 남의 연결을 지정할 수 있다
  const { data: conn } = await sb.from('exchange_connections')
    .select('id, api_key, api_secret_enc, encrypted_secret, has_withdrawal')
    .eq('user_id', userId).eq('is_active', true).limit(1).maybeSingle();

  if (!conn) {
    return NextResponse.json({ ok: false, error: '활성 거래소 연결이 없습니다' }, { status: 404 });
  }
  if ((conn as any).has_withdrawal) {
    return NextResponse.json({ ok: false, error: '출금 권한 키는 사용할 수 없습니다' }, { status: 403 });
  }

  const bf = await import('@/lib/exchanges/binanceFutures');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');
  const key = (conn as any).api_key as string;
  const secret = decryptSecret((conn as any).api_secret_enc ?? (conn as any).encrypted_secret ?? '');

  // ── 거래소 스냅샷 ──
  const posRes: any = await bf.getFuturesPositions(key, secret, testnet);
  if (!posRes?.success) {
    // 조회 실패를 "포지션 없음"으로 오해하면 앱의 모든 포지션이 불일치로 잡힌다.
    return NextResponse.json({
      ok: false, error: 'exchange_unreachable',
      message: `거래소 조회 실패: ${posRes?.message || '원인 불명'} — 대조할 수 없습니다`,
    }, { status: 502 });
  }

  const exPositions: PositionView[] = [];
  for (const p of (posRes.positions as any[])) {
    let hasStop = false;
    try {
      const open = await bf.getFuturesOpenOrders(key, secret, testnet, p.symbol);
      hasStop = (Array.isArray(open) ? open : []).some((o: any) =>
        String(o?.type || '').toUpperCase() === 'STOP_MARKET');
    } catch { hasStop = false; }

    exPositions.push({
      symbol: p.symbol,
      side: p.side === 'SHORT' ? 'SHORT' : 'LONG',
      qty: Math.abs(Number(p.amount)),
      leverage: Number(p.leverage) || null,
      marginType: p.marginType || null,
      hasProtectiveStop: hasStop,
    });
  }

  let exOrders: OrderView[] | undefined;
  try {
    const open = await bf.getFuturesOpenOrders(key, secret, testnet);
    exOrders = (Array.isArray(open) ? open : []).map((o: any) => ({
      clientOrderId: String(o.clientOrderId || ''), symbol: String(o.symbol || ''),
    }));
  } catch { exOrders = undefined; }

  // ── 앱 스냅샷 ──
  // live_orders에서 아직 열려 있는 것으로 기록된 주문을 앱의 인식으로 본다.
  const { data: appRows } = await sb.from('live_orders')
    .select('client_order_id, symbol, side, filled_qty, status')
    .eq('user_id', userId)
    .in('status', ['ACKED', 'FILLED'])
    .order('created_at', { ascending: false })
    .limit(50);

  const appPositions: PositionView[] = (Array.isArray(appRows) ? appRows : [])
    .filter((r: any) => Number(r.filled_qty) > 0)
    .map((r: any) => ({
      symbol: String(r.symbol),
      side: String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' as const : 'LONG' as const,
      qty: Number(r.filled_qty),
    }));

  const { data: appOpenRows } = await sb.from('live_orders')
    .select('client_order_id, symbol')
    .eq('user_id', userId).in('status', ['SENT', 'ACKED'])
    .limit(50);
  const appOrders: OrderView[] = (Array.isArray(appOpenRows) ? appOpenRows : [])
    .map((r: any) => ({ clientOrderId: String(r.client_order_id), symbol: String(r.symbol) }));

  const verdict = reconcileState({
    appPositions,
    exchangePositions: exPositions,
    appOpenOrders: appOrders,
    exchangeOpenOrders: exOrders,
  });

  return NextResponse.json({
    ok: true,
    mode: testnet ? 'TESTNET' : 'LIVE',
    ...verdict,
    snapshot: {
      app: { positions: appPositions.length, openOrders: appOrders.length },
      exchange: { positions: exPositions.length, openOrders: exOrders?.length ?? null },
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
