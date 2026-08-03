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

/** Binance 일봉. 변동성 기준선(40일 중앙값)에 충분한 길이를 받는다. */
async function fetchDailyBars(symbol: string, limit = 120): Promise<DailyBars | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=${limit}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const highs: number[] = [], lows: number[] = [], closes: number[] = [], volumes: number[] = [];
    for (const k of data) {
      if (!Array.isArray(k) || k.length < 6) continue;
      const h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]), v = parseFloat(k[5]);
      if ([h, l, c].every(Number.isFinite)) { highs.push(h); lows.push(l); closes.push(c); volumes.push(Number.isFinite(v) ? v : 0); }
    }
    return closes.length ? { highs, lows, closes, volumes } : null;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* 빈 본문 허용 */ }

  const symbol = String(body.symbol || 'BTCUSDT').toUpperCase().replace('/', '');
  const dryRun = body.dryRun === true;
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

  if (capability(opMode).realMoney && process.env.ALLOW_LIVE_TRADING !== 'true') {
    return NextResponse.json(
      { ok: false, error: '실거래가 잠겨 있습니다. ALLOW_LIVE_TRADING=true 설정 후 사용하세요' },
      { status: 403 },
    );
  }

  const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const sb = getSupabaseAdmin();
  if (!sb) {
    return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });
  }

  // ── 시장 데이터 ──
  const bars = await fetchDailyBars(symbol);
  if (!bars) {
    return NextResponse.json({ ok: false, error: `${symbol} 일봉을 가져오지 못했습니다` }, { status: 502 });
  }

  // 파생 지표는 선택 — 없으면 Expansion 점수에서 해당 항목만 빠진다
  let fundingRate: number | undefined;
  let oiChangePct: number | undefined;
  try {
    const bf = await import('@/lib/exchanges/binanceFutures');
    const premium = await bf.getPremiumIndex(symbol, useTestnet);
    if (premium && typeof (premium as any).lastFundingRate === 'string') {
      fundingRate = parseFloat((premium as any).lastFundingRate) * 100;
    }
  } catch { /* 없으면 그대로 진행 */ }

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
    stage: result.stage,
    approved: result.approved,
    reason: result.reason,
    battle: result.battle ? { side: result.battle.side, confidence: result.battle.confidence } : null,
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
  const modeGate = gateOrder(opMode, notionalUsd);

  // 승인 안 됐거나 미리보기면 여기서 끝. 파이프라인이 예약을 이미 되돌렸다.
  if (!result.approved || dryRun) {
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
        exchange: 'binance', mode: opMode,
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
  if (modeGate.needsConfirmation && body.confirm !== true) {
    const { releaseReservation } = await import('@/lib/strategies/ladderGate');
    await releaseReservation(sb, result.ladder?.reservationId);
    return NextResponse.json({
      ...base, mode: opMode, executed: false,
      blocked: 'NEEDS_CONFIRMATION',
      error: `${modeGate.reason} — confirm: true를 함께 보내야 실행됩니다`,
      notionalUsd,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 주문 ──
  const { releaseReservation, confirmReservation } = await import('@/lib/strategies/ladderGate');
  const reservationId = result.ladder?.reservationId;

  try {
    if (!body.connectionId) throw new Error('connectionId가 없어 주문할 수 없습니다');

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
    if (!gate.allowed) {
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

    const exchange = String(conn.exchange_id || '').toLowerCase().includes('gate') ? 'gate' : 'binance';
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
      const bf = await import('@/lib/exchanges/binanceFutures');
      const f = await bf.getSymbolFilters(symbol, useTestnet);
      if (f) { qtyStep = f.stepSize; minQty = f.minQty; }
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
    } else {
      const bfPre = await import('@/lib/exchanges/binanceFutures');
      serverMs = await bfPre.getFuturesServerTime(useTestnet);
      const r = await bfPre.getSymbolPositionRisk(conn.api_key, apiSecretPre, symbol, useTestnet);
      if (r) {
        risk = {
          marginType: r.marginType, leverage: r.leverage,
          liquidationPrice: r.liquidationPrice, positionAmt: r.positionAmt,
        };
      }
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
        exchange: exchange === 'gate' ? 'gate' : 'binance',
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
        exchange: exchange === 'gate' ? 'gate' : 'binance',
        currentEquityUsd: ctx.config.accountEquity ?? null,
      });
      weeklyFact = { status: sf.weekly.status, reason: sf.weekly.reason };
      streakFact = { status: sf.streak.status, reason: sf.streak.reason };
    } catch { /* null → unknown → 막힌다 */ }

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
      clock: serverMs != null ? { localMs, serverMs } : null,
      // 여기까지 왔다는 것은 assertStateConsistent를 통과했다는 뜻이다
      reconcile: { reachable: true, blockNewOrders: false, summary: gate.verdict?.summary || '일치' },
      unresolvedOrderCount: gate.gather.unresolvedOrders.length,
      marginType: risk?.marginType ?? null,
      leverage: risk?.leverage != null
        ? { actual: risk.leverage, intended: result.plan!.leverage }
        : null,
      existingPositionQty: risk ? Math.abs(risk.positionAmt) : null,
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
      // 국면 필터는 켠 경우에만 목록에 들어온다 (REGIME_FILTER 환경변수).
      regimeFilter: regimeFacts.enabled,
    });

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

    const exec = await executeOrder(sb, {
      userId,
      connectionId: body.connectionId,
      // 소유 전략을 주문에 새긴다. 이게 없으면 나중에 이 포지션이
      // 누구 것인지 알 수 없고, 장부가 '주인 미상'으로 쌓인다.
      signalId: tagStrategy(`daily-ladder-${tradeDate}-${symbol}`, 'daily-ladder'),
      clientOrderId,
      exchange: exchange as 'binance' | 'gate',
      mode: mode as 'TESTNET' | 'LIVE',
      plan: result.plan!,
      stopLoss,
      exitPlan,
      apiKey: conn.api_key,
      apiSecret: decryptSecret(conn.api_secret_enc ?? ''),
    });

    if (exec.ok) {
      await confirmReservation(sb, reservationId, {
        leverage: result.plan!.leverage,
        entryPrice: exec.avgPrice,
        liquidationPrice: result.plan!.liquidationPrice,
      });
    } else {
      // 주문이 나가지 않았으면 오늘 하루를 돌려준다
      await releaseReservation(sb, reservationId);
    }

    return NextResponse.json({
      ...base,
      executed: exec.ok,
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

  // 사용자가 부르는 경로는 ADMIN_SECRET이 있어야 진입 엔진(POST)을 부를
  // 수 있다. 없으면 여기서 말한다 — 아래에서 401을 받고 '실패'로만 남으면
  // 원인을 알 수 없다.
  if (uid && !adminSecret) {
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
      ? 'autotrade_schedules 표가 없습니다 — 마이그레이션 031을 적용하세요'
      : msg;
  }

  const results: any[] = [];
  if (!readError) {
    const origin = new URL(req.url).origin;
    for (const r of rows) {
      // 연결이 없으면 부르지 않는다. 진입 엔진이 어차피 거부하지만,
      // 여기서 걸러야 왜 안 됐는지가 이 표에 남는다.
      if (!r.connection_id) {
        results.push({ symbol: r.symbol, ok: false, error: '연결(connectionId)이 지정되지 않았습니다' });
        await noteRun(sb, r.id, '연결 없음');
        continue;
      }

      // ── 너무 자주 부르면 건너뛴다 ──
      //
      // 이 주소를 분 단위로 부를 수 있게 열어 뒀다(앱 타이머·외부 스케줄러).
      // 간격을 안 보면 조건이 맞는 동안 **매 분 진입**한다 — 그건 자동매매가
      // 아니라 사고다.
      //
      // interval_min이 없으면(마이그레이션 035 전) 하루로 본다. 0으로 읽으면
      // 간격이 통째로 사라진다.
      const intervalMin = Number(r.interval_min);
      const gapMs = (Number.isFinite(intervalMin) && intervalMin >= 1 ? intervalMin : 1440) * 60_000;
      const lastMs = r.last_run_at ? new Date(r.last_run_at).getTime() : null;
      if (lastMs != null && Number.isFinite(lastMs) && Date.now() - lastMs < gapMs) {
        const leftMin = Math.ceil((gapMs - (Date.now() - lastMs)) / 60_000);
        results.push({ symbol: r.symbol, ok: true, skipped: true,
          detail: `아직 간격 안 됨 — ${leftMin}분 남음` });
        // **여기서는 last_run_at을 건드리지 않는다.** 건너뛴 것을 실행으로
        // 적으면 간격이 매번 갱신돼서 영원히 안 돈다.
        continue;
      }
      try {
        // **같은 POST 경로를 그대로 부른다.** 여기서 로직을 다시 쓰면
        // 수동 주문과 자동 주문이 서로 다른 검사를 받게 된다.
        const res = await fetch(`${origin}/api/autotrade/daily-ladder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-secret': adminSecret },
          body: JSON.stringify({
            userId: r.user_id, symbol: r.symbol,
            mode: r.mode, connectionId: r.connection_id,
            // 마이그레이션 034 전이면 undefined다. ?? null로 눕혀서 보내면
            // 받는 쪽이 '정하지 않음'으로 읽고 기본값을 쓴다 — 0으로 읽히면
            // 배율 상한 0이 되어 주문이 통째로 막힌다.
            leverageCap: r.leverage_cap ?? null,
            riskPct: r.risk_pct ?? null,
          }),
        });
        const j = await res.json().catch(() => null);
        const ok = res.ok && j?.ok !== false;
        // **'엔진이 답했다'와 '진입했다'는 다르다.**
        //
        // 대부분의 날은 조건이 안 맞아 진입하지 않는다. 그건 정상이고
        // 실패도 아니다. 그런데 둘을 같은 '성공'으로 세면 화면에
        // "성공 1건"이 뜨고, 사람은 포지션이 생긴 줄 안다.
        const executed = j?.executed === true;
        results.push({
          symbol: r.symbol, mode: r.mode, ok, executed,
          detail: j?.message || j?.error || j?.reason || null,
        });
        await noteRun(sb, r.id,
          ok ? (executed ? `진입: ${j?.message || '체결'}`
                         : `진입 안 함: ${j?.reason || j?.message || '조건 불충족'}`)
             : (j?.error || `실패 (${res.status})`));
      } catch (e: any) {
        results.push({ symbol: r.symbol, ok: false, error: String(e?.message || e) });
        await noteRun(sb, r.id, `호출 실패: ${e?.message || e}`);
      }
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
    liveTradingLocked: process.env.ALLOW_LIVE_TRADING !== 'true',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/** 이 설정이 언제 마지막으로 돌았는지 남긴다 */
async function noteRun(sb: any, id: string, result: string): Promise<void> {
  try {
    await (sb as any).from('autotrade_schedules')
      .update({ last_run_at: new Date().toISOString(), last_result: String(result).slice(0, 300) })
      .eq('id', id);
  } catch { /* 기록 실패가 실행을 되돌리지는 않는다 */ }
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
