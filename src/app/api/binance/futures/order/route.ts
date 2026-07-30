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

  // ── 거래 전 점검 ──
  //
  // 이 라우트는 주문을 보내지 않고 jobs 큐에 적재한다. 그래도 여기서 막는
  // 이유: 큐에 들어간 뒤에는 Worker가 실행하고, 그때 막히면 사용자는 왜
  // 안 됐는지 화면에서 알 수 없다. 이유를 말할 수 있는 자리는 여기다.
  //
  // reduceOnly면 EXIT다. 나오는 주문에 진입 검사(손절·증거금·미확정 주문)를
  // 물리면 나갈 수 없게 된다.
  {
    const { fromLegacyMode, gateOrder } = await import('@/lib/engine/operatingMode');
    const { runChecklist } = await import('@/lib/engine/preTradeChecklist');
    const bf = await import('@/lib/exchanges/binanceFutures');
    const { assertStateConsistent } = await import('@/lib/engine/reconcileCheck');

    const isExit = !!reduceOnly;
    const useTestnet = conn.is_testnet !== false;

    const localMs = Date.now();
    const serverMs = await bf.getFuturesServerTime(useTestnet);

    // 상태 대조는 USDⓈ-M 경로의 검사다. 여기가 그 시장이다.
    const gate = await assertStateConsistent(sb, uid, useTestnet);

    // 마진 모드·배율·청산가는 이 심볼에서 직접 읽는다. 목록 조회는 수량 0을
    // 걸러내므로 신규 진입 심볼이 빠진다 (daily-ladder에서 겪은 것과 같다).
    let risk: Awaited<ReturnType<typeof bf.getSymbolPositionRisk>> = null;
    try {
      const { data: c2 } = await (sb.from('exchange_connections') as any)
        .select('api_key, api_secret_enc, encrypted_secret').eq('id', connectionId).maybeSingle();
      if (c2) {
        const { decryptSecret } = await import('@/lib/exchanges/crypto');
        risk = await bf.getSymbolPositionRisk(
          c2.api_key, decryptSecret(c2.api_secret_enc ?? c2.encrypted_secret ?? ''),
          symbol, useTestnet);
      }
    } catch { /* null → unknown → 막힌다 */ }

    // 기준가: 지정가면 그 가격, 아니면 마크가. 둘 다 없으면 명목가를 계산할
    // 수 없고, 그러면 증거금도 모드 상한도 판정할 수 없다.
    const refPriceRaw = Number(price ?? risk?.markPrice ?? 0);
    const refPrice = Number.isFinite(refPriceRaw) && refPriceRaw > 0 ? refPriceRaw : null;
    const notionalUsd = refPrice ? Number(quantity) * refPrice : 0;

    const mode = fromLegacyMode(process.env.NEXT_PUBLIC_APP_MODE ?? null);
    const g = gateOrder(mode, notionalUsd);

    // 필요 증거금 = 명목가 / 배율. 기준가나 배율을 모르면 **계산하지 않는다** —
    // 0으로 두면 "필요 0 / 가용 N"이 되어 무조건 통과하는 껍데기 체크가 된다.
    let marginInput: { required: number | null; available: number | null } | null = null;
    if (!isExit) {
      const lev = Number(leverage ?? risk?.leverage ?? 0);
      if (refPrice && Number.isFinite(lev) && lev > 0) {
        let available: number | null = null;
        try {
          const { data: c3 } = await (sb.from('exchange_connections') as any)
            .select('api_key, api_secret_enc, encrypted_secret').eq('id', connectionId).maybeSingle();
          if (c3) {
            const { decryptSecret } = await import('@/lib/exchanges/crypto');
            const bal: any = await bf.getFuturesBalance(
              c3.api_key, decryptSecret(c3.api_secret_enc ?? c3.encrypted_secret ?? ''), useTestnet);
            if (bal?.success) {
              const usdt = (bal.balances ?? []).find((b: any) => b.asset === 'USDT');
              if (usdt) available = usdt.availableBalance;
            }
          }
        } catch { /* available은 null로 남는다 → unknown → 막힌다 */ }
        marginInput = { required: notionalUsd / lev, available };
      }
    }

    // stopLossPct(%)를 가격으로 바꾼다. 기준가가 없으면 손절가를 만들 수 없다 —
    // 추측한 기준가로 손절을 적으면 그 값이 실제와 다르다.
    const slPct = Number(body.stopLossPct);
    const stopPrice = (!isExit && refPrice && Number.isFinite(slPct) && slPct > 0)
      ? (String(side).toUpperCase() === 'BUY'
          ? refPrice * (1 - slPct / 100)
          : refPrice * (1 + slPct / 100))
      : null;

    const checklist = runChecklist({
      mode: { disposition: g.disposition, reason: g.reason },
      clock: serverMs != null ? { localMs, serverMs } : null,
      reconcile: {
        reachable: gate.gather.reachable,
        blockNewOrders: !!gate.verdict?.blockNewOrders,
        summary: gate.reason || gate.verdict?.summary,
      },
      unresolvedOrderCount: gate.gather.reachable ? gate.gather.unresolvedOrders.length : null,
      marginType: risk?.marginType ?? null,
      leverage: (risk?.leverage != null && leverage != null)
        ? { actual: risk.leverage, intended: Number(leverage) } : null,
      existingPositionQty: risk ? Math.abs(risk.positionAmt) : null,
      stopPrice,
      liquidationPrice: risk?.liquidationPrice ?? null,
      side: String(side).toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
      margin: marginInput,
    }, { market: 'USDM', intent: isExit ? 'EXIT' : 'ENTRY' });

    if (!checklist.allowed) {
      return NextResponse.json({
        error: 'checklist_blocked',
        message: checklist.summary,
        checklist: {
          allowed: false, market: checklist.market, intent: checklist.intent,
          passed: checklist.passed, total: checklist.total,
          unknownCount: checklist.unknownCount,
          results: checklist.results, blockers: checklist.blockers,
        },
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
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
