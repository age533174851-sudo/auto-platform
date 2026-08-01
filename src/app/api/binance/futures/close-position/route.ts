// /api/binance/futures/close-position — 포지션 부분/전량 종료. **직접 실행한다.**
// POST { connectionId, symbol, positionSide: 'LONG'|'SHORT', percent }
//
// 예전에는 jobs 큐에 CLOSE_POSITION을 적재했고, 비율 종료 구현은 워커에만
// 있었다(worker/src/binance.ts의 closePositionPct). 그 워커를 쓰지 않게 된 뒤로
// 이 경로는 아무 일도 하지 않았다. 구현을 앱으로 옮겼다
// (binanceFutures.closePositionPercent).
//
// quantity는 더 받지 않는다. 예전 라우트는 quantity를 필수로 요구하면서 워커에는
// percent만 넘겼다 — 화면이 보낸 수량은 어디에도 쓰이지 않았다. 실제로 쓰는 값만
// 받는다.
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

  const { symbol, positionSide, percent = 100 } = body;
  if (!symbol || !positionSide) {
    return NextResponse.json({ error: 'missing_params', message: 'connectionId·symbol·positionSide 필수' }, { status: 400 });
  }
  if (positionSide !== 'LONG' && positionSide !== 'SHORT') {
    return NextResponse.json({ error: 'invalid_position_side' }, { status: 400 });
  }

  const creds = await loadBinanceCreds(sb, uid, body.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  const { closePositionPercent } = await import('@/lib/exchanges/binanceFutures');
  const r = await closePositionPercent(
    creds.key, creds.secret, String(symbol), positionSide, Number(percent) || 100, creds.testnet);

  return NextResponse.json({
    ok: r.success,
    queued: false,
    executed: r.success,
    closedQty: r.closedQty,
    // 1%를 요청했는데 최소 단위 때문에 전량이 닫힌 경우를 숨기지 않는다
    fullClose: r.fullClose,
    testnet: creds.testnet,
    message: r.message,
  }, { status: r.success ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
