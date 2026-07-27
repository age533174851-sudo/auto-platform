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
  const mode: 'PAPER' | 'TESTNET' | 'LIVE' = ['PAPER', 'TESTNET', 'LIVE'].includes(String(body.mode).toUpperCase())
    ? String(body.mode).toUpperCase() as any
    : 'TESTNET';

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

  if (mode === 'LIVE' && process.env.ALLOW_LIVE_TRADING !== 'true') {
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
    const premium = await bf.getPremiumIndex(symbol, mode !== 'LIVE');
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
    symbol, mode, dryRun,
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

  // 승인 안 됐거나 미리보기면 여기서 끝. 파이프라인이 예약을 이미 되돌렸다.
  if (!result.approved || dryRun || mode === 'PAPER') {
    return NextResponse.json({ ...base, executed: false }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 주문 ──
  const { releaseReservation, confirmReservation } = await import('@/lib/strategies/ladderGate');
  const reservationId = result.ladder?.reservationId;

  try {
    if (!body.connectionId) throw new Error('connectionId가 없어 주문할 수 없습니다');

    const { data: conn } = await sb.from('exchange_connections')
      .select('exchange, api_key, api_secret_enc, encrypted_secret, has_withdrawal, user_id')
      .eq('id', body.connectionId)
      .eq('user_id', userId)         // 소유권 — 남의 연결로 주문할 수 없다
      .maybeSingle();

    if (!conn) throw new Error('거래소 연결을 찾을 수 없거나 본인의 연결이 아닙니다');
    if (conn.has_withdrawal) throw new Error('출금 권한이 있는 키는 자동매매에 사용할 수 없습니다');

    const { decryptSecret } = await import('@/lib/exchanges/crypto');
    const { executeOrder } = await import('@/lib/engine/orderExecutor');

    const exchange = String(conn.exchange || '').toLowerCase().includes('gate') ? 'gate' : 'binance';
    const tradeDate = result.ladder?.tradeDate || new Date().toISOString().slice(0, 10);
    const clientOrderId = `LD${tradeDate.replace(/-/g, '')}${symbol}`.slice(0, 36);

    // 손절가는 파이프라인이 쓴 것과 같은 기준(마지막 종가 ± 손절거리)으로
    // 되돌려 계산한다. plan에는 거리(%)만 있고 가격이 없다.
    const lastClose = bars.closes[bars.closes.length - 1];
    const stopLoss = result.plan!.side === 'LONG'
      ? lastClose * (1 - result.plan!.stopDistancePct / 100)
      : lastClose * (1 + result.plan!.stopDistancePct / 100);

    const exec = await executeOrder(sb, {
      userId,
      connectionId: body.connectionId,
      signalId: `daily-ladder-${tradeDate}-${symbol}`,
      clientOrderId,
      exchange: exchange as 'binance' | 'gate',
      mode: mode as 'TESTNET' | 'LIVE',
      plan: result.plan!,
      stopLoss,
      apiKey: conn.api_key,
      apiSecret: decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? ''),
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
      order: {
        status: exec.status, clientOrderId: exec.clientOrderId,
        exchangeOrderId: exec.exchangeOrderId,
        filledQty: exec.filledQty, avgPrice: exec.avgPrice,
        slOrderId: exec.slOrderId, message: exec.message,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    await releaseReservation(sb, reservationId);
    return NextResponse.json({
      ...base, executed: false, error: e?.message || '주문 실패',
    }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** GET — 오늘 실행 가능한지 미리보기 (주문·예약 없음) */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
  return NextResponse.json({
    ok: true,
    hint: 'POST로 실행합니다. { symbol, mode: "TESTNET", connectionId, dryRun: true }로 미리보기하세요.',
    symbol,
    liveTradingLocked: process.env.ALLOW_LIVE_TRADING !== 'true',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
