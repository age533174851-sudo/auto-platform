// /api/binance/futures/close-all — 포지션 전체 종료. **Vercel에서 직접 실행한다.**
// POST { connectionId }
//
// 예전에는 jobs 큐에 적재하고 Worker가 실행했다. 그 워커는 쓰지 않고 있어서
// (PROGRESS 인프라 표) 종료는 일어나지 않았고 응답은 ok:true였다.
//
// 취소를 먼저 한다. 미체결 지정가가 남아 있으면 종료 직후 그 주문이 체결되어
// 포지션이 다시 열린다 — 닫았다고 믿은 뒤에 열리는 것이 가장 위험하다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadBinanceCreds } from '@/lib/exchanges/loadCreds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const creds = await loadBinanceCreds(sb, uid, body.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  const { cancelAllOpenOrders, closeAllPositions } = await import('@/lib/exchanges/binanceFutures');

  const cancel = await cancelAllOpenOrders(creds.key, creds.secret, creds.testnet);
  const close = await closeAllPositions(creds.key, creds.secret, creds.testnet, 5);

  return NextResponse.json({
    ok: !!close?.success,
    queued: false,
    executed: !!close?.success,
    // 취소 실패는 막지 않되 숨기지도 않는다. 종료가 됐는데 취소가 안 됐으면
    // 사용자가 그 사실을 알아야 한다.
    cancel: { success: !!cancel?.success, count: cancel?.count ?? null, results: cancel?.results },
    remaining: close?.remaining ?? null,
    retries: close?.retries ?? null,
    testnet: creds.testnet,
    message: close?.success
      ? '포지션 전체 종료 완료'
      : `포지션 ${close?.remaining ?? '?'}개가 남았습니다 — 거래소에서 직접 확인하세요`,
  }, { status: close?.success ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
