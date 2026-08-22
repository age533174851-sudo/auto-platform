// /api/autotrade/daily-ladder
//
// 계단식 하루 1회 전략의 실행 진입점.
//
// 여기까지 만들어 둔 부품들(5v5 판정 → Veto → 계단 게이트 → Expansion →
// Risk Manager → 주문)은 runTradingPipeline이 순서대로 엮는다. 그런데 그
// 파이프라인을 부르는 곳이 없어서 전체가 잠들어 있었다. 이 라우트가 시동이다.
//
// 실행 방식
// ─────────
// 일봉 마감 후 하루 한 번 호출하도록 만들어졌다 (cron 또는 워커).
// 하루 1회 제한은 이 라우트가 아니라 DB unique 제약이 강제하므로,
// 실수로 여러 번 호출해도 두 번째부터는 ALREADY_TRADED로 거부된다.
//
// 인증
// ────
// 실제 주문을 내는 경로다. 관리자 시크릿(cron용) 또는 본인 JWT를 요구한다.
// JWT로 호출하면 body의 userId는 무시하고 토큰의 사용자로 강제한다 —
// 그러지 않으면 로그인한 누구나 남의 계정으로 주문을 돌릴 수 있다.
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { tagStrategy } from '@/lib/strategies/ledger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CRON_SECRET = process.env.ADMIN_SECRET || '';

