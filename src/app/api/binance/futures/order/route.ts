// /api/binance/futures/order — jobs 큐에 PLACE_ORDER 적재 (Worker가 유일 실행자)
// POST { connectionId, symbol, side, type, quantity, price?, leverage?, reduceOnly?, confirmToken, stopLossPct?, takeProfitPct? }

import { NextRequest, NextResponse } from 'next/server';
import { validateOrder } from '@/lib/engine/orderValidation';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { enqueueJob } from '@/lib/jobs';
import { isKillSwitchActive } from '@/lib/risk/killSwitch';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  const { connectionId, confirmToken } = body;
  if (confirmToken !== 'LIVE_ORDER_CONFIRMED') return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  if (!connectionId) return NextResponse.json({ error: 'missing_params' }, { status: 400 });

  // 주문 파라미터 검증 — 음수·NaN·과도한 수량·잘못된 심볼을 여기서 차단한다
  const v = validateOrder(body);
  if (!v.ok) return NextResponse.json({ error: v.code || 'invalid_order', message: v.error }, { status: 400 });
  const { symbol, side, type, quantity, price, leverage, reduceOnly } = v.value!;

  const { data: conn } = await (sb.from('exchange_connections') as any)
    .select('id, exchange_id, is_testnet, has_withdrawal').eq('id', connectionId).eq('user_id', uid).single();
  if (!conn) return NextResponse.json({ error: 'connection_not_found' }, { status: 404 });
  if (String(conn.exchange_id).toLowerCase() !== 'binance') return NextResponse.json({ error: 'not_binance' }, { status: 400 });
  if (conn.has_withdrawal === true) return NextResponse.json({ error: 'withdrawal_key_blocked' }, { status: 403 });

  // 킬스위치 가드: 신규 진입 차단 (reduce-only 종료는 허용)
  if (!reduceOnly) {
    try { const ks = await isKillSwitchActive(sb, connectionId); if (ks.active) return NextResponse.json({ error: 'kill_switch_active', message: `🛑 킬스위치 발동 중 (${ks.reason || '계좌 보호'})` }, { status: 423 }); } catch {}
  }

  const r = await enqueueJob(sb, {
    userId: uid, connectionId, action: 'PLACE_ORDER',
    mode: conn.is_testnet ? 'TESTNET' : 'LIVE', symbol, side, quantity: Number(quantity),
    payload: { type, price: price ?? null, leverage: leverage ?? null, reduceOnly: !!reduceOnly, stopLossPct: body.stopLossPct ?? null, takeProfitPct: body.takeProfitPct ?? null },
    priority: reduceOnly ? 2 : 5,
  });
  if (!r.ok) return NextResponse.json({ error: 'enqueue_failed', message: r.error }, { status: 500 });
  return NextResponse.json({ ok: true, queued: true, jobId: r.jobId });
}
