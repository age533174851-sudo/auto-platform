// /api/binance/spot/order
//
// 현물 주문 — 사용자용 입구.
//
// 실제 주문 로직은 lib/exchanges/spotOrderExecutor.ts에 있다.
// 이 파일은 **인증만** 하고 그쪽으로 넘긴다.
//
// 왜 나눴나
// ─────────
// 감시 루프(트레일링·예약)도 주문을 내야 하는데, 그건 cron이 관리자
// 시크릿으로 부르므로 사용자 JWT가 없다. 이 라우트를 그대로 부를 수 없다.
// 그렇다고 루프가 자기 주문 코드를 가지면 현물 검사(공매도 차단·보유
// 확인·레버리지 필드 거부)가 두 벌이 되고 언젠가 한쪽만 고쳐진다.
//
// 그래서 구현은 하나, 입구는 둘이다.
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/server';
import { placeSpotOrder } from '@/lib/exchanges/spotOrderExecutor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }

  const uid = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!uid) return NextResponse.json({ error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ error: 'supabase_not_configured' }, { status: 503 });

  // 선물 라우트와 같은 확인 토큰을 쓰지 않는다. 값이 같으면 프런트에서
  // 엔드포인트만 바꿔치기해도 통과한다.
  if (body.confirmToken !== 'SPOT_ORDER_CONFIRMED') {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 });
  }
  if (!body.connectionId) {
    return NextResponse.json({ error: 'missing_connectionId' }, { status: 400 });
  }

  // ── 현물에 없는 것이 들어오면 조용히 무시하지 않고 거부한다 ──
  // 무시하면 호출자는 레버리지가 걸린 줄 알고 수량을 그에 맞춰 보낸다.
  for (const forbidden of ['leverage', 'marginType', 'reduceOnly', 'stopLossPct', 'takeProfitPct']) {
    if (body[forbidden] != null && body[forbidden] !== false) {
      return NextResponse.json({
        error: 'not_supported_on_spot',
        message: `현물 주문에 '${forbidden}'은(는) 존재하지 않습니다. 선물 주문을 의도했다면 시장 유형을 확인하세요.`,
      }, { status: 400 });
    }
  }

  // ── 거래 전 점검 ──
  //
  // 현물 목록은 짧다 — 운영 모드 · 시계 오차, 그리고 매수면 자금.
  // 마진 모드·청산가·배율·손절은 **현물에 존재하지 않으므로 목록에서 빠진다**
  // (preTradeChecklist의 market 구분). 없는 것을 pass로 적으면 확인한 것도
  // 사실도 아닌 초록 체크가 생긴다.
  //
  // 짧아도 물리는 이유: 이 경로는 지금까지 **운영 모드 관문을 지나지 않았다.**
  // spotOrderExecutor는 공매도·보유·정밀도를 보지만 모드는 보지 않는다.
  // 그래서 UI_DEMO나 PAPER 모드에서도 실제 거래소로 주문이 나갔다.
  //
  // 매도는 EXIT로 본다. 보유한 것을 파는 것은 위험을 줄이는 방향이고, 자금
  // 검사를 물리면 정작 팔아서 현금을 만들려는 주문이 막힌다.
  const spotSide = String(body.side || '').toUpperCase();
  const isSell = spotSide === 'SELL';

  // ── 킬 스위치 ──
  //
  // **여기 없었다.** 킬스위치가 일곱 주문 경로 중 둘에서만 돌면 그건
  // 없는 것보다 나쁘다 — 사용자는 다 멈춘 줄 알고 화면을 닫는다.
  {
    const { killSwitchGate } = await import('@/lib/risk/killSwitch');
    const ksg = await killSwitchGate(sb, body.connectionId);
    if (!ksg.allowed) {
      return NextResponse.json({ error: ksg.error, message: ksg.message }, { status: ksg.status });
    }
  }

  // 점검을 통과해서 나간 것과 **사용자가 넘겨서 나간 것**은 다르다.
  let overrideNote: string | null = null;
  let safetyLogError: string | null = null;
  {
    const { fromLegacyMode, gateOrder } = await import('@/lib/engine/operatingMode');
    const { runChecklist } = await import('@/lib/engine/preTradeChecklist');
    const { data: sconn } = await (sb.from('exchange_connections') as any)
      .select('exchange_id, is_testnet').eq('id', body.connectionId).eq('user_id', uid).maybeSingle();
    const spotTestnet = sconn?.is_testnet !== false;
    // **이름 정규화는 한 곳에서.** 예전에는 `String(...).toLowerCase()`
    // 원문을 그대로 들고 `=== 'gate'`로 비교했다. 그러면 `gateio` 연결이
    // 바이낸스로 읽혀, Gate 주문을 넣으면서 **바이낸스 시각으로 시계
    // 오차를 잰다** — 확인한 적 없는 것을 확인했다고 적는 셈이다.
    // 그리고 `|| 'binance'` 기본값은 모르는 거래소를 바이낸스로 만든다.
    const { normalizeExchange } = await import('@/lib/exchanges/connection');
    const spotExchange = normalizeExchange(sconn?.exchange_id);
    if (spotExchange !== 'binance' && spotExchange !== 'gate') {
      return NextResponse.json({
        ok: false, error: 'unsupported_exchange',
        message: `이 연결(${sconn?.exchange_id || '알 수 없음'})로는 현물 주문을 내지 않습니다`,
      }, { status: 400 });
    }

    // 시각은 **주문이 나갈 거래소**에서 읽는다. Gate 주문을 넣으면서
    // 바이낸스 시각으로 시계 오차를 재면, 그 초록 체크는 다른 거래소에
    // 대한 것이다 — 확인한 적 없는 것을 확인했다고 적는 셈이다.
    const readServerTime = spotExchange === 'gate'
      ? (await import('@/lib/exchanges/gateFutures')).getGateServerTime
      : (await import('@/lib/exchanges/binance')).getSpotServerTime;

    // 명목가는 아는 만큼만 넘긴다. quoteOrderQty가 있으면 그것이 곧 금액이고,
    // 지정가면 수량×가격이다. 시장가+수량만 온 경우는 체결가를 모르므로
    // 0으로 둔다 — 여기서 시세를 추측해 채우면 모드 상한($100)이 추측값으로
    // 판정된다.
    const notional = Number(body.quoteOrderQty)
      || (Number(body.quantity) * Number(body.price)) || 0;

    const localMs = Date.now();
    const serverMs = await readServerTime(spotTestnet);
    const mode = fromLegacyMode(process.env.NEXT_PUBLIC_APP_MODE ?? null);
    const g = gateOrder(mode, notional, { overrideMaxNotionalUsd: (() => { const n = Number(process.env.LIVE_MAX_NOTIONAL_USD); return Number.isFinite(n) && n > 0 ? n : null; })() });

    // 손실 잠금 셋(오늘·이번 주·연패).
    //
    // **이 줄이 없어서 현물 매수가 전부 막혀 있었다.** 체크리스트의
    // 오늘 손실 한도는 '모르면 막는' 필수 항목인데 이 라우트는 그 값을
    // 한 번도 넣은 적이 없다 — 화면에는 "오늘 손실 한도: 확인 못 함"으로
    // 떴고, 사용자가 할 수 있는 일은 없었다.
    //
    // 매도(EXIT)에는 어차피 안 물린다. 나가는 길을 막으면 잠금의 목적과
    // 정반대가 되기 때문이다.
    const limits = isSell
      ? { dailyLoss: null, weeklyLoss: null, lossStreak: null, aiVeto: null, aiPredictionId: null }
      : await (await import('@/lib/risk/collectLimits')).collectAllLimits({
          sb, userId: uid, connectionId: body.connectionId,
          exchange: spotExchange,
          testnet: spotTestnet,
          // AI 거부권이 볼 종목·방향. 현물 매수는 LONG으로 본다 —
          // 매도(EXIT)에는 어차피 이 검사가 붙지 않는다.
          symbol: String(body.symbol || ''), side: isSell ? 'SHORT' : 'LONG',
          market: 'SPOT',
          addMarginUsd: null,
          openUse: null,
        });

    const checklist = runChecklist({
      mode: { disposition: g.disposition, reason: g.reason },
      clock: serverMs != null ? { localMs, serverMs } : null,
      ...limits,
      // 현물에는 증거금 항목이 없다 (preTradeChecklist의 markets 참조).
      // 매도 전 보유 확인은 spotOrderExecutor가 하고, 매수 자금 부족은
      // 거래소가 주문을 통째로 거부한다.
      // 판정이 있으면 목록에 넣는다. 켜져 있으면 collectAllLimits가
      // **실패해도** 판정을 남기므로, 여기서 항목이 조용히 사라지지 않는다.
    }, { market: 'SPOT', intent: isSell ? 'EXIT' : 'ENTRY', aiVeto: !!limits.aiVeto });

    // 이 AI 판단이 실제로 어떻게 쓰였는지 원장에 되짚는다.
    // 막은 것만 채점하면 "AI가 막았을 때는 늘 맞더라"는 착시가 생긴다 —
    // 통과시킨 것도 같이 채점해야 그 확신도가 신호인지 알 수 있다.
    if (limits.aiPredictionId) {
      const { markApplied } = await import('@/lib/ai/vetoCheck');
      await markApplied(sb, limits.aiPredictionId,
        limits.aiVeto?.status === 'blocked' ? 'VETO' : 'PASS',
        isSell ? 'SHORT' : 'LONG', null);
    }

    if (!checklist.allowed) {
      // 확인창에서 "네"를 누른 항목을 적용한다. 자세한 규칙은
      // checkOverride.ts — 손실 한도·연패 잠금은 지목해도 안 넘어간다.
      const { gateWithOverrides, readOverrides } = await import('@/lib/engine/overrideGate');
      const gateRes = await gateWithOverrides(
        sb, uid, checklist as any, readOverrides(body),
        { market: 'SPOT', symbol: String(body.symbol || '') });
      if (gateRes.blocked) {
        return NextResponse.json({
          safetyLogError: gateRes.logError,
          ok: false, marketType: 'SPOT',
          error: 'checklist_blocked',
          message: checklist.summary,
          refusedOverrides: gateRes.refused.map(b => b.id),
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

  const r = await placeSpotOrder(sb, {
    userId: uid,
    connectionId: String(body.connectionId),
    symbol: String(body.symbol || ''),
    side: String(body.side || '').toUpperCase() as 'BUY' | 'SELL',
    type: String(body.type || 'MARKET').toUpperCase() as 'MARKET' | 'LIMIT',
    quantity: body.quantity,
    quoteOrderQty: body.quoteOrderQty,
    price: body.price,
    signalId: body.signalId,
    strategyId: body.strategyId ?? null,
  });

  const status = r.ok ? 200
    : r.status === 'UNKNOWN' ? 502
    : r.status === 'BLOCKED' ? 400
    : 400;

  return NextResponse.json({
    ok: r.ok, marketType: 'SPOT',
    status: r.status,
    clientOrderId: r.clientOrderId,
    orderId: r.orderId,
    filledQty: r.filledQty,
    avgPrice: r.avgPrice,
    error: r.ok ? undefined : (r.code || 'order_failed'),
    message: r.message,
    checklist: { allowed: true, overridden: overrideNote != null, overrideNote },
    safetyLogError,
  }, { status, headers: { 'Cache-Control': 'no-store' } });
}
