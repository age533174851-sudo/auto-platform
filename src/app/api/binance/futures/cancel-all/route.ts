// /api/binance/futures/cancel-all — 미체결 주문 전체 취소. **Vercel에서 직접 실행한다.**
// POST { connectionId }
//
// 예전에는 jobs 큐에 CANCEL_ALL_ORDERS를 적재하고 Worker가 실행했다. 그 워커는
// Binance IP 지역 차단으로 쓰지 않고 있어서(PROGRESS 인프라 표) 취소는 일어나지
// 않았고, 응답은 `ok: true, queued: true`였다.
//
// 미체결 취소는 **위험을 줄이는 동작**이다. 그런 동작이 조용히 실패하는 것은
// 주문이 실패하는 것보다 나쁘다 — 사용자는 정리됐다고 믿고 손을 뗀다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { loadFuturesCreds } from '@/lib/exchanges/loadCreds';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  // 거래소를 가리지 않는다. 위험을 줄이는 동작이 거래소를 이유로
  // 조용히 안 도는 것은 주문이 실패하는 것보다 나쁘다.
  const creds = await loadFuturesCreds(sb, uid, body.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  const { futuresCancelAll } = await import('@/lib/exchanges/futuresAdapter');

  // 최대 3회. 취소는 되돌릴 필요가 없는 동작이라 재시도가 안전하다 —
  // 이미 취소된 주문을 다시 취소해도 결과가 같다.
  let last: any = null;
  for (let i = 1; i <= 3; i++) {
    last = await futuresCancelAll(creds.exchange!, creds.key!, creds.secret!, creds.testnet!);
    if (last?.success) break;
    if (i < 3) await new Promise(r => setTimeout(r, 1500));
  }

  return NextResponse.json({
    ok: !!last?.success,
    queued: false,
    executed: !!last?.success,
    cancelled: last?.count ?? null,
    results: last?.results,
    testnet: creds.testnet,
    exchange: creds.exchange,
    message: last?.success
      ? `미체결 주문 취소 완료 (${last?.count ?? 0}건)`
      : '취소 실패 — 거래소에서 직접 확인하세요. 개별 결과는 results를 보세요',
  }, { status: last?.success ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
