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

  // ── 거래소 수량·가격 단위 ──
  //
  // **이 단계가 없어서 수동 주문이 거부되고 있었다.**
  //   [-1111] Precision is over the maximum defined for this asset.
  //
  // 비율 버튼(25%·50%·100%)이 `잔고 × 비율 × 배율 ÷ 가격`을 소수점
  // 여섯 자리로 잘라 보냈는데, BTCUSDT 선물의 수량 단위는 0.001이라
  // 0.09906은 존재할 수 없는 수량이다.
  //
  // roundToStep도 roundQuantity도 저장소에 이미 있었다. 그런데 자동매매
  // 경로에서만 불렸다 — 자동은 되는데 손으로 누르면 안 되는 상태였다.
  //
  // 점검보다 **앞에** 둔다. 뒤에 두면 점검은 0.09906으로 명목가·증거금을
  // 계산하고 실제 주문은 0.099로 나가서, 검사한 값과 나간 값이 다르다.
  let orderQty = Number(quantity);
  let orderPrice = price != null ? Number(price) : null;
  let quantizeNote: string | null = null;
  {
    const bf = await import('@/lib/exchanges/binanceFutures');
    const { quantizeOrder } = await import('@/lib/exchanges/quantize');
    // 못 읽으면 null이다. 기본값을 지어내면 맞는 수량을 틀린 수량으로 바꾼다.
    const filters = await bf.getSymbolFilters(symbol, conn.is_testnet !== false);
    const q = quantizeOrder(orderQty, orderPrice, filters);
    if (!q.ok) {
      return NextResponse.json({
        ok: false, error: 'invalid_quantity', message: q.reason,
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    orderQty = q.quantity!;
    if (q.price != null) orderPrice = q.price;
    // 바뀌었거나, 규격을 못 읽어서 그대로 보내는 경우 둘 다 남긴다.
    if (q.changed || !q.applied) quantizeNote = q.reason;
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
  let riskError: string | null = null;
  let preflightStop: number | null = null;
  let preflightRef: number | null = null;
  let preflightPassed = 0;
  let preflightTotal = 0;
  // 점검을 통과해서 나간 것과 **사용자가 넘겨서 나간 것**은 다르다.
  // 응답에 적어야 화면이 "점검 통과"라고 쓰지 않는다.
  let overrideNote: string | null = null;
  let safetyLogError: string | null = null;
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
        const rr = await bf.getSymbolPositionRiskEx(
          c2.api_key, decryptSecret(c2.api_secret_enc ?? c2.encrypted_secret ?? ''),
          symbol, useTestnet);
        risk = rr.risk;
        // **왜 못 읽었는지를 들고 간다.** 값만 비우면 화면에는
        // '확인 못 함'까지만 뜨고 원인은 아무도 모른다 — 오늘 하루를
        // 그것 때문에 썼다.
        riskError = rr.error;
      }
    } catch { /* null → unknown → 막힌다 */ }
    preflightRisk = risk;

    // 기준가: 지정가면 그 가격, 아니면 마크가. 둘 다 없으면 명목가를 계산할
    // 수 없고, 그러면 증거금도 모드 상한도 판정할 수 없다.
    const refPriceRaw = Number(price ?? risk?.markPrice ?? 0);
    const refPrice = Number.isFinite(refPriceRaw) && refPriceRaw > 0 ? refPriceRaw : null;
    preflightRef = refPrice;
    const notionalUsd = refPrice ? orderQty * refPrice : 0;

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

    // 잠금 셋(오늘·이번 주·연패) + 켜져 있으면 AI 거부권을 **한 입구에서** 모은다.
    //
    // 이 라우트만 직접 채우고 있었다. 그러면 검사를 하나 추가할 때마다 여기와
    // collectLimits 두 곳을 고쳐야 하고, 언젠가 한쪽만 고친다 — 현물·COIN-M이
    // 오늘 손실 한도를 통째로 빠뜨리고 있던 것이 정확히 그 결과였다.
    // 판정을 두 곳에 두지 않는다.
    const limits = isExit
      ? { dailyLoss: null, weeklyLoss: null, lossStreak: null, aiVeto: null, aiPredictionId: null }
      : await (await import('@/lib/risk/collectLimits')).collectAllLimits({
          sb, userId: uid, connectionId, testnet: useTestnet,
          equityUsd: marginInput?.available ?? null,
          symbol, side: String(side).toUpperCase() === 'BUY' ? 'LONG' : 'SHORT',
          // 서브계좌 한도. 열린 포지션 목록을 **못 읽었으면 넘기지 않는다** —
          // 빈 배열로 치면 "아무것도 안 쓰고 있다"가 되어 한도가 통째로
          // 넉넉해지고, 그건 검사를 켜 놓고 안 거는 것과 같다.
          market: 'USDM',
          addMarginUsd: marginInput?.required ?? null,
          openUse: gate.gather.reachable
            ? gate.gather.exchangePositions.map((p: any) => ({
                symbol: String(p.symbol), market: 'USDM', marginUsd: p.margin ?? null,
              }))
            : null,
        });

    const checklist = runChecklist({
      mode: { disposition: g.disposition, reason: g.reason },
      clock: serverMs != null ? { localMs, serverMs } : null,
      ...limits,
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
    }, { market: 'USDM', intent: isExit ? 'EXIT' : 'ENTRY', aiVeto: !!limits.aiVeto });

    preflightPassed = checklist.passed;
    preflightTotal = checklist.total;

    // 이 AI 판단이 실제로 어떻게 쓰였는지 원장에 되짚는다.
    // 막은 것만 채점하면 "AI가 막았을 때는 늘 맞더라"는 착시가 생긴다 —
    // 통과시킨 것도 같이 채점해야 그 확신도가 신호인지 알 수 있다.
    if (limits.aiPredictionId) {
      const { markApplied } = await import('@/lib/ai/vetoCheck');
      await markApplied(sb, limits.aiPredictionId,
        limits.aiVeto?.status === 'blocked' ? 'VETO' : 'PASS',
        String(side).toUpperCase() === 'BUY' ? 'LONG' : 'SHORT', risk?.markPrice ?? null);
    }

    if (!checklist.allowed) {
      // 사용자가 확인창에서 "네"를 누른 항목을 여기서 적용한다.
      // 통짜 우회가 아니라 **항목을 하나하나 지목**한 목록이라, 물어본
      // 사이에 새로 막힌 항목은 그대로 막힌다. 손실 한도·연패 잠금은
      // 지목해도 안 넘어간다(checkOverride의 NEVER 목록).
      //
      // **막았다는 사실을 남긴다.** 예전에는 409만 돌려주고 끝이라
      // 어디에도 안 남았다 — 그래서 화면은 설정값만 보여줄 수 있었고,
      // 설정값만 보이면 사람은 그것이 돌고 있다고 믿는다. 넘긴 것도
      // 같은 표에 'waived'로 남는다.
      const { gateWithOverrides, readOverrides } = await import('@/lib/engine/overrideGate');
      const gateRes = await gateWithOverrides(
        sb, uid, checklist as any, readOverrides(body),
        { market: 'USDM', symbol: String(symbol || '') });
      if (gateRes.blocked) {
        return NextResponse.json({
          safetyLogError: gateRes.logError,
          error: 'checklist_blocked',
          message: checklist.summary,
          // 지목했는데 못 넘긴 항목. 화면이 "네를 눌렀는데 왜 안 되지"를
          // 겪지 않게 이유를 같이 돌려준다.
          refusedOverrides: gateRes.refused.map(b => b.id),
          // 조회가 왜 실패했는지. 점검 항목은 '확인 못 함'까지만 말할 수
          // 있으므로, 그 뒤의 이유를 여기 붙인다.
          riskError,
          checklist: {
            allowed: false, market: checklist.market, intent: checklist.intent,
            passed: checklist.passed, total: checklist.total,
            unknownCount: checklist.unknownCount,
            results: checklist.results, blockers: gateRes.remaining,
          },
        }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      }
      overrideNote = `사용자가 점검 ${gateRes.waived.length}개를 확인하고 진행: `
        + gateRes.waived.map(b => b.label || b.id).join(', ');
      safetyLogError = gateRes.logError;
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

  // 배율을 안 보내면 거래소에 설정된 값을 쓴다. 1로 가정하면 실제로는
  // 20배인 계좌에서 필요 증거금이 20분의 1로 계산된다.
  const levNum = Number(leverage ?? preflightRisk?.leverage ?? 0);

  // 여기서 먼저 막는다. 예전에는 0을 그대로 넘겨서 화면에
  // "배율이 유효하지 않습니다 (0)"만 떴는데, 그 0은 사용자가 고른 값이
  // 아니라 **포지션 조회가 실패했다는 뜻**이었다. 조회 실패 사유를
  // 여기서 같이 돌려줘야 화면이 무엇을 고쳐야 하는지 말할 수 있다.
  // 청산(reduceOnly)은 배율을 몰라도 나갈 수 있어야 한다. 못 여는 것은
  // 불편이지만 못 닫는 것은 사고다 — manualPlan도 같은 순서로 판단한다.
  if (!reduceOnly && (!Number.isFinite(levNum) || levNum < 1)) {
    return NextResponse.json({
      ok: false, error: leverage == null ? 'leverage_unknown' : 'leverage_invalid',
      message: leverage == null
        ? '배율을 정하지 못했습니다 — 거래소에서 이 심볼의 배율을 읽지 못했습니다'
          + (riskError ? ` (${riskError})` : '')
          + '. 주문 화면에서 배율을 직접 골라 주세요.'
        : `배율 ${leverage}은(는) 쓸 수 없습니다 — 1배 이상이어야 합니다`,
      riskError,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const built = buildManualPlan({
    symbol, side: String(side).toUpperCase() as 'BUY' | 'SELL',
    quantity: orderQty,
    leverage: levNum,
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
    `MF${minute}${symbol}${String(side)[0]}${String(orderQty).replace('.', '')}`
      .slice(0, 36);

  const exec = await executeOrder(sb, {
    userId: uid,
    connectionId,
    signalId: `manual-${minute}-${symbol}`,
    clientOrderId,
    exchange: 'binance',
    // **프로젝트 공통 규칙: is_testnet === false일 때만 실전이다.**
    // 여기는 truthy 검사라 이 칸이 비면 실전으로 떨어진다 — 모르는 값이
    // 실제 돈 쪽으로 기울면 안 된다. 위 quantize도 이미 `!== false`를 쓴다.
    mode: conn.is_testnet !== false ? 'TESTNET' : 'LIVE',
    plan: built.plan,
    orderType: type === 'LIMIT' ? 'LIMIT' : 'MARKET',
    // **정규화한 가격을 보낸다.**
    //
    // 위에서 호가 단위에 맞춰 orderPrice를 만들어 놓고, 여기서는 원본
    // price를 넘기고 있었다. 그래서 62661.95가 그대로 나가 거래소가
    // -4014(Price not increased by tick size)로 거부했다 — BTCUSDT의
    // 호가 단위는 0.10이라 .95로 끝나는 가격은 존재하지 않는다.
    //
    // 수량은 orderQty를 제대로 쓰고 있었다. 가격만 빠져 있었고, 그래서
    // "수량은 되는데 지정가만 거부"라는 모양이 됐다.
    limitPrice: orderPrice != null ? orderPrice : undefined,
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
    // 수량을 조용히 바꾸지 않는다 — 바뀌었으면 화면이 그대로 보여준다.
    quantizeNote,
    quantity: orderQty,
    checklist: {
      allowed: true, passed: preflightPassed, total: preflightTotal,
      // 넘겨서 나갔으면 그렇게 적는다. '통과'로 적으면 기록이 거짓이 된다.
      overridden: overrideNote != null, overrideNote,
    },
    safetyLogError,
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}
