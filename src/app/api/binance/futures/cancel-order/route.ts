// /api/binance/futures/cancel-order — 미체결 주문 **하나** 취소
// POST { connectionId, orderId, symbol?, bucket? }
//
// 왜 따로 두는가
// ──────────────
// 지금까지 화면에 있던 취소는 [전체 취소]뿐이었다. 그런데 미체결 목록에는
// 신규 지정가 예약과 **포지션을 지키는 손절**이 섞여 있다. 지정가 하나를
// 지우려고 [전체 취소]를 누르면 손절까지 사라지고, 화면에는 "취소 완료"만
// 뜬다. 그러면 손절 없는 레버리지 포지션이 남는데 아무도 그 사실을 모른다.
//
// 그래서 한 건씩 지울 수 있어야 한다.
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

  const orderId = String(body?.orderId ?? '').trim();
  if (!orderId) {
    return NextResponse.json({
      error: 'missing_orderId',
      message: '주문 번호가 없어 취소하지 못했습니다',
    }, { status: 400 });
  }

  const creds = await loadFuturesCreds(sb, uid, body?.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  const { futuresCancelOrder } = await import('@/lib/exchanges/futuresAdapter');

  // 최대 2회. 취소는 여러 번 해도 결과가 같다 — 이미 지워진 주문을 다시
  // 지우는 것은 무해하고, 네트워크 한 번 튀어서 손절이 남는 것보다 낫다.
  let last: any = null;
  for (let i = 1; i <= 2; i++) {
    last = await futuresCancelOrder(creds.exchange!, creds.key!, creds.secret!, creds.testnet!, {
      symbol: body?.symbol ?? null,
      orderId,
      bucket: body?.bucket ?? null,
    });
    if (last?.success) break;
    if (i < 2) await new Promise(r => setTimeout(r, 900));
  }

  return NextResponse.json({
    ok: !!last?.success,
    orderId,
    exchange: creds.exchange,
    testnet: creds.testnet,
    // **성공을 지어내지 않는다.** 실패면 거래소에서 직접 확인하라고 말한다 —
    // 취소됐다고 믿고 손을 떼면 남은 주문이 언제 체결될지 모른다.
    message: last?.success ? '주문을 취소했습니다'
      : `${last?.message || '취소 실패'} — 거래소에서 직접 확인하세요`,
  }, { status: last?.success ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
