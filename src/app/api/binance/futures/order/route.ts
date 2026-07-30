// /api/binance/futures/order — USDⓈ-M 수동 주문. **Vercel에서 직접 실행한다.**
// POST { connectionId, symbol, side, type, quantity, price?, leverage?, reduceOnly?, confirmToken, stopLossPct?, takeProfitPct? }
//
// 예전에는 jobs 큐에 적재하고 Worker가 유일한 실행자였다. 그런데 그 워커는
// Binance IP 지역 차단으로 쓰지 않고 있어서(PROGRESS 인프라 표), 이 경로로
// 넣은 주문은 큐에 쌓이기만 하고 실행되지 않았다 — 응답은 ok:true였고 화면은
// "주문됨"으로 그렸다.
//
// Vercel(hnd1)에서는 Binance가 정상이고 daily-ladder가 이미 직접 실행한다.
// 같은 executeOrder를 쓰면 생명주기 기록·멱등 키·ISOLATED 강제·손절 부착·
// UNKNOWN 처리가 전부 따라온다. 워커 경로에는 절반만 있었다.
//
// 관문 순서: 확인 토큰 → 파라미터 검증 → 연결·출금권한 → 킬스위치
//            → 거래 전 점검 → 수동 계획 검사 → executeOrder

import { NextRequest, NextResponse } from 'next/server';
import { validateOrder } from '@/lib/engine/orderValidation';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
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
  //
  // 아래 실행부가 같은 값을 다시 읽지 않도록 블록 밖에 둔다. 두 번 읽으면
  // 레이트리밋을 두 배로 쓰고, 두 조회 사이에 상태가 바뀌면 점검과 실제
  // 주문이 서로 다른 사실을 본다.
  let preflightRisk: any = null;
  let preflightStop: number | null = null;
  let preflightRef: number | null = null;
  let preflightPassed = 0;
  let preflightTotal = 0;
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
    preflightRisk = risk;

    // 기준가: 지정가면 그 가격, 아니면 마크가. 둘 다 없으면 명목가를 계산할
    // 수 없고, 그러면 증거금도 모드 상한도 판정할 수 없다.
    const refPriceRaw = Number(price ?? risk?.markPrice ?? 0);
    const refPrice = Number.isFinite(refPriceRaw) && refPriceRaw > 0 ? refPriceRaw : null;
    preflightRef = refPrice;
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
    preflightStop = stopPrice;

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

    preflightPassed = checklist.passed;
    preflightTotal = checklist.total;

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

  // ── 직접 실행 ──
  //
  // 예전에는 jobs 큐에 적재하고 `{ ok: true, queued: true }`를 돌려줬다.
  // 실행자는 Railway Worker 하나뿐인데 그 워커는 Binance IP 지역 차단으로
  // 쓰지 않고 있다(PROGRESS 인프라 표). 즉 이 경로로 넣은 주문은 **큐에
  // 쌓이기만 하고 실행되지 않았고**, 화면은 ok:true를 받아 "주문됨"으로
  // 그렸다. 성공처럼 보이는 실패다.
  //
  // Vercel(hnd1)에서는 Binance가 정상이고, `daily-ladder`가 이미 여기서
  // 직접 실행한다. 같은 `executeOrder`를 쓰면 생명주기 기록·멱등 키·
  // ISOLATED 강제·손절 부착·UNKNOWN 처리가 전부 따라온다. 워커 경로에는
  // 그게 절반만 있었다.
  //
  // 큐는 남겨 둔다 — 웹훅(signal·tradingview)이 아직 쓴다. 다만 그쪽도
  // 실행자가 없으면 적재하지 않는다(queueGuard).
  const { buildManualPlan } = await import('@/lib/engine/manualPlan');
  const { executeOrder } = await import('@/lib/engine/orderExecutor');
  const { decryptSecret } = await import('@/lib/exchanges/crypto');

  // 키는 위에서 조회한 연결 행에 없다(id·exchange_id·is_testnet만 골랐다).
  const { data: keyRow } = await (sb.from('exchange_connections') as any)
    .select('api_key, api_secret_enc, encrypted_secret')
    .eq('id', connectionId).eq('user_id', uid).maybeSingle();
  if (!keyRow?.api_key) {
    return NextResponse.json({ error: 'connection_key_missing' }, { status: 400 });
  }

  const built = buildManualPlan({
    symbol, side: String(side).toUpperCase() as 'BUY' | 'SELL',
    quantity: Number(quantity),
    // 배율을 안 보내면 거래소에 설정된 값을 쓴다. 1로 가정하면 실제로는
    // 20배인 계좌에서 필요 증거금이 20분의 1로 계산된다.
    leverage: Number(leverage ?? preflightRisk?.leverage ?? 0),
    reduceOnly: !!reduceOnly,
    liquidationPrice: preflightRisk?.liquidationPrice ?? null,
    stopPrice: preflightStop,
    refPrice: preflightRef,
  });

  if (!built.plan.approved) {
    // executeOrder도 approved:false를 거부하지만, 여기서 먼저 돌려주면
    // 사유를 그대로 전할 수 있다 (executeOrder는 '승인되지 않은 계획'만 말한다).
    return NextResponse.json({
      ok: false, error: 'plan_rejected', message: built.reason,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  // 멱등 키. 같은 사용자·심볼·방향·수량을 같은 분(minute)에 두 번 누르면
  // 같은 키가 되어 거래소가 두 번째를 거부한다 — 손이 떨려 두 번 누른 것과
  // 정말 두 번 주문하려는 것을 구분할 수 없으므로, 실수 쪽을 막는다.
  // 1분 뒤에는 다른 키가 되므로 의도적인 반복은 가능하다.
  const minute = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const clientOrderId =
    `MF${minute}${symbol}${String(side)[0]}${String(quantity).replace('.', '')}`
      .slice(0, 36);

  const exec = await executeOrder(sb, {
    userId: uid,
    connectionId,
    signalId: `manual-${minute}-${symbol}`,
    clientOrderId,
    exchange: 'binance',
    mode: conn.is_testnet ? 'TESTNET' : 'LIVE',
    plan: built.plan,
    orderType: type === 'LIMIT' ? 'LIMIT' : 'MARKET',
    limitPrice: price != null ? Number(price) : undefined,
    reduceOnly: !!reduceOnly,
    // 청산에는 손절을 붙이지 않는다 (executeOrder가 reduceOnly로 건너뛴다)
    stopLoss: reduceOnly ? undefined : (preflightStop ?? undefined),
    apiKey: keyRow.api_key,
    apiSecret: decryptSecret(keyRow.api_secret_enc ?? keyRow.encrypted_secret ?? ''),
  });

  // UNKNOWN은 502다 — 보냈는데 결과를 모르는 상태다. 200으로 돌려주면
  // 화면이 성공으로 그리고, 그게 중복 주문을 부른다.
  const status = exec.ok ? 200 : exec.status === 'UNKNOWN' ? 502 : 400;

  return NextResponse.json({
    ok: exec.ok,
    // queued를 false로 명시한다. 이 경로는 더 이상 큐를 쓰지 않는다 —
    // 화면이 예전 응답 모양을 보고 "적재됨"으로 그리지 않게.
    queued: false,
    executed: exec.ok,
    status: exec.status,
    clientOrderId: exec.clientOrderId,
    exchangeOrderId: exec.exchangeOrderId,
    filledQty: exec.filledQty,
    avgPrice: exec.avgPrice,
    slOrderId: exec.slOrderId,
    duplicate: exec.duplicate,
    message: exec.message,
    checklist: { allowed: true, passed: preflightPassed, total: preflightTotal },
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}