function safeEqual(provided: string | null, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

interface DailyBars {
  highs: number[]; lows: number[]; closes: number[]; volumes: number[];
}

/**
 * 일봉. **주문이 나갈 시장에서 읽는다.**
 *
 * 예전에는 `api.binance.com/api/v3`(바이낸스 **현물**)에서 읽었다. 그런데
 * 주문은 바이낸스 **선물**이나 **Gate 선물**로 나간다 — 현물 가격으로
 * 판단하고 선물 호가로 체결하고 있었다.
 *
 * 현물과 선물은 다른 가격이다. 베이시스가 0.05~0.5%씩 벌어지는데, 손절
 * 폭이 1%인 전략에서 그건 **손절 거리의 절반**이다. 그리고 진입가·손절가·
 * 청산 거리가 전부 마지막 종가에서 나오므로 시세가 틀리면 그 뒤가 전부
 * 틀린다. 거래소가 다르면 더 나쁘다 — 일어나지 않은 신호로 주문을 낸다.
 *
 * 미완성 봉도 여기서 잘라 낸다. 진행 중인 봉의 '종가'는 종가가 아니라
 * 지금 가격이고, 사다리 전략은 그 값으로 손절가를 만든다.
 */
async function fetchDailyBars(
  symbol: string, exchange: 'binance' | 'gate', testnet: boolean, limit = 120,
): Promise<{ bars: DailyBars | null; source: string; error: string | null }> {
  const { fetchVenueBars } = await import('@/lib/markets/venueBars');
  const r = await fetchVenueBars({ exchange, symbol, interval: '1d', limit, testnet });
  if (!r.bars) return { bars: null, source: r.source, error: r.error };
  return {
    bars: { highs: r.bars.highs, lows: r.bars.lows, closes: r.bars.closes, volumes: r.bars.volumes },
    source: r.source, error: null,
  };
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* 빈 본문 허용 */ }

  const symbol = String(body.symbol || 'BTCUSDT').toUpperCase().replace('/', '');
  const dryRun = body.dryRun === true;
  /**
   * **주문 직전까지 진짜로 가 본다. 주문만 안 낸다.**
   *
   * dryRun은 파이프라인이 진입을 승인하지 않으면 거기서 끝나서, 그 뒤의
   * 관문들(마진 모드·서브계좌 한도·손실 한도·시계·상태 대조)을 한 번도
   * 통과시켜 본 적이 없다. 그래서 "미리보기는 되는데 내일 아침에 안 되는"
   * 일이 생긴다 — 실제로 이번에 서브계좌 한도와 마진 모드가 그렇게
   * 숨어 있었다.
   *
   * checkOnly는 조건이 안 맞아도 관문 목록을 끝까지 돌려 결과를 준다.
   * 예약 슬롯은 반드시 돌려준다 — 점검이 하루를 잡아먹으면 안 된다.
   */
  const checkOnly = body.checkOnly === true;
  // ── 운영 모드 ──
  // 사다리(UI_DEMO → PAPER → TESTNET → SHADOW_LIVE → LIVE_SMALL → LIVE_LIMITED)를
  // 받되, 예전 PAPER/TESTNET/LIVE도 그대로 받아 사다리로 옮긴다.
  // 모르는 값은 UI_DEMO로 떨어진다 — 오타 하나가 실거래를 켜서는 안 된다.
  const { fromLegacyMode, gateOrder, capability, toLegacyMode } =
    await import('@/lib/engine/operatingMode');
  const opMode = body.mode ? fromLegacyMode(String(body.mode)) : 'TESTNET';
  const mode = toLegacyMode(opMode);
  // 시세·계좌 조회를 어느 망에서 할 것인가.
  // 예전처럼 레거시 mode로 계산하면 Shadow Live가 PAPER로 내려오면서
  // 테스트넷 시세로 판단하게 된다. 그러면 샤도우의 의미가 없다 —
  // 실계좌로 판단하되 보내지만 않는 것이 Shadow Live다.
  const useTestnet = !capability(opMode).needsLiveKey;

  // ── 인증 ──
  let userId: string | null = null;
  const byCron = safeEqual(req.headers.get('x-admin-secret'), CRON_SECRET);

  if (byCron) {
    // cron은 대상 사용자를 지정해야 한다
    userId = body.userId ? String(body.userId) : null;
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'cron 호출에는 userId가 필요합니다' }, { status: 400 });
    }
  } else {
    const { getUserIdFromRequest } = await import('@/lib/supabase/admin');
    userId = await getUserIdFromRequest(req.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: '인증 필요 — Bearer 토큰 또는 x-admin-secret 헤더' },
        { status: 401 },
      );
    }
    // 본인 것만. body.userId는 신뢰하지 않는다.
  }

  // 판정은 한 곳에서만 한다. 여섯 곳이 각자 process.env를 읽고 있었고,
  // 그중 하나만 느슨해도 실주문은 그리로 나간다.
  // **Preview 배포는 여기서 막힌다** — 이 구분이 지금까지 없었다.
  if (capability(opMode).realMoney) {
    const { liveTradingGate } = await import('@/lib/engine/liveTradingGate');
    const lg = liveTradingGate();
    if (!lg.allowed) {
      return NextResponse.json(
        { ok: false, error: lg.reason, env: lg.env, liveUnlocked: lg.unlocked },
        { status: 403 },
      );
    }
  }

  const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
  }

  // ── 목적지 확인 (다른 무엇보다 먼저) ──
  //
  // **주문이 어느 망으로 나가는지는 연결이 정한다. 모드가 아니다.**
  //
  // 예전에는 `useTestnet`을 모드에서만 뽑았다. 그러면 예약 줄이
  // TESTNET인데 연결이 실계좌이면, 시세·필터·서버시각을 데모 서버에서
  // 읽고 주문은 실계좌 키로 나간다. 그게 이번 주에 본 -2015와 -1111의
  // 뿌리다 — 두 망의 심볼 필터가 다르고 키도 호환되지 않는다.
  //
  // 예약 저장(POST /api/autotrade/schedule)에서 이미 막지만, **저장 뒤에
  // 연결의 is_testnet이 바뀌었거나 예전에 저장된 줄이면 그 검사를
  // 통과한 적이 없다.** 주문 직전에 실물로 다시 본다.
  let connIsLive: boolean | null = null;
  // 시세를 **어느 거래소에서** 읽을지도 여기서 정해진다. 예전에는 시세가
  // 바이낸스 현물로 고정이라 이 값이 필요 없었다 — 그게 문제였다.
  let connExchange: 'binance' | 'gate' = 'binance';
  if (body.connectionId) {
    const { data: c, error: cErr } = await sb.from('exchange_connections')
      .select('is_testnet, exchange_id').eq('id', body.connectionId).eq('user_id', userId).maybeSingle();
    if (cErr) {
      return NextResponse.json({
        ok: false, error: 'connection_lookup_failed',
        message: `거래소 연결을 확인하지 못했습니다: ${cErr.message}`,
      }, { status: 503 });
    }
    if (!c) {
      return NextResponse.json({
        ok: false, error: 'connection_not_found',
        message: '거래소 연결을 찾을 수 없거나 본인의 연결이 아닙니다',
      }, { status: 404 });
    }
    connIsLive = (c as any).is_testnet === false;
    // 판정은 futuresExchangeOf 한 곳에 있다. 여기서 손으로 다시 적으면
    // 규칙이 갈리고, 갈리면 한쪽만 고쳐진다.
    connExchange = (await import('@/lib/exchanges/futuresAdapter'))
      .futuresExchangeOf((c as any).exchange_id) as any;
    if (!connExchange) {
      return NextResponse.json({
        ok: false, error: 'unsupported_exchange',
        message: `이 연결(${(c as any).exchange_id || '알 수 없음'})로는 자동매매를 돌리지 않습니다`,
      }, { status: 400 });
    }

    const modeIsLive = capability(opMode).needsLiveKey;
    if (connIsLive !== modeIsLive) {
      return NextResponse.json({
        ok: false, error: 'mode_conn_mismatch',
        message: connIsLive
          ? `${opMode} 모드인데 **실전 연결**입니다 — 이대로 두면 실계좌 키로 테스트넷에 주문하게 되어 전부 실패합니다. `
            + '자동 화면에서 실전으로 올리거나 테스트넷 연결을 고르세요.'
          : `${opMode} 모드인데 **테스트넷 연결**입니다 — 실전으로 나가야 할 주문이 테스트넷으로 갑니다. `
            + '자동 화면에서 실전 연결을 고르세요.',
      }, { status: 400 });
    }
  }

  // ── 시장 데이터 ──
  //
  // **주문이 나갈 시장에서 읽는다.** 연결이 없으면(점검 호출 등) 바이낸스
  // 선물을 기본으로 쓴다 — 그래도 현물은 아니다.
  const barsRes = await fetchDailyBars(symbol, connExchange, connIsLive === true ? false : useTestnet);
  const bars = barsRes.bars;
  if (!bars) {
    return NextResponse.json({
      ok: false,
      error: `${symbol} 일봉을 가져오지 못했습니다`,
      // 왜 못 읽었는지·어디서 읽으려 했는지를 남긴다. 이게 없으면
      // 화면에는 '못 가져왔습니다'만 뜨고 원인은 아무도 모른다.
      barsSource: barsRes.source,
      barsError: barsRes.error,
    }, { status: 502 });
  }

  // ── 파생 지표 ──
  //
  // **이 거래를 낼 거래소에서 읽는다.** 예전에는 연결이 Gate여도
  // 바이낸스 펀딩비를 읽었다 — 봉은 이미 연결된 거래소에서 읽도록
  // 고쳐 뒀는데 파생 지표만 남아 있었다. 펀딩비는 거래소마다 다르므로,
  // 그건 다른 시장을 보고 주문하는 것이다.
  //
  // 그리고 `oiChangePct`는 **선언만 있고 대입이 없었다.** 언제나
  // undefined라 Expansion 점수에서 통째로 빠진 채 돌았고, 화면 어디에도
  // 그 사실이 없었다. 이제 실제로 읽고, **못 읽으면 못 읽었다고 적는다.**
  const { readDerivatives } = await import('@/lib/markets/venueDerivatives');
  const deriv = await readDerivatives(
    connExchange, symbol, connIsLive === true ? false : useTestnet);
  // null이면 파이프라인에 넘기지 않는다 — 0으로 넘기면 "펀딩비 0%"가
  // 판단에 들어간다. 측정한 적 없는 값을 근거로 쓰지 않는다.
  const fundingRate = deriv.fundingRatePct ?? undefined;
  const oiChangePct = deriv.oiChangePct ?? undefined;

  const vols = bars.volumes;
  const currentVolume = vols[vols.length - 1];
  const avgVolume = vols.length > 20
    ? vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20
    : undefined;

  // ── 계좌 상태 ──
  const { buildRiskContext } = await import('@/lib/engine/riskContext');
  const ctx = await buildRiskContext(sb, {
    userId,
    connectionId: body.connectionId || null,
    mode,
    // 예약 줄에 저장된 값. GET(크론)이 실어 보낸다.
    // **이 두 줄이 없어서 화면에 100·10을 넣어도 엔진은 기본값으로 돌았다.**
    leverageCap: body.leverageCap ?? null,
    riskPct: body.riskPct ?? null,
    // 배율을 실제로 결정하는 값. 없으면 증거금 예산이 가용 전액이 되어
    // 배율이 낮게 역산된다 — 화면에 100을 적어도 5배가 나간다.
    marginPct: body.marginPct ?? null,
  });

  // ── 파이프라인 ──
  const { runTradingPipeline } = await import('@/lib/engine/tradingPipeline');
  const result = await runTradingPipeline(sb, {
    symbol,
    dailyHighs: bars.highs,
    dailyLows: bars.lows,
    dailyCloses: bars.closes,
    dailyVolumes: bars.volumes,
    currentVolume,
    avgVolume,
    fundingRate,
    oiChangePct,
    consecutiveLosses: ctx.consecutiveLosses,
    riskConfig: ctx.config,
    strategyId: 'daily-ladder',
    bucket: 'swing',
    userId,
    realizedEquity: ctx.config.accountEquity,
    ladderDryRun: dryRun,
  });

  const base = {
    ok: true,
    symbol, mode: opMode, dryRun,
    // **무엇을 읽었고 무엇을 못 읽었는지 값으로 준다.**
    // 예전에는 펀딩비를 바이낸스에서 읽고 oiChangePct는 아예 비어 있었는데,
    // 화면 어디에도 그 사실이 없었다.
    derivatives: {
      venue: deriv.venue,
      fundingRatePct: deriv.fundingRatePct,
      oiChangePct: deriv.oiChangePct,
      missing: deriv.missing,
    },
    stage: result.stage,
    approved: result.approved,
    reason: result.reason,
    // **점수를 그대로 실어 보낸다.** 예전에는 side와 confidence만 보냈고,
    // 그래서 화면이 LONG 54 : SHORT 46을 그리려고 `reason` 문장을 정규식으로
    // 파싱했다 — 사람에게 보여주려고 쓴 문장을 다듬는 순간 화면이 조용히
    // 숫자를 잃는 구조였다.
    battle: result.battle ? {
      side: result.battle.side,
      confidence: result.battle.confidence,
      longTotal: result.battle.longTotal,
      shortTotal: result.battle.shortTotal,
      margin: result.battle.margin,
      minMarginRequired: result.battle.minMarginRequired,
    } : null,
    ladder: result.ladder ? {
      allowed: result.ladder.allowed,
      rejectCode: result.ladder.rejectCode,
      margin: result.ladder.margin,
      tier: result.ladder.decision?.tier.label,
      cycleNumber: result.ladder.state?.cycleNumber,
      progressPct: result.ladder.decision?.progressPct,
    } : null,
    plan: result.plan ? {
      side: result.plan.side, leverage: result.plan.leverage,
      requiredMargin: result.plan.requiredMargin,
      positionSize: result.plan.positionSize,
      liquidationPrice: result.plan.liquidationPrice,
      liquidationDistancePct: result.plan.liquidationDistancePct,
      notes: result.plan.notes,
    } : null,
  };

  // ── 모드 관문 ──
  // 다른 모든 검사를 통과했어도 여기서 막힐 수 있다. 모드는 가장 바깥 관문이다.
  const notionalUsd = result.plan?.positionSize ?? 0;
  // **상한을 자산에 붙인다.** 고정 $1,000짜리 상한은 100배 전략의
  // 명목가(자산의 10배)를 언제나 막는다 — 계좌가 아무리 커져도.
  // 자산을 못 읽었으면 넘기지 않는다: 그때는 고정 금액만 남는다.
  const equityForCap = Number.isFinite(Number(ctx.config.accountEquity))
    ? Number(ctx.config.accountEquity) : null;
  const envCap = Number(process.env.LIVE_MAX_NOTIONAL_USD);
  const modeGate = gateOrder(opMode, notionalUsd, {
    equityUsd: equityForCap,
    overrideMaxNotionalUsd: Number.isFinite(envCap) && envCap > 0 ? envCap : null,
  });

  // 승인 안 됐거나 미리보기면 여기서 끝. 파이프라인이 예약을 이미 되돌렸다.
  // checkOnly는 여기서 멈추지 않는다. 진입 조건이 안 맞는 것과 **관문이
  // 막혀 있는 것**은 다른 문제이고, 알고 싶은 것은 후자다.
  if ((!result.approved && !checkOnly) || dryRun) {
    return NextResponse.json({ ...base, mode: opMode, executed: false },
      { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 주문을 보내지 않는 모드 ──
  // Shadow Live가 여기다. 판단은 전부 마쳤으니 **보냈어야 할 주문을
  // 기록한다.** 기록하지 않으면 그냥 꺼둔 것과 같아서, 나중에 "그때 진짜
  // 보냈으면 어떻게 됐나"를 대조할 수가 없다.
  if (modeGate.disposition !== 'SEND') {
    let recorded = false;
    if (modeGate.disposition === 'RECORD' && result.plan) {
      const tradeDate = result.ladder?.tradeDate || new Date().toISOString().slice(0, 10);
      const { error: recErr } = await sb.from('live_orders').insert({
        // 샤도우 주문임을 id에도 남긴다. 실주문과 사용하는 공간이
        // 같지만 접두사로 구분되고, UNIQUE 충돌도 나지 않는다.
        client_order_id: `SH${tradeDate.replace(/-/g, '')}${symbol}`.slice(0, 36),
        signal_id: `daily-ladder-${tradeDate}-${symbol}`,
        user_id: userId, connection_id: body.connectionId || null,
        // **연결된 거래소를 적는다.** 'binance' 하드코딩이 남아 있어서
        // Gate로 돌린 샤도우 기록이 바이낸스 거래로 남았다 — 나중에
        // "보냈으면 어떻게 됐나"를 대조할 때 다른 시장과 비교하게 된다.
        exchange: connExchange, mode: opMode,
        symbol, side: result.plan.side === 'LONG' ? 'BUY' : 'SELL',
        order_type: 'MARKET',
        quantity: result.plan.quantity, leverage: result.plan.leverage,
        // 상태는 INTENT에서 멈춰 둔다. SENT로 가지 않으므로
        // 복구 대조(SENT/UNKNOWN 조회)가 이 행을 건드리지 않는다.
        status: 'INTENT',
        error_message: modeGate.reason,
      });
      // 하루 한 번 전략이므로 같은 날 같은 심볼이면 UNIQUE에 걸린다.
      // 그건 실패가 아니라 "이미 기록됨"이다. 실패로 표시하면 정상 동작을
      // 오류로 읽게 된다.
      recorded = !recErr || String((recErr as any).code) === '23505';
    }
    // 보내지 않았으므로 오늘 하루를 돌려준다.
    // 샤도우가 예약을 잡아버리면 진짜 모드로 바꿔도 그날은 거래를 못 한다.
    const { releaseReservation } = await import('@/lib/strategies/ladderGate');
    await releaseReservation(sb, result.ladder?.reservationId);

    return NextResponse.json({
      ...base, mode: opMode, executed: false,
      disposition: modeGate.disposition,
      shadowRecorded: recorded,
      reasonMode: modeGate.reason,
    }, {
      status: modeGate.disposition === 'BLOCK' ? 403 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // ── 사람 확인 ──
  // 소액 실전은 건마다 확인한다. 확인 없이 돌아가면 그건 이미 자동매매다.
  //
  // **크론에게는 확인을 받을 사람이 없다.** LIVE_SMALL은 정의상 건마다
  // 사람이 눌러야 하는 모드라, 예약에 걸어 두면 매일 여기서 409로 끝난다.
  // 화면에는 '켜짐'으로 보이고 실행 기록에는 '실패'만 쌓인다 — 이 저장소에서
  // 가장 자주 나온 모양이다. 그래서 이유를 그렇게 적고 무엇을 해야 하는지
  // 함께 준다. 조용히 통과시키지는 않는다: 확인이 필요한 모드는 필요한 것이다.
  if (modeGate.needsConfirmation && body.confirm !== true && !checkOnly) {
    const { releaseReservation } = await import('@/lib/strategies/ladderGate');
    await releaseReservation(sb, result.ladder?.reservationId);
    return NextResponse.json({
      ...base, mode: opMode, executed: false,
      blocked: 'NEEDS_CONFIRMATION',
      error: `${modeGate.reason} — ${opMode}는 건마다 사람이 확인하는 모드라 `
        + '예약(크론)으로는 주문이 나가지 않습니다. 자동 화면에서 모드를 '
        + 'LIVE_LIMITED(제한 자동매매)로 올리거나, 매매 화면에서 직접 주문하세요.',
      notionalUsd,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 주문 ──
  const { releaseReservation, confirmReservation } = await import('@/lib/strategies/ladderGate');
  const reservationId = result.ladder?.reservationId;

  try {
    if (!body.connectionId) throw new Error('connectionId가 없어 주문할 수 없습니다');

    // ── 킬 스위치 ──
    //
    // **여기 없었다.** 이 라우트는 liveTradingGate는 물어보는데
    // 킬스위치는 안 물어봤다. 둘은 다른 장치다 — liveTradingGate는
    // "이 배포에서 실거래를 허용하는가"이고, 킬스위치는 "이 계좌를
    // 지금 멈춰라"다. 사용자가 누르는 건 뒤엣것이다.
    {
      const { killSwitchGate } = await import('@/lib/risk/killSwitch');
      const ksg = await killSwitchGate(sb, body.connectionId);
      if (!ksg.allowed) throw new Error(ksg.message);
    }

    // ── 같은 종목에 다른 전략이 켜져 있는가 ──
    //
    // **이 검사가 여기 없었다.** my-original-v1에만 있었고, 그래서
    // daily-ladder는 같은 계좌·같은 종목에 그대로 들어갈 수 있었다.
    // ONE_WAY 계좌는 종목당 포지션이 하나라, 한쪽의 청산이 다른 쪽
    // 포지션을 닫고 한쪽의 손절이 다른 쪽 진입에 발동한다.
    //
    // 판정은 strategyConflictGate 한 곳에 있다 — 복사하지 않는다.
    {
      const { strategyConflictGate, sleeveCapitalGate } = await import('@/lib/engine/strategyConflictGate');
      const cf = await strategyConflictGate(sb, {
        userId: userId!, myStrategyId: 'daily-ladder', symbol, connectionId: body.connectionId,
      });
      if (!cf.ok) throw new Error(cf.reason);

      // **다른 전략의 돈을 끌어오지 않는다.** 전략 계좌를 안 만들었으면
      // 막지 않는다 — 지금까지 돌던 전략이 갑자기 멈추면 안 된다.
      const sl = await sleeveCapitalGate(sb, {
        userId: userId!, strategyId: 'daily-ladder', connectionId: body.connectionId,
      });
      if (!sl.allowed) throw new Error(sl.reason);
    }

    // ── 웹과 워커가 같은 것을 보고 있는가 ──
    //
    // 암호화 키가 다르면 워커는 거래소 키를 못 푼다. 증상은 "키가
    // 틀렸다"로 보여서 엉뚱한 곳을 고치게 된다.
    {
      const { parityGate } = await import('@/lib/ops/parityGate');
      const pg = await parityGate(sb);
      if (!pg.entryAllowed) throw new Error(pg.entryReason);
    }

    // ── 닫아 줄 사람이 있는가 ──
    //
    // 청산 감시가 죽어 있으면 트레일링·본전이동·시간청산이 안 돈다.
    // **못 여는 것은 불편이고 못 닫는 것은 사고다.**
    {
      const { exitMonitorGate } = await import('@/lib/engine/exitMonitorGate');
      const em = await exitMonitorGate(sb);
      if (em.blockEntry) throw new Error(em.reason);
    }

    // ── DB가 코드를 따라왔는가 ──
    //
    // 코드가 요구하는 칸이 DB에 없으면 쓰기는 조용히 실패하고 매매는
    // 계속된다(054에서 실제로 일어난 일). **적용이 안 끝났으면 막는다.**
    // 적용 자체는 migrate 워크플로가 자동으로 한다 — 사람이 할 일은 없다.
    {
      const { migrationGate } = await import('@/lib/system/migrationGate');
      const mg = await migrationGate(sb);
      if (!mg.entryAllowed) throw new Error(mg.entryReason);
    }

    // ── 점검용 가상 계획 ──
    //
    // 진입 신호가 없으면 파이프라인은 계획을 만들지 않는다. 그러면 손절가·
    // 필요 증거금 같은 계획 기반 항목이 전부 '모름'이 되고, 점검 결과가
    // **막힌 것처럼 보인다** — 실제로는 아무 문제가 없는데도.
    //
    // 그래서 점검일 때만, 지금 설정으로 진입한다면 어떤 계획이 나올지를
    // 같은 규칙(증거금 예산 × 역산 배율)으로 만들어 그것으로 관문을 본다.
    // 응답에 가상이라고 적는다 — 이 숫자가 실제 주문이라고 읽히면 안 된다.
    const usedSyntheticPlan = checkOnly && !result.plan;
    if (usedSyntheticPlan) {
      const px = bars.closes[bars.closes.length - 1];
      const eqNow = Number(ctx.config.accountEquity);
      const stopPct = 2;                                   // 기본 손절 거리
      const marginBudget = Number.isFinite(eqNow) && eqNow > 0
        ? eqNow * ((Number(body.marginPct) > 0 ? Number(body.marginPct) : 10) / 100)
        : null;
      const capLev = Number(body.leverageCap) > 0 ? Number(body.leverageCap) : 100;
      const riskLev = (Number(body.riskPct) > 0 ? Number(body.riskPct) : 10) / stopPct;
      const lev = Math.max(1, Math.floor(Math.min(capLev, riskLev * (marginBudget && eqNow ? eqNow / marginBudget : 1))));
      const notional = marginBudget != null ? marginBudget * lev : 0;
      (result as any).plan = {
        side: 'LONG', leverage: lev,
        requiredMargin: marginBudget, positionSize: notional,
        quantity: px > 0 ? notional / px : 0,
        stopDistancePct: stopPct,
        liquidationPrice: null,
        notes: ['점검용 가상 계획 — 실제 진입 신호가 아닙니다'],
      };
    }

    // ── 상태 대조 관문 ──
    // 계단 게이트가 "오늘 아직 거래 안 함"이라고 판단해도, 그건 앱의 기록
    // 기준이다. 거래소에 이미 포지션이 열려 있거나 손절이 사라져 있으면
    // 그 위에 하나를 더 얹게 된다. 주문 직전에 실물과 대조한다.
    // ── 다른 전략 물량 확인 ──
    // 이 전략의 손절은 closePosition=true인 전량 STOP_MARKET이다
    // (exitPlan.ts). 같은 심볼을 다른 전략이 들고 있으면 그 손절이
    // **남의 포지션까지 닫는다.** 그쪽 전략은 자기가 아직 들고 있다고
    // 믿고 손절도 익절도 걸지 않는다.
    const foreign = await findForeignHolders(sb, userId, symbol, 'daily-ladder');
    if (foreign.length > 0) {
      await releaseReservation(sb, result.ladder?.reservationId);
      return NextResponse.json({
        ...base, mode: opMode, executed: false,
        blocked: 'FOREIGN_STRATEGY_HOLDS',
        error: `${symbol}을(를) 다른 전략(${foreign.join(', ')})이 보유 중입니다. ` +
               '이 전략의 손절은 전량 청산이라 그쪽 포지션까지 닫습니다.',
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }

    const { assertStateConsistent } = await import('@/lib/engine/reconcileCheck');
    const gate = await assertStateConsistent(sb, userId, useTestnet, body.connectionId || null);
    // 점검일 때는 여기서 끊지 않는다. **무엇이 어긋났는지**까지 보여줘야
    // 고칠 수 있고, 상태 불일치 말고 다른 관문도 같이 봐야 한다.
    // 아래 체크리스트가 이 판정을 그대로 받아 항목으로 만든다.
    if (!gate.allowed && !checkOnly) {
      await releaseReservation(sb, result.ladder?.reservationId);
      return NextResponse.json({
        ...base, executed: false,
        blocked: 'STATE_MISMATCH',
        error: gate.reason,
        mismatches: gate.verdict?.mismatches ?? [],
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }

    const { data: conn } = await sb.from('exchange_connections')
      .select('exchange_id, api_key, api_secret_enc, has_withdrawal, user_id')
      .eq('id', body.connectionId)
      .eq('user_id', userId)         // 소유권 — 남의 연결로 주문할 수 없다
      .maybeSingle();

    if (!conn) throw new Error('거래소 연결을 찾을 수 없거나 본인의 연결이 아닙니다');
    if (conn.has_withdrawal) throw new Error('출금 권한이 있는 키는 자동매매에 사용할 수 없습니다');

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { executeOrder } = await import('@/lib/engine/orderExecutor');

    const exchange = (await import('@/lib/exchanges/futuresAdapter')).futuresExchangeOf(conn.exchange_id);
    // **모르면 주문하지 않는다.** null을 그대로 흘려보내면 아래에서
    // `exchange === 'gate'`가 false라 바이낸스 분기로 가고, 그러면
    // 남의 키로 바이낸스에 서명 요청이 나간다. 캐스팅이 그것을 숨긴다.
    if (!exchange) {
      return NextResponse.json({
        ok: false, error: 'unsupported_exchange',
        message: `이 연결(${conn.exchange_id || '알 수 없음'})로는 주문을 내지 않습니다`,
      }, { status: 400 });
    }
    const tradeDate = result.ladder?.tradeDate || new Date().toISOString().slice(0, 10);
    const clientOrderId = `LD${tradeDate.replace(/-/g, '')}${symbol}`.slice(0, 36);

    // 손절가는 파이프라인이 쓴 것과 같은 기준(마지막 종가 ± 손절거리)으로
    // 되돌려 계산한다. plan에는 거리(%)만 있고 가격이 없다.
    const lastClose = bars.closes[bars.closes.length - 1];
    const stopLoss = result.plan!.side === 'LONG'
      ? lastClose * (1 - result.plan!.stopDistancePct / 100)
      : lastClose * (1 + result.plan!.stopDistancePct / 100);

    // ── 비대칭 청산 계획 ──
    // 손절은 전량 고정, 1.5R/3R에서 30%씩 분할 익절, 잔량 40%는 트레일링
    // 대기. 분할 수량은 거래소 단위에 맞춰야 거부되지 않으므로 필터를 읽는다.
    const { buildExitPlan } = await import('@/lib/engine/exitPlan');
    let qtyStep: number | undefined, minQty: number | undefined;
    try {
      // **이 거래소의** 규격을 읽는다. 예전에는 Gate 연결에서도 바이낸스
      // 규격을 읽었다. Gate의 수량 단위는 정수 계약(BTC_USDT는 0.0001)이라
      // 남의 격자로 자른 분할 수량은 계약 경계에 안 맞을 수 있다.
      const { futuresSymbolFilters } = await import('@/lib/exchanges/futuresAdapter');
      const f = await futuresSymbolFilters(exchange as any, symbol, useTestnet);
      if (f?.stepSize) { qtyStep = f.stepSize; minQty = f.minQty ?? undefined; }
    } catch { /* 필터를 못 읽으면 반올림 없이 진행 — 거래소가 거부하면 분할만 빠진다 */ }

    const exitPlan = buildExitPlan({
      side: result.plan!.side,
      entryPrice: lastClose,
      stopPrice: stopLoss,
      quantity: result.plan!.quantity,
      liquidationPrice: result.plan!.liquidationPrice,
      qtyStep, minQty,
      maxHoldBars: body.maxHoldDays ?? 5,   // 일봉 기준 — 5일 넘게 들고 있지 않는다
    });

    // ── 거래 전 점검 (마지막 관문) ──
    //
    // 위의 검사들을 하나의 목록으로 모아 다시 판정한다. 왜 또 보는가:
    //  1. 흩어진 검사가 전부 돌았는지 **한 곳에서** 확인할 수 있어야 한다.
    //     지금까지는 검사를 하나 빼먹어도 아무도 몰랐다
    //  2. 여기서만 보는 것이 둘 있다 — 시계 오차, 그리고 신규 진입 심볼의
    //     마진 모드. 둘 다 이 지점까지 확인된 적이 없다
    //  3. 실패 이유를 목록 모양으로 돌려주면 화면이 그대로 그릴 수 있다.
    //     `/api/orders/preflight`와 **같은 판정 함수**를 쓰므로 미리 본 결과와
    //     실제로 막히는 근거가 갈리지 않는다
    //
    // 거래소를 다시 읽지 않는다. 상태 대조가 방금 읽은 것을 gather로 받아
    // 쓰고, 추가 호출은 두 개뿐이다 — 서버 시각(공개)과 이 심볼의 위험 정보.
    // 심볼별 조회가 필요한 이유: getFuturesPositions는 수량 0을 걸러내므로
    // 신규 진입 심볼의 마진 모드가 그 목록에 없다.
    const { runChecklist } = await import('@/lib/engine/preTradeChecklist');
    const apiSecretPre = decryptSecret(conn.api_secret_enc ?? '');

    // ── 거래소별로 읽는다 ──
    //
    // 예전에는 바이낸스 API만 불렀다. Gate 연결이면 Gate 키로 바이낸스에
    // 물어보게 되고, 실패 → 마진 모드 unknown → 필수 항목 차단으로
    // **모든 Gate 주문이 막혔다.** 시계도 다른 회사 서버에 물어보는 셈이었다.
    //
    // 로컬 시각은 호출 직후에 찍는다. 응답을 기다린 뒤 찍으면 왕복 지연이
    // 그대로 오차로 계산돼 시계가 정확해도 실패로 뜬다.
    let serverMs: number | null = null;
    let risk: { marginType: string; leverage: number | null;
                liquidationPrice: number | null; positionAmt: number } | null = null;
    const localMs = Date.now();

    if (exchange === 'gate') {
      const gfPre = await import('@/lib/exchanges/gateFutures');
      const gpPre = await import('@/lib/exchanges/gatePlan');
      serverMs = await gfPre.getGateServerTime(useTestnet);
      const contractPre = gpPre.toGateContract(symbol);
      const gpos = await gfPre.getPositionGateFutures(conn.api_key, apiSecretPre, contractPre, useTestnet);
      // 변환은 gatePositionToRisk 한 곳에만 둔다 — 'leverage 0은 교차'를
      // 호출자마다 다시 적으면 한 곳을 고쳐도 나머지가 조용히 틀린 채 남는다.
      risk = gpPre.gatePositionToRisk(gpos);

      // ── Gate도 마진 모드를 **점검 전에** 맞춘다 ──
      //
      // 바이낸스에서 고친 것과 같은 자리다. 차이가 하나 있다:
      // 바이낸스는 포지션이 없어도 marginType을 알려주는데, **Gate는
      // 포지션이 없으면 아무것도 안 준다**(gatePositionToRisk가 null).
      // 그러면 점검의 'MARGIN_ISOLATED'가 unknown이 되고, 그건 차단
      // 항목이라 **첫 진입이 매일 여기서 막힌다.**
      //
      // Gate에서는 배율을 정하는 것이 곧 격리를 정하는 것이다(0이 교차).
      // 계획한 배율로 설정하면 격리가 되고, 그 값을 다시 읽어 점검에 준다.
      // **바꿨다고 믿지 않고 되읽는다** — 설정이 실패해도 응답은 성공처럼
      // 보일 수 있다.
      if (!risk || String(risk.marginType).toLowerCase() !== 'isolated') {
        const wantLev = Math.max(1, Math.round(Number(result.plan?.leverage) || 1));
        try {
          await gfPre.setLeverageGateFutures(conn.api_key, apiSecretPre, contractPre, wantLev, useTestnet);
          const again = await gfPre.getPositionGateFutures(conn.api_key, apiSecretPre, contractPre, useTestnet);
          const r2 = gpPre.gatePositionToRisk(again);
          if (r2) risk = r2;
        } catch { /* 못 바꿨으면 아래 점검이 unknown 그대로 보고 막는다 */ }
      }
    } else {
      const bfPre = await import('@/lib/exchanges/binanceFutures');
      serverMs = await bfPre.getFuturesServerTime(useTestnet);
      let r = await bfPre.getSymbolPositionRisk(conn.api_key, apiSecretPre, symbol, useTestnet);

      // ── 마진 모드를 **점검 전에** ISOLATED로 맞춘다 ──
      //
      // 바이낸스 선물 계좌의 기본값은 CROSS다. 그래서 새 계좌·새 심볼은
      // 언제나 cross로 시작하는데, 점검 목록의 'MARGIN_ISOLATED'는
      // 차단 항목이다. 결과: **첫 실전 진입이 매일 여기서 막힌다.**
      // 예약은 켜져 있고 크론도 돌고 기록에는 '실패'만 남는다.
      //
      // executeOrder가 주문 직전에 바꾸긴 하지만 그건 점검을 통과한 뒤라
      // 도달하지 못한다. 포지션이 없을 때만 바꾼다 — 열린 포지션의 마진
      // 모드를 건드리면 거래소가 거부하고, 성공해도 그건 다른 이야기다.
      if (r && String(r.marginType).toUpperCase() !== 'ISOLATED' && Math.abs(r.positionAmt) === 0) {
        try {
          await bfPre.setFuturesMarginType(conn.api_key, apiSecretPre, symbol, 'ISOLATED', useTestnet);
          // 바꿨다고 믿지 않는다. 다시 읽어서 실제 값을 점검에 넘긴다.
          const again = await bfPre.getSymbolPositionRisk(conn.api_key, apiSecretPre, symbol, useTestnet);
          if (again) r = again;
        } catch { /* 못 바꿨으면 아래 점검이 cross 그대로 보고 막는다 */ }
      }

      if (r) {
        risk = {
          marginType: r.marginType, leverage: r.leverage,
          liquidationPrice: r.liquidationPrice, positionAmt: r.positionAmt,
        };
      }
    }

    // ── 서브계좌 한도 ──
    //
    // **이 항목을 안 넘기고 있었다.** 점검 목록에서 SUBACCOUNT_LIMIT은
    // '모르면 막는' 항목이라(requiredToKnow), 안 넘기면 unknown이 되어
    // **모든 진입이 매번 차단됐다.** 수동 주문 경로는 collectAllLimits로
    // 이 값을 채우고 있었고, 자동 경로만 빠져 있었다 — 그래서 손으로는
    // 되는데 자동으로는 안 되는 상태였다.
    let subAccountFact: { status: 'ok' | 'over' | 'unassigned' | 'unknown'; reason: string } | null = null;
    try {
      const { collectSubAccount } = await import('@/lib/portfolio/subAccountCheck');
      const sa = await collectSubAccount({
        sb, userId, market: 'USDM', symbol,
        addMarginUsd: result.plan!.requiredMargin ?? null,
        // 열린 포지션을 **못 읽었으면 빈 배열로 치지 않는다** — 빈 배열은
        // "아무것도 안 쓰고 있다"가 되어 한도가 통째로 넉넉해진다.
        open: gate.gather.reachable
          ? gate.gather.exchangePositions.map((p: any) => ({
              symbol: String(p.symbol), market: 'USDM', marginUsd: p.margin ?? null,
            }))
          : null,
      });
      subAccountFact = { status: sa.verdict.status, reason: sa.verdict.reason };
    } catch (e: any) {
      subAccountFact = { status: 'unknown', reason: `서브계좌 한도를 확인하지 못했습니다 (${e?.message || e})` };
    }

    // 오늘 손실 한도 — 자동매매에서 가장 중요한 관문이다. 사람이 안 보고
    // 있는 동안 도는 경로이므로, 여기가 막히지 않으면 하루 한도가 없는 것과 같다.
    type LimitV = { status: 'ok' | 'locked' | 'unknown'; reason: string } | null;
    let dailyLossFact: LimitV = null;
    let weeklyFact: LimitV = null;
    let streakFact: LimitV = null;
    try {
      const { collectDailyLoss } = await import('@/lib/risk/dailyLossCheck');
      const f = await collectDailyLoss({
        apiKey: conn.api_key, apiSecret: apiSecretPre, testnet: useTestnet,
        exchange,
        // 계좌 자산은 riskContext가 이미 읽어 뒀다. 여기서 또 부르면
        // 레이트리밋을 두 배로 쓰고, 두 조회 사이에 값이 달라진다.
        currentEquityUsd: ctx.config.accountEquity ?? null,
      });
      dailyLossFact = { status: f.verdict.status, reason: f.verdict.reason };

      // 주간 한도 · 연패. 크론이 도는 경로라 여기가 막히지 않으면
      // 그 잠금은 없는 것과 같다.
      const { collectStreakLimits } = await import('@/lib/risk/lossStreakCheck');
      const sf = await collectStreakLimits({
        apiKey: conn.api_key, apiSecret: apiSecretPre, testnet: useTestnet,
        exchange,
        currentEquityUsd: ctx.config.accountEquity ?? null,
      });
      weeklyFact = { status: sf.weekly.status, reason: sf.weekly.reason };
      streakFact = { status: sf.streak.status, reason: sf.streak.reason };
    } catch { /* null → unknown → 막힌다 */ }

    // ── 포지션 모드 · 거래소 보호 주문 ──
    //
    // **이 둘을 안 넘기고 있었다.** 그래서 점검 목록의 POSITION_MODE는
    // 언제나 '확인하지 못했습니다'였고, 거래소에 손절이 실제로 걸려 있는지는
    // 아무도 묻지 않았다 — STOP_ATTACHED는 계획의 손절가만 본다.
    //
    // 거래소별 분기는 여기 없다. futuresAdapter가 binance·gate를 같은
    // 계약으로 감싼다 — 분기를 라우트마다 다시 쓰면 한쪽만 고쳐진다.
    //
    // **실패를 '없음'으로 적지 않는다.** 못 읽으면 null을 그대로 넘기고,
    // 점검 목록이 unknown으로 남겨 신규 진입을 막는다.
    let positionModeFact: { mode: 'ONE_WAY' | 'HEDGE' | null; reason?: string } | null = null;
    let protectiveFact: {
      stopCount: number | null; takeProfitCount?: number | null; reason?: string;
    } | null = null;
    try {
      const fa = await import('@/lib/exchanges/futuresAdapter');
      const fex = fa.futuresExchangeOf(exchange);
      if (!fex) {
        const why = `이 실행기가 지원하지 않는 거래소입니다 (${exchange})`;
        positionModeFact = { mode: null, reason: why };
        protectiveFact = { stopCount: null, reason: why };
      } else {
        // **지금 열려 있는 포지션의 방향.** 이걸 넘겨야 "이 포지션을 지키는
        // 손절"만 센다. 안 넘기면 롱을 들고 있는데 남아 있는 숏용 손절이
        // 방어선으로 잡힌다 — 그건 아무것도 지키지 않는다.
        // 포지션이 없거나 못 읽었으면 null이고, 그때는 손절 수를 확정하지
        // 않는다(포지션이 없으면 점검이 그 앞에서 통과시킨다).
        const amt = Number(risk?.positionAmt);
        const posSide: 'LONG' | 'SHORT' | null =
          Number.isFinite(amt) && amt > 0 ? 'LONG'
          : Number.isFinite(amt) && amt < 0 ? 'SHORT'
          : null;
        const [pm, po] = await Promise.all([
          fa.futuresPositionMode(fex, conn.api_key, apiSecretPre, useTestnet),
          fa.futuresProtectiveOrders(fex, conn.api_key, apiSecretPre, useTestnet, symbol, posSide),
        ]);
        positionModeFact = { mode: pm.mode, reason: pm.error || undefined };
        // **손절 수로 판정한다.** 총 개수를 넘기면 익절만 있는 상태가 통과한다.
        protectiveFact = {
          stopCount: po.stopCount, takeProfitCount: po.takeProfitCount,
          reason: po.error || po.detail || undefined,
        };
      }
    } catch (e: any) {
      const why = `조회에 실패했습니다 (${e?.message || e})`;
      positionModeFact = { mode: null, reason: why };
      protectiveFact = { stopCount: null, reason: why };
    }

    // 시장 국면. 일봉은 위에서 이미 받아 뒀다(bars.closes) — 다시 받으면
    // 두 조회 사이에 값이 달라져 점검과 실제 판단이 다른 봉을 본다.
    const { collectRegime } = await import('@/lib/risk/regimeCheck');
    const regimeFacts = await collectRegime({
      symbol, side: result.plan!.side, closes: bars.closes,
    });

    const checklist = runChecklist({
      mode: { disposition: modeGate.disposition, reason: modeGate.reason },
      dailyLoss: dailyLossFact,
      weeklyLoss: weeklyFact, lossStreak: streakFact,
      regime: { status: regimeFacts.verdict.status, reason: regimeFacts.verdict.reason },
      subAccount: subAccountFact,
      clock: serverMs != null ? { localMs, serverMs } : null,
      // 점검 모드에서는 통과 못 한 상태로도 여기 오므로 **실제 판정을**
      // 넘긴다. 예전처럼 true/false를 박아 두면 점검이 "일치"라고 적고
      // 정작 주문은 막힌다 — 미리보기가 거짓말을 하는 것이다.
      reconcile: {
        reachable: gate.gather.reachable,
        blockNewOrders: !gate.allowed,
        summary: gate.verdict?.summary || gate.reason || '일치',
      },
      unresolvedOrderCount: gate.gather.unresolvedOrders.length,
      marginType: risk?.marginType ?? null,
      leverage: risk?.leverage != null
        ? { actual: risk.leverage, intended: result.plan!.leverage }
        : null,
      existingPositionQty: risk ? Math.abs(risk.positionAmt) : null,
      positionMode: positionModeFact,
      protectiveOrders: protectiveFact,
      // 계단 게이트가 예약을 내줬다 = 오늘 아직 거래하지 않았다.
      // 여기서 ladderGate를 다시 부르면 슬롯이 또 예약된다.
      todayEntry: { alreadyTraded: false },
      stopPrice: stopLoss,
      // 거래소가 준 청산가를 우선한다. 포지션이 없으면 계획의 계산값을 쓴다 —
      // 그때는 아직 거래소에 청산가가 존재하지 않는다.
      liquidationPrice: risk?.liquidationPrice ?? result.plan!.liquidationPrice ?? null,
      side: result.plan!.side,
      margin: {
        required: result.plan!.requiredMargin,
        available: ctx.config.availableMargin ?? ctx.config.accountEquity,
      },
    }, {
      // USDⓈ-M 진입이고, 이 전략은 하루 1회 제한이 있다.
      // dailyLimit를 켜야 '오늘 진입 이력'이 목록에 들어온다.
      market: 'USDM', intent: 'ENTRY', dailyLimit: true,
      // **이 경로는 거래소에 직접 물어봤다.** 포지션 모드와 보호 주문을
      // 위에서 조회해 넘긴다 — 그래서 그 둘을 차단 항목으로 올린다.
      exchangeEvidence: true,
      // 국면 필터는 켠 경우에만 목록에 들어온다 (REGIME_FILTER 환경변수).
      regimeFilter: regimeFacts.enabled,
    });

    // ── 점검만 하고 끝낸다 ──
    // 통과했든 막혔든 **주문은 내지 않고 슬롯도 돌려준다.**
    if (checkOnly) {
      await releaseReservation(sb, reservationId);
      return NextResponse.json({
        ...base, executed: false, checkOnly: true,
        approvedByPipeline: result.approved,
        syntheticPlan: usedSyntheticPlan,
        // **몇 건인지가 아니라 무엇인지.** 개수만 주면 고칠 수가 없다.
        mismatches: gate.verdict?.mismatches ?? [],
        error: checklist.allowed ? null : checklist.summary,
        checklist: {
          allowed: checklist.allowed,
          passed: checklist.passed, total: checklist.total,
          unknownCount: checklist.unknownCount,
          results: checklist.results,
          blockers: checklist.blockers,
        },
        note: checklist.allowed
          ? (result.approved
              ? '지금 이 순간이면 주문이 나갑니다 — 모든 관문을 통과했습니다'
              : '관문은 전부 통과했습니다. 진입 조건(신호)만 아직 안 맞습니다 — 조건이 맞는 순간 주문이 나갑니다'
                + (usedSyntheticPlan ? ' (계획 기반 항목은 지금 설정으로 만든 가상 계획으로 확인했습니다)' : ''))
          : '이대로면 주문이 나가지 않습니다 — 아래 막힌 항목을 보세요',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (!checklist.allowed) {
      // 오늘 하루를 돌려준다. 주문이 나가지 않았으므로 슬롯을 소모하면
      // 사용자는 원인을 고친 뒤에도 내일까지 기다려야 한다.
      await releaseReservation(sb, reservationId);
      return NextResponse.json({
        ...base, executed: false,
        blocked: 'CHECKLIST_BLOCKED',
        error: checklist.summary,
        checklist: {
          allowed: false,
          passed: checklist.passed,
          total: checklist.total,
          unknownCount: checklist.unknownCount,
          results: checklist.results,
          blockers: checklist.blockers,
        },
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }

    // ── 주문 직전에 배율을 맞추고 되읽어 확인한다 ──
    //
    // 점검 목록의 배율 항목은 blocking:false다. 즉 **거래소가 5배인데
    // 계획이 50배여도 경고만 뜨고 주문이 그대로 나갔다.**
    //
    // 수량은 손절 거리에서 역산된 값이고 필요 증거금은 명목가 ÷ 배율이라,
    // 배율이 10분의 1이면 필요 증거금이 열 배가 된다. 대개는 증거금
    // 부족으로 거부되고 그 거부는 "왜 안 됐는지 모르겠다"로 남는다.
    //
    // **배율을 맞췄다는 이유로 청산 안전 검사를 통과시키지는 않는다.**
    // 그건 위 체크리스트가 이미 봤고, 여기는 '의도한 배율이 실제로
    // 걸렸는가'만 답한다.
    const { ensureLeverage } = await import('@/lib/engine/leverageSync');
    const apiSecretForLev = decryptSecret(conn.api_secret_enc ?? '');
    const levSync = await ensureLeverage(result.plan!.leverage, {
      read: async () => {
        if (exchange === 'gate') {
          const gf = await import('@/lib/exchanges/gateFutures');
          const gp = await import('@/lib/exchanges/gatePlan');
          const c = gp.toGateContract(symbol);
          if (!c) return null;
          const pos = await gf.getPositionGateFutures(conn.api_key, apiSecretForLev, c, useTestnet);
          const r = gp.gatePositionToRisk(pos);
          // Gate는 leverage 0이 교차다. 0을 '0배'로 읽으면 안 된다.
          return r && r.leverage ? r.leverage : null;
        }
        const bf = await import('@/lib/exchanges/binanceFutures');
        const r = await bf.getSymbolPositionRisk(conn.api_key, apiSecretForLev, symbol, useTestnet);
        return r && Number(r.leverage) > 0 ? Number(r.leverage) : null;
      },
      write: async (lev: number) => {
        try {
          const { futuresSetLeverage } = await import('@/lib/exchanges/futuresAdapter');
          const w: any = await futuresSetLeverage(
            exchange, conn.api_key, apiSecretForLev, symbol, lev, useTestnet);
          return { ok: w?.success !== false, message: w?.message };
        } catch (e: any) { return { ok: false, message: e?.message || String(e) }; }
      },
    }, { positionOpen: !!risk && Math.abs(Number(risk.positionAmt) || 0) > 0 });

    if (!levSync.ok) {
      // 오늘 하루를 돌려준다 — 주문이 안 나갔으므로 슬롯을 쓴 것이 아니다.
      await releaseReservation(sb, reservationId);
      return NextResponse.json({
        ...base, executed: false, blocked: 'LEVERAGE_MISMATCH',
        error: levSync.reason,
        // **거래소 원문을 뭉개지 않는다.** 뭉개면 무엇을 고쳐야 할지 모른다.
        leverage: {
          intended: levSync.intended, before: levSync.before, after: levSync.after,
          code: levSync.code, exchangeMessage: levSync.exchangeMessage ?? null,
        },
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }

    const exec = await executeOrder(sb, {
      userId,
      connectionId: body.connectionId,
      // 소유 전략을 주문에 새긴다. 이게 없으면 나중에 이 포지션이
      // 누구 것인지 알 수 없고, 장부가 '주인 미상'으로 쌓인다.
      signalId: tagStrategy(`daily-ladder-${tradeDate}-${symbol}`, 'daily-ladder'),
      clientOrderId,
      exchange,
      mode: mode as 'TESTNET' | 'LIVE',
      plan: result.plan!,
      stopLoss,
      exitPlan,
      apiKey: conn.api_key,
      apiSecret: decryptSecret(conn.api_secret_enc ?? ''),
    });

    // ── `exec.ok`는 진입이 아니다 ──
    //
    // **예전에는 두 갈래뿐이었다:**
    //
    //     exec.ok ? confirmReservation(...)   // → status OPEN
    //             : releaseReservation(...)   // → 예약 행 DELETE
    //
    // 그래서 "모른다"가 갈 곳이 없었다. `executeOrder`의 `ok: false`에는
    // REJECTED(거부됨) · FAILED(못 보냄) · **UNKNOWN(나갔는지 모름)**이
    // 섞여 있는데, 마지막 것을 지우면 `(user_id, strategy_id, trade_date)`
    // unique가 풀린다 — **하루 1회 잠금이 열린다.** 그 상태에서 다음
    // 주기가 오면 같은 날 두 번째 주문이 나가고, 앞 주문이 실제로는
    // 체결돼 있었다면 포지션이 두 배가 된다.
    //
    // 반대쪽도 같다. `ok: true`는 접수(ACKED)만으로도 참이다. 그걸 진입
    // 완료로 적으면 체결되지 않은 주문이 장부에 남고, 그 위에서 계산한
    // 손익은 처음부터 틀린다.
    //
    // 증거를 모아 판정하는 함수(`enteredVerdict`)는 이미 저장소에 있고
    // my-original-v1은 쓰고 있었다. **여기만 안 쓰고 있었다.**
    const { enteredVerdict, outcomeOf } = await import('@/lib/engine/entryEvidence');
    const { entryLedgerPlan } = await import('@/lib/strategies/entryLedger');
    const opsAfter = await import('@/lib/engine/venuePositionOps');

    // **거래소에 직접 물어본다.** 주문 응답은 우리가 보낸 것에 대한
    // 답이고, 포지션 조회는 계좌의 사실이다.
    const posAfter = exchange
      ? await opsAfter.readOpenPosition(
          { exchange, apiKey: conn.api_key, apiSecret: decryptSecret(conn.api_secret_enc ?? ''), testnet: useTestnet },
          symbol)
      : { ok: false, found: false, qty: null, side: null, error: '선물을 지원하지 않는 거래소' };

    const firstTp = exitPlan.orders.find(o => o.kind === 'PARTIAL_TP');
    const ev = enteredVerdict({
      expectedSide: result.plan!.side,
      settled: exec?.settled ?? null,
      filledQty: exec?.filledQty ?? null,
      avgPrice: exec?.avgPrice ?? null,
      // **거절과 미확정을 구분해서 넘긴다.** `ok === false`를 전부
      // '거절'로 넘기면 UNKNOWN이 NOT_ENTERED로 접혀서, 지금 고치려는
      // 바로 그 구조로 되돌아간다.
      rejected: exec?.status === 'REJECTED' || exec?.status === 'FAILED',
      position: posAfter as any,
      leverageConfirmed: exec?.leverageConfirmed ?? null,
      positionModeConfirmed: exec?.positionModeConfirmed ?? null,
      stop: exec?.protection?.stop ?? null,
      takeProfit: exec?.protection?.takeProfit ?? null,
      // 계단식은 분할 익절 사다리를 건다. 사다리가 있으면 익절도 증거다.
      takeProfitRequired: !!firstTp,
    });
    const plan = entryLedgerPlan(ev.code);
    const outcome = outcomeOf(ev);

    const fill = {
      leverage: result.plan!.leverage,
      entryPrice: exec.avgPrice,
      liquidationPrice: result.plan!.liquidationPrice,
      // 손절가는 여기 스코프에 이미 있다(`stopLoss` — 위 executeOrder에
      // 넘긴 바로 그 값). 이게 장부에 없으면 청산 감시가 이 거래에서
      // 트레일링·본전이동을 계산하지 못한다.
      stopLoss,
      takeProfit: firstTp?.price,
      // 이 포지션을 **어느 계좌에서 찾을지**를 정한다. 없으면 감시가
      // 사용자의 활성 연결 중 하나를 임의로 고른다.
      connectionId: body.connectionId ?? null,
    };

    if (plan.status === 'OPEN') {
      await confirmReservation(sb, reservationId, fill);
    } else if (plan.releaseDay) {
      // **여기만 하루를 돌려준다.** 안 들어간 것이 확인된 경우뿐이다.
      await releaseReservation(sb, reservationId);
    } else {
      // 모르는 것과 보호 없는 포지션. **예약 행을 지우지 않는다** —
      // 지우면 하루 잠금이 풀리고, 보호 없는 포지션을 아무도 안 본다.
      const { holdReservation } = await import('@/lib/strategies/ladderGate');
      await holdReservation(sb, reservationId, {
        status: plan.status!,
        reason: `${ev.reason} — ${plan.note}`,
        fill,
      });
    }

    return NextResponse.json({
      ...base,
      // **접수를 진입으로 적지 않는다.** 증거로 확인됐을 때만 참이다.
      executed: ev.entered,
      outcome,
      entryEvidence: {
        code: ev.code, have: ev.have, missing: ev.missing,
        retryable: ev.retryable, reason: ev.reason,
        // 오늘 한 번을 돌려줬는가. 돌려주지 않았으면 재주문은 막힌다.
        dayReleased: plan.releaseDay, ledgerStatus: plan.status,
      },
      // 통과한 점검도 실어 보낸다. 막힐 때만 보여주면 사용자는 "점검이
      // 돌았는지" 알 수 없고, 확인 못 한 항목(unknown)이 있었다는 사실도
      // 사라진다 — 통과했지만 두 개는 확인 못 했다는 것은 알아야 한다.
      checklist: {
        allowed: true,
        passed: checklist.passed,
        total: checklist.total,
        unknownCount: checklist.unknownCount,
        results: checklist.results,
      },
      order: {
        status: exec.status, clientOrderId: exec.clientOrderId,
        exchangeOrderId: exec.exchangeOrderId,
        filledQty: exec.filledQty, avgPrice: exec.avgPrice,
        slOrderId: exec.slOrderId, message: exec.message,
      },
      exit: {
        stopPrice: stopLoss,
        partials: exitPlan.orders
          .filter(o => o.kind === 'PARTIAL_TP')
          .map(o => ({ atR: o.atR, price: o.price, quantity: o.quantity })),
        trailingQty: exitPlan.trailingQty,
        trailStartR: exitPlan.trailStartR,
        trailDistanceR: exitPlan.trailDistanceR,
        breakEvenAtR: exitPlan.breakEvenAtR,
        maxHoldBars: exitPlan.maxHoldBars,
        notes: exitPlan.notes,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    await releaseReservation(sb, reservationId);
    return NextResponse.json({
      ...base, executed: false, error: e?.message || '주문 실패',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

/**
 * GET — **크론 진입점.**
 *
 * 왜 이게 없어서 자동매매가 한 번도 안 돌았나
 * ──────────────────────────────────────────
 * 진입 엔진은 POST에 있고, 실행하려면 누가·어느 종목·어느 연결로 할지를
 * 본문에 받아야 한다. 그런데 **Vercel 크론은 GET만 보내고 본문을 못
 * 싣는다.** 그래서 vercel.json에 등록할 수가 없었고, 실제로 등록되어
 * 있지도 않았다.
 *
 * 결과: 화면에는 자동매매 설정이 다 있는데 **한 번도 실행된 적이 없다.**
 * 테스트넷에서도 안 돌았다. 에러도 안 났다 — 아무 일도 안 일어났으니까.
 * 이 저장소에서 하루에 아홉 번째로 나온 같은 모양이고, 그중 제일 크다.
 *
 * 이제 GET이 autotrade_schedules를 읽어 켜져 있는 줄마다 POST를 부른다.
 * 같은 실행 경로를 쓰므로 점검·손절 부착·기록이 전부 그대로 따라온다.
 *
 * 인증 없이 열어 두지 않는다
 * ──────────────────────────
 * 이 주소는 실제 주문을 낸다. Vercel 크론(Bearer CRON_SECRET)이나
 * x-admin-secret이 없으면 거부한다. 미리보기가 필요하면 POST에
 * dryRun: true를 쓴다.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || '';
  const adminSecret = process.env.ADMIN_SECRET || '';
  const auth = req.headers.get('authorization') || '';
  const byCron = !!cronSecret && safeEqual(auth, `Bearer ${cronSecret}`);
  const byAdmin = !!adminSecret && safeEqual(req.headers.get('x-admin-secret'), adminSecret);

  // 로그인한 사용자도 부를 수 있다 — **자기 예약만.**
  //
  // 크론이 하루 1회뿐이라 단타가 안 된다. 앱이 열려 있는 동안 화면이
  // 주기적으로 이 주소를 부르면 그 사이는 자주 볼 수 있다.
  // 남의 예약까지 돌리면 안 되므로 uid로 자른다.
  let uid: string | null = null;
  if (!byCron && !byAdmin) {
    const { resolveUserId } = await import('@/lib/supabase/admin');
    uid = await resolveUserId(auth, req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
    if (!uid) {
      return NextResponse.json({
        ok: false,
        error: '인증 필요 — Vercel Cron(Bearer CRON_SECRET) · x-admin-secret · 로그인 토큰',
        // 무엇이 없어서 막혔는지 적는다. '인증 필요'만 적으면 CRON_SECRET을
        // 안 넣은 것인지 값이 틀린 것인지 알 수 없다.
        cronSecretConfigured: !!cronSecret,
      }, { status: 401 });
    }
  }

  // ADMIN_SECRET이 없으면 진입 엔진(POST)을 부를 수 없다. **크론도 마찬가지다.**
  //
  // 예전에는 이 검사가 `uid &&`로 묶여 있어서 사용자 호출에서만 걸렸다.
  // 크론(Bearer CRON_SECRET)으로 들어오면 그대로 통과해서, 빈 시크릿으로
  // POST를 부르고 줄마다 401을 받았다. 화면에는 "실패"만 남고 왜 실패했는지는
  // 어디에도 없었다 — 여기서 한 번 말하는 것이 열 줄의 401보다 낫다.
  if (!adminSecret) {
    return NextResponse.json({
      ok: false, error: 'admin_secret_missing',
      message: 'ADMIN_SECRET이 없어 진입 엔진을 부를 수 없습니다 — Vercel에 넣고 재배포하세요',
    }, { status: 503 });
  }

  const startedAt = Date.now();
  const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
  }

  let rows: any[] = [];
  let readError: string | null = null;
  try {
    let q = (sb as any).from('autotrade_schedules').select('*').eq('enabled', true);
    // 사용자가 불렀으면 자기 것만
    if (uid) q = q.eq('user_id', uid);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows = Array.isArray(data) ? data : [];
  } catch (e: any) {
    const msg = String(e?.message || e);
    readError = /autotrade_schedules/i.test(msg) && /(does not exist|schema cache|relation)/i.test(msg)
      ? 'autotrade_schedules 표가 아직 없습니다 — 마이그레이션 031을 자동으로 적용하는 중입니다'
      : msg;
  }

  const results: any[] = [];
  if (!readError) {
    const origin = new URL(req.url).origin;
    const { evaluateIfDue } = await import('@/lib/autotrade/evaluationRunner');
    const nowMs = Date.now();

    for (const r of rows) {
      // ── 예약 줄이 고른 전략으로 부른다 ──
      //
      // 예전에는 이 자리에서 **daily-ladder POST를 직접** 불렀다. 그래서
      // 예약에 `strategy_id`를 저장해도 실제로 도는 것은 언제나 계단식
      // 하나였다 — 화면에서 스캘프를 골라도 계단식이 돌았고, 아무 오류도
      // 안 났다. 이 저장소에서 제일 자주 난 사고("만들어 놓고 배선을
      // 안 함")가 정확히 여기 있었다.
      //
      // 간격 검사·전략 판정·기록은 전부 evaluationRunner 한 곳에 있다.
      // 예약을 켠 직후의 첫 평가도 **같은 함수**를 쓴다 — 경로가 둘이면
      // 한쪽만 고쳐진다.
      const { due, record, saveError } = await evaluateIfDue(sb, r as any, {
        origin, adminSecret,
        // **이 경로는 예비다.** 주 실행기는 24시간 도는 Fly Worker이고,
        // 여기는 그것이 죽었을 때를 위한 것이다. 기록에 그렇게 남는다 —
        // 어느 쪽이 깨웠는지 모르면 스케줄러 고장을 진단할 수 없다.
        source: 'GITHUB_FALLBACK',
      }, nowMs);

      if (!record) {
        results.push({
          symbol: r.symbol, mode: r.mode,
          // 건너뛴 것은 실패가 아니다. 간격이 안 됐거나 꺼져 있는 것이다.
          ok: due.code !== 'NO_CONNECTION',
          skipped: due.code !== 'NO_CONNECTION',
          code: due.code, detail: due.reason,
          ...(saveError ? { saveError } : {}),
        });
        continue;
      }

      results.push({
        symbol: r.symbol, mode: r.mode,
        strategyId: record.strategyId,
        // **'평가했다'와 '진입했다'는 다르다.** 대부분의 평가는 진입하지
        // 않고 그건 정상이다. 둘을 같은 '성공'으로 세면 화면에 "성공 1건"이
        // 뜨고, 사람은 포지션이 생긴 줄 안다.
        ok: record.outcome !== 'FAILED',
        outcome: record.outcome,
        executed: record.executed,
        detail: record.summary,
        ...(saveError ? { saveError } : {}),
      });
    }
  }

  // 돌았다는 사실을 남긴다. 이게 없으면 또 "돌고 있는 줄 알았는데"가 된다.
  let cronLogError: string | null = null;
  try {
    const { recordCronRun } = await import('@/lib/system/cronLog');
    const lg = await recordCronRun(sb, 'daily-ladder',
      readError ? 'failed' : rows.length === 0 ? 'skipped' : 'ok',
      // 확인한 줄 수 · 실제 진입 · 실패를 나눠 적는다. '성공 N건'만 적으면
      // 진입하지 않은 날도 매매가 일어난 것처럼 읽힌다.
      readError || `${rows.length}건 확인 · 진입 ${results.filter(x => x.executed).length}건`
        + ` · 실패 ${results.filter(x => !x.ok).length}건`,
      startedAt);
    cronLogError = lg.error;
  } catch (e: any) { cronLogError = String(e?.message || e); }

  return NextResponse.json({
    ok: !readError,
    error: readError,
    // **0건도 결과다.** 켜 놓은 것이 없으면 그렇게 말한다 — 조용히
    // 아무것도 안 하면 지금까지와 똑같아진다.
    scheduled: rows.length,
    note: readError ? readError
      : rows.length === 0
        ? '켜져 있는 자동매매 설정이 없습니다 — autotrade_schedules에 enabled=true 줄이 필요합니다'
        : `${rows.length}건 실행했습니다`,
    results,
    cronLogError,
    liveTradingLocked: !(await import('@/lib/engine/liveTradingGate')).liveTradingGate().allowed,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * 같은 심볼을 들고 있는 **다른** 전략을 찾는다.
 *
 * 장부는 live_orders의 체결 기록에서 만든다. 소유 전략은 signal_id
 * 표식으로 붙어 있다 (lib/strategies/ledger.ts).
 *
 * 조회에 실패하면 빈 배열을 돌려주지 않고 던진다 — "다른 전략이 없다"와
 * "확인 못 했다"는 다르고, 후자를 전자로 처리하면 막으려던 사고가 난다.
 */
async function findForeignHolders(
  sb: any, userId: string, symbol: string, selfStrategy: string,
): Promise<string[]> {
  const { strategyOf } = await import('@/lib/strategies/ledger');
  // **strategy_id는 live_orders에 없는 칸이다.** 그걸 고르는 동안 이 질의는
  // 언제나 실패했고, 위 주석대로 실패는 던지므로 **진입이 매번 여기서
  // 막혔다.** 소유 전략은 원래 signal_id의 [s:...] 표식으로 붙어 있고
  // (tagStrategy), strategyOf가 그 표식을 읽는다 — 칸은 필요 없었다.
  const { data, error } = await sb.from('live_orders')
    .select('side, filled_qty, quantity, signal_id')
    .eq('user_id', userId).eq('symbol', symbol)
    .in('status', ['FILLED', 'RECONCILED'])
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(`전략 장부를 확인하지 못했습니다: ${error.message}`);

  const net = new Map<string, number>();
  for (const r of (Array.isArray(data) ? data : [])) {
    const owner = strategyOf(r);
    // 주인을 모르는 주문은 여기서 판단 근거로 쓰지 않는다. 임의로 남의
    // 것이라고 보면 정상 진입이 영영 막힌다.
    if (!owner || owner === selfStrategy) continue;
    const q = Number(r.filled_qty ?? r.quantity) || 0;
    if (q <= 0) continue;
    const signed = String(r.side).toUpperCase() === 'BUY' ? q : -q;
    net.set(owner, (net.get(owner) ?? 0) + signed);
  }
  return Array.from(net.entries())
    .filter(([, q]) => Math.abs(q) > 1e-12)
    .map(([k]) => k);
}
