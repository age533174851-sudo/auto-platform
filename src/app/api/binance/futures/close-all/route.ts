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

  // 거래소를 가리지 않는다 — Gate 연결에서 이 버튼이 죽어 있으면
  // 열 수는 있는데 닫을 수 없는 상태가 된다.
  const creds = await loadFuturesCreds(sb, uid, body.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  const { futuresCancelAll, futuresCloseAll } = await import('@/lib/exchanges/futuresAdapter');

  const cancel = await futuresCancelAll(creds.exchange!, creds.key!, creds.secret!, creds.testnet!);
  const close = await futuresCloseAll(creds.exchange!, creds.key!, creds.secret!, creds.testnet!, 5);

  // ── 닫은 **뒤에** 한 번 더 쓸어낸다 ──
  //
  // 취소를 먼저 하는 이유는 위에 적혀 있다(미체결 지정가가 종료 직후
  // 체결되어 포지션이 다시 열리는 것을 막는다). 그런데 그 사이에 손절이
  // 발동해 새 주문이 생기거나, 첫 취소가 일부만 성공했을 수 있다.
  //
  // 남은 보호 주문은 포지션이 없어진 뒤에 트리거되면 **반대 방향으로 새
  // 포지션을 연다.** 닫으려고 누른 버튼이 여는 버튼이 되는 것이다.
  // 전부 닫힌 것이 확인됐을 때만 한다 — 남아 있으면 그 보호는 필요하다.
  let sweep: any = null;
  if (close?.success && close?.remaining === 0) {
    sweep = await futuresCancelAll(creds.exchange!, creds.key!, creds.secret!, creds.testnet!);
  }

  return NextResponse.json({
    ok: !!close?.success,
    queued: false,
    executed: !!close?.success,
    // 취소 실패는 막지 않되 숨기지도 않는다. 종료가 됐는데 취소가 안 됐으면
    // 사용자가 그 사실을 알아야 한다.
    cancel: { success: !!cancel?.success, count: cancel?.count ?? null, results: cancel?.results },
    // 종료 뒤 쓸어낸 결과. null이면 종료가 확인되지 않아 하지 않았다는 뜻이다.
    sweep: sweep ? { success: !!sweep.success, count: sweep.count ?? null } : null,
    remaining: close?.remaining ?? null,
    retries: close?.retries ?? null,
    testnet: creds.testnet,
    exchange: creds.exchange,
    message: close?.success
      ? '포지션 전체 종료 완료'
      : close?.message || `포지션 ${close?.remaining ?? '?'}개가 남았습니다 — 거래소에서 직접 확인하세요`,
  }, { status: close?.success ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
