// /api/binance/futures/tpsl — TP/SL 설정·교체. **Vercel에서 직접 실행한다.**
// POST { connectionId, symbol, positionSide, tpPrice?, slPrice? }
//
// 예전에는 jobs 큐에 SET_TPSL을 적재했고 Worker만 실행했다. 그 워커를 쓰지 않게
// 된 뒤로 이 경로는 아무 일도 하지 않았다 — 손절을 옮겼다고 믿은 사용자에게는
// 가장 나쁜 실패다.
//
// 기존 TP/SL은 **전량 청산용(closePosition=true)만** 취소한다. 분할 익절
// 사다리와 다른 전략의 보호주문은 남긴다 (감사 지적 6번).
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

  const { symbol, positionSide, tpPrice, slPrice } = body;
  if (!symbol || !positionSide) return NextResponse.json({ error: 'missing_params' }, { status: 400 });
  if (positionSide !== 'LONG' && positionSide !== 'SHORT') return NextResponse.json({ error: 'invalid_position_side' }, { status: 400 });
  if (tpPrice == null && slPrice == null) return NextResponse.json({ error: 'no_tp_sl', message: 'TP 또는 SL 필요' }, { status: 400 });

  const creds = await loadBinanceCreds(sb, uid, body.connectionId);
  if (!creds.ok) return NextResponse.json({ error: creds.error, message: creds.message }, { status: creds.status });

  const bf = await import('@/lib/exchanges/binanceFutures');

  // 포지션이 있어야 한다. closePosition=true 주문은 포지션 없이 걸면 거래소가
  // 거부하거나, 걸린 뒤 다음 진입을 예상치 못하게 닫는다.
  const posRes: any = await bf.getFuturesPositions(creds.key, creds.secret, creds.testnet);
  if (!posRes?.success) {
    return NextResponse.json({
      ok: false, queued: false, error: 'position_lookup_failed',
      message: `포지션을 확인하지 못해 TP/SL을 걸지 않았습니다: ${posRes?.message || '사유 미상'}`,
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const want = String(symbol).toUpperCase().replace('/', '');
  const pos = (posRes.positions as any[]).find(p => String(p.symbol).toUpperCase() === want);
  if (!pos || Math.abs(Number(pos.amount)) === 0) {
    return NextResponse.json({
      ok: false, queued: false, error: 'no_position',
      message: `${want} 포지션이 없습니다. TP/SL은 포지션이 있을 때만 걸 수 있습니다.`,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (pos.side !== positionSide) {
    return NextResponse.json({
      ok: false, queued: false, error: 'side_mismatch',
      message: `방향 불일치 — 요청 ${positionSide}, 실제 ${pos.side}`,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  const cancelled = await bf.cancelOpenTPSL(creds.key, creds.secret, want, creds.testnet);

  const exitSide: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
  const out: { tp?: any; sl?: any } = {};
  if (tpPrice != null && Number(tpPrice) > 0) {
    out.tp = await bf.placeFuturesTPSL(creds.key, creds.secret, {
      symbol: want, side: exitSide, stopPrice: Number(tpPrice), type: 'TAKE_PROFIT_MARKET',
    }, creds.testnet);
  }
  if (slPrice != null && Number(slPrice) > 0) {
    out.sl = await bf.placeFuturesTPSL(creds.key, creds.secret, {
      symbol: want, side: exitSide, stopPrice: Number(slPrice), type: 'STOP_MARKET',
    }, creds.testnet);
  }

  // 손절 실패를 성공에 섞지 않는다. 익절만 걸리고 손절이 실패했는데 ok:true를
  // 주면, 사용자는 보호가 걸렸다고 믿는다.
  const slFailed = out.sl != null && !out.sl.success;
  const tpFailed = out.tp != null && !out.tp.success;
  const ok = !slFailed && !tpFailed;

  return NextResponse.json({
    ok, queued: false, executed: ok,
    cancelledExisting: cancelled?.cancelled ?? 0,
    tp: out.tp ? { success: out.tp.success, orderId: out.tp.orderId, message: out.tp.message } : null,
    sl: out.sl ? { success: out.sl.success, orderId: out.sl.orderId, message: out.sl.message } : null,
    testnet: creds.testnet,
    message: ok
      ? 'TP/SL 설정 완료'
      : `${slFailed ? '손절' : '익절'} 설정 실패 — 거래소에서 직접 확인하세요`,
  }, { status: ok ? 200 : 502, headers: { 'Cache-Control': 'no-store' } });
}
