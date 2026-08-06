// /api/autotrade/scalp — 단타 진입
//
// daily-ladder와 무엇이 다른가
// ────────────────────────────
// daily-ladder는 **일봉**을 보고 하루 한 번 계단식으로 들어간다. 이쪽은
// 사용자가 고른 분봉을 보고 돌파에 들어간다. 판단 재료가 다르므로 파일이
// 다르다.
//
// 무엇이 같은가 — 그리고 왜 같아야 하는가
// ────────────────────────────────────────
// **크기·배율·안전 관문은 전부 riskManager와 executeOrder를 그대로 쓴다.**
// 단타라고 사이징을 따로 짜면 위험 계층이 두 벌이 되고, 그러면 일일 손실
// 한도·청산가 검사·배율 상한이 한쪽에만 있게 된다. 그 상태에서 어느 쪽이
// 실제로 도는지는 아무도 모른다.
//
// 이 라우트가 하는 일은 사실상 하나다: **분봉을 읽어 진입 자리인지 판정하고,
// 맞으면 기존 주문 경로에 넘긴다.**
//
// 가장 위험한 것: 조건이 맞는 동안 매 분 들어가는 것
// ──────────────────────────────────────────────────
// 이 주소는 분 단위로 불릴 수 있다(앱 타이머·외부 스케줄러). 간격을 안 보면
// 돌파가 유지되는 동안 계속 진입한다. 수수료만으로 계좌가 녹는데, 그건
// 버그처럼 보이지 않고 '전략이 나쁜 것'처럼 보인다.
//
// 그래서 마지막 실행 시각을 반드시 보고, **못 읽으면 건너뛴다.**
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

interface Bars { highs: number[]; lows: number[]; closes: number[]; volumes: number[] }

/**
 * 분봉을 가져온다.
 *
 * 실패는 null이다. 빈 배열로 돌려주면 위쪽에서 '봉이 모자랍니다'가 되어,
 * 시세를 못 가져온 것과 시장이 조용한 것이 같은 문구가 된다.
 */
async function fetchBars(
  symbol: string, interval: string, limit: number,
  exchange: 'binance' | 'gate' = 'binance', testnet = true,
): Promise<Bars | null> {
  // **주문이 나갈 시장에서 읽는다.** 예전에는 바이낸스 **현물**로 고정이라,
  // 현물 가격으로 돌파를 판단하고 선물 호가로 체결했다. 돌파 전략에서
  // 그건 특히 나쁘다 — 두 시장의 고점이 다르면 **일어나지 않은 돌파**로
  // 진입한다. 미완성 봉도 여기서 잘린다(돌파가 생겼다 사라지는 원인).
  const { fetchVenueBars } = await import('@/lib/markets/venueBars');
  const r = await fetchVenueBars({ exchange, symbol, interval, limit, testnet });
  if (!r.bars) return null;
  return { highs: r.bars.highs, lows: r.bars.lows, closes: r.bars.closes, volumes: r.bars.volumes };
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* 빈 본문 허용 */ }

  const symbol = String(body.symbol || 'BTCUSDT').toUpperCase().replace('/', '');
  const dryRun = body.dryRun === true;
  const intervalMin = Number(body.intervalMin ?? 60);

  const { fromLegacyMode, gateOrder, capability, toLegacyMode } =
    await import('@/lib/engine/operatingMode');
  const opMode = body.mode ? fromLegacyMode(String(body.mode)) : 'TESTNET';
  const mode = toLegacyMode(opMode);

  // ── 인증 ──
  let userId: string | null = null;
  if (safeEqual(req.headers.get('x-admin-secret'), CRON_SECRET)) {
    userId = body.userId ? String(body.userId) : null;
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'cron 호출에는 userId가 필요합니다' }, { status: 400 });
    }
  } else {
    const { getUserIdFromRequest } = await import('@/lib/supabase/admin');
    userId = await getUserIdFromRequest(req.headers.get('authorization'));
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: '인증 필요 — Bearer 토큰 또는 x-admin-secret 헤더' }, { status: 401 });
    }
  }

  if (capability(opMode).realMoney) {
    const { liveTradingGate } = await import('@/lib/engine/liveTradingGate');
    const lg = liveTradingGate();
    if (!lg.allowed) {
      return NextResponse.json(
        { ok: false, error: lg.reason, env: lg.env, liveUnlocked: lg.unlocked }, { status: 403 });
    }
  }

  const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  // ── 봉 주기 ──
  const { klineInterval, toStandardSignal, barsNeeded, SUPPORTED_INTERVALS } =
    await import('@/lib/strategies/scalpRun');
  const interval = klineInterval(intervalMin);
  if (!interval) {
    return NextResponse.json({
      ok: false, error: 'unsupported_interval',
      message: `${body.intervalMin}분은 거래소가 지원하지 않는 주기입니다`,
      supported: SUPPORTED_INTERVALS,
    }, { status: 400 });
  }

  // ── 이 주기로 이길 수 있는가 ──
  //
  // 봉이 짧을수록 움직임이 작아지고 왕복 수수료는 그대로다. 어느 선
  // 아래로는 **구조적으로** 이길 수 없다 — 전략을 아무리 잘 만들어도.
  // 그걸 알면서 켜는 것은 사용자의 선택이지만, 모르고 켜게 두지는 않는다.
  const { scalpSignal, timeframeVerdict, SCALP_DEFAULTS } =
    await import('@/lib/strategies/scalpSignal');
  const cfg = {
    ...SCALP_DEFAULTS,
    ...(Number.isFinite(Number(body.lookback)) ? { lookback: Number(body.lookback) } : {}),
    ...(Number.isFinite(Number(body.rewardRisk)) ? { rewardRisk: Number(body.rewardRisk) } : {}),
    ...(Number.isFinite(Number(body.roundTripCostPct)) ? { roundTripCostPct: Number(body.roundTripCostPct) } : {}),
  };
  const verdict = timeframeVerdict(intervalMin, cfg.roundTripCostPct);
  if (!verdict.usable && body.force !== true) {
    return NextResponse.json({
      ok: false, error: 'timeframe_unusable',
      message: verdict.text,
      hint: '그래도 돌리려면 force: true를 보내세요. 다만 왕복 비용은 봉이 짧다고 줄지 않습니다.',
      timeframe: { intervalMin, interval, ...verdict },
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 시세 ──
  //
  // **주문이 나갈 시장에서 읽는다.** 연결을 여기서 미리 한 번 본다 —
  // 아래에서 키를 읽을 때 또 조회하지만, 시세를 고르려면 거래소를 지금
  // 알아야 한다. 못 읽으면 바이낸스 선물이 기본이다(현물은 아니다).
  let barExchange: 'binance' | 'gate' = 'binance';
  let barTestnet = true;
  if (body.connectionId) {
    try {
      const { data: bc } = await (sb.from('exchange_connections') as any)
        .select('exchange_id, is_testnet').eq('id', body.connectionId).eq('user_id', userId).maybeSingle();
      if (bc) {
        barExchange = (await import('@/lib/exchanges/futuresAdapter')).futuresExchangeOf(bc.exchange_id) ?? barExchange;
        barTestnet = bc.is_testnet !== false;
      }
    } catch { /* 기본값으로 진행 — 아래 연결 조회가 다시 확인한다 */ }
  }
  const bars = await fetchBars(
    symbol, interval, barsNeeded(cfg.lookback, cfg.atrPeriod), barExchange, barTestnet);
  if (!bars) {
    return NextResponse.json({ ok: false, error: `${symbol} ${interval} 봉을 가져오지 못했습니다` }, { status: 502 });
  }

  // ── 진입 자리인가 ──
  const scalp = scalpSignal(bars, cfg);
  const timeframeInfo = { intervalMin, interval, ...verdict };
  if (!scalp.signal) {
    // **신호 없음은 실패가 아니다.** ok:true로 돌려준다 — 대부분의 봉에서
    // 신호는 나지 않고, 그걸 실패로 적으면 실행 기록이 빨간색으로 가득 찬다.
    return NextResponse.json({
      ok: true, executed: false, symbol, mode: opMode,
      signal: null, reason: scalp.reason, timeframe: timeframeInfo,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const std = toStandardSignal(scalp.signal, symbol, intervalMin, 'scalp');
  if (!std) {
    return NextResponse.json({
      ok: false, error: 'signal_unusable',
      message: '신호를 주문 모양으로 바꾸지 못했습니다 (손절 방향 또는 봉 주기)',
      signal: scalp.signal,
    }, { status: 500 });
  }
  std.timestamp = Date.now();

  // ── 계좌 상태 · 크기 · 배율 ──
  //
  // 여기서 riskManager를 그대로 쓴다. 일일 손실 한도·청산가 검사·배율
  // 상한이 전부 그 안에 있고, 단타만 다른 규칙을 쓰면 그 관문들이
  // 한쪽에만 있게 된다.
  const { buildRiskContext } = await import('@/lib/engine/riskContext');
  const ctx = await buildRiskContext(sb, {
    userId,
    connectionId: body.connectionId || null,
    mode,
    leverageCap: body.leverageCap ?? null,
    riskPct: body.riskPct ?? null,
  });

  const { planPosition } = await import('@/lib/engine/riskManager');
  const plan = planPosition(std, ctx.config, ctx.currentOpenRisk);

  const base = {
    ok: true, symbol, mode: opMode, dryRun,
    timeframe: timeframeInfo,
    signal: {
      side: scalp.signal.side, entry: scalp.signal.entry,
      stop: scalp.signal.stop, target: scalp.signal.target,
      stopPct: scalp.signal.stopPct, targetPct: scalp.signal.targetPct,
      notes: scalp.signal.notes,
    },
    // 계좌를 어디서 읽었는지와 못 읽은 것들. **이게 없으면 폴백 $10,000으로
    // 계산된 결과를 실계좌 결과로 읽게 된다.**
    account: { source: ctx.source, equity: ctx.config.accountEquity, warnings: ctx.warnings },
    plan: plan.approved ? {
      side: plan.side, leverage: plan.leverage, quantity: plan.quantity,
      positionSize: plan.positionSize, requiredMargin: plan.requiredMargin,
      liquidationPrice: plan.liquidationPrice, notes: plan.notes,
    } : null,
    approved: plan.approved,
    rejectCode: plan.rejectCode ?? null,
    reason: plan.approved ? '' : (plan.rejectReason || '위험 관리 단계에서 거부됐습니다'),
  };

  if (!plan.approved || dryRun) {
    return NextResponse.json({ ...base, executed: false }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 모드 관문 ──
  //
  // 다른 검사를 다 통과했어도 여기서 막힐 수 있다. 모드는 가장 바깥
  // 관문이고, SEND가 아니면 **주문을 만들지 않는다.**
  const modeGate = gateOrder(opMode, plan.positionSize ?? 0, { overrideMaxNotionalUsd: (() => { const n = Number(process.env.LIVE_MAX_NOTIONAL_USD); return Number.isFinite(n) && n > 0 ? n : null; })() });
  if (modeGate.disposition !== 'SEND') {
    return NextResponse.json({
      ...base, executed: false, blocked: 'MODE_GATE',
      disposition: modeGate.disposition, error: modeGate.reason,
    }, { status: modeGate.disposition === 'BLOCK' ? 403 : 200,
         headers: { 'Cache-Control': 'no-store' } });
  }
  // 실계좌로 나가는 모드는 사람 확인을 요구한다. 자동 스케줄러가 부를
  // 때는 confirm을 실어 보내야 하고, 그건 사용자가 화면에서 한 번
  // 켜야만 붙는다 — 켜는 순간을 사람이 지나가게 하는 것이 목적이다.
  if (modeGate.needsConfirmation && body.confirm !== true) {
    return NextResponse.json({
      ...base, executed: false, blocked: 'NEEDS_CONFIRMATION',
      error: `${modeGate.reason} — confirm: true를 함께 보내야 실행됩니다`,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 연결 ──
  const { loadConnection } = await import('@/lib/exchanges/connection');
  const { conn, error: connErr } = await loadConnection(sb, body.connectionId, userId);
  if (!conn) {
    return NextResponse.json({
      ...base, executed: false, blocked: 'NO_CONNECTION', error: connErr,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  if (conn.exchange !== 'binance' && conn.exchange !== 'gate') {
    return NextResponse.json({
      ...base, executed: false, blocked: 'NO_CONNECTION',
      error: `${conn.exchange} 연결로는 선물 단타를 낼 수 없습니다`,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 목적지 확인 ──
  //
  // 주문이 어느 망으로 나가는지는 **연결**이 정한다. 모드가 아니다.
  // 어긋나면 실계좌 키로 데모 서버를 두드리거나(-2015), 실전인 줄 알고
  // 켠 것이 테스트넷으로 새어 나간다.
  const connIsLive = conn.isTestnet === false;
  if (connIsLive !== capability(opMode).needsLiveKey) {
    return NextResponse.json({
      ...base, executed: false, blocked: 'MODE_CONN_MISMATCH',
      error: connIsLive
        ? `${opMode} 모드인데 실전 연결입니다 — 실계좌 키로 테스트넷에 주문하게 되어 전부 실패합니다`
        : `${opMode} 모드인데 테스트넷 연결입니다 — 실전으로 나가야 할 주문이 테스트넷으로 갑니다`,
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 거래 전 점검 ──
  //
  // **이 경로에는 점검이 통째로 없었다.** riskManager는 돌지만 그건
  // 크기·배율을 정하는 곳이고, 아래 것들은 아무도 안 보고 있었다:
  //
  //   · 거래소와 앱 상태 일치 (미확정 주문이 남아 있는가)
  //   · 마진 모드 ISOLATED
  //   · 시계 오차
  //   · 거래소 장부 기준 오늘·주간 손실 한도, 연패
  //   · 서브계좌 한도
  //   · 손절이 청산가보다 먼저인가
  //
  // 실주문을 내는 경로가 점검 없이 도는 것은, 안전장치를 만들어 두고
  // 한쪽 문만 잠그지 않은 것과 같다. 수동 주문과 같은 수집기를 쓴다 —
  // 여기서 따로 모으면 언젠가 한쪽만 고치게 된다.
  const { collectChecklistInput } = await import('@/lib/engine/preflight');
  const { runChecklist } = await import('@/lib/engine/preTradeChecklist');
  const checkInput = await collectChecklistInput({
    sb, userId,
    testnet: !connIsLive,
    symbol,
    side: plan.side === 'SHORT' ? 'SHORT' : 'LONG',
    mode: opMode,
    notionalUsd: plan.positionSize ?? 0,
    stopPrice: scalp.signal.stop ?? null,
    intendedLeverage: plan.leverage ?? null,
    requiredMargin: plan.requiredMargin ?? null,
    equityUsd: ctx.config.accountEquity ?? null,
    market: 'USDM',
    overrideMaxNotionalUsd: (() => {
      const n = Number(process.env.LIVE_MAX_NOTIONAL_USD);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
  });
  const checklist = runChecklist(checkInput, { market: 'USDM', intent: 'ENTRY' });
  if (!checklist.allowed) {
    return NextResponse.json({
      ...base, executed: false, blocked: 'CHECKLIST_BLOCKED',
      error: checklist.summary,
      checklist: {
        allowed: false, passed: checklist.passed, total: checklist.total,
        unknownCount: checklist.unknownCount,
        results: checklist.results, blockers: checklist.blockers,
      },
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 주문 ──
  //
  // clientOrderId에 봉 시각을 넣는다. 같은 봉에서 두 번 불려도 거래소가
  // 중복으로 거부한다 — 재진입 간격 검사가 실수로 빠져도 마지막 방어선이
  // 하나 남는다.
  const barBucket = Math.floor(Date.now() / (intervalMin * 60_000));
  const { executeOrder } = await import('@/lib/engine/orderExecutor');
  const exec = await executeOrder(sb, {
    userId,
    connectionId: body.connectionId,
    // 소유 전략을 새긴다. 없으면 나중에 이 포지션이 누구 것인지 알 수 없다.
    signalId: tagStrategy(`scalp-${symbol}-${interval}-${barBucket}`, 'scalp'),
    clientOrderId: `scalp-${symbol}-${interval}-${barBucket}`.slice(0, 36),
    exchange: conn.exchange as 'binance' | 'gate',
    mode: mode as 'TESTNET' | 'LIVE',
    plan,
    // **손절은 반드시 함께 낸다.** 단타에서 손절 없는 진입은 배율이
    // 붙어 있어 청산까지 간다.
    stopLoss: scalp.signal.stop,
    takeProfit: scalp.signal.target,
    apiKey: conn.apiKey,
    apiSecret: conn.apiSecret,
  });

  return NextResponse.json({
    ...base,
    executed: exec.ok,
    // 통과한 점검도 실어 보낸다. 막힐 때만 보여주면 점검이 돌았는지
    // 알 수 없고, 확인 못 한 항목이 있었다는 사실도 사라진다.
    checklist: {
      allowed: true, passed: checklist.passed, total: checklist.total,
      unknownCount: checklist.unknownCount, results: checklist.results,
    },
    order: {
      status: exec.status, clientOrderId: exec.clientOrderId,
      exchangeOrderId: exec.exchangeOrderId,
      filledQty: exec.filledQty, avgPrice: exec.avgPrice,
      slOrderId: exec.slOrderId, message: exec.message,
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * GET — 켜져 있는 단타 예약을 훑는다.
 *
 * daily-ladder의 GET과 같은 모양이다. 다른 것은 **간격 판정을 scalpRun의
 * reentryCheck에 맡긴다**는 점 하나다. 거기서 '못 읽으면 건너뛴다'가
 * 강제된다 — 마지막 실행 시각을 모르는 채로 또 내면 중복 진입이다.
 *
 * 대상은 `autotrade_schedules`에서 mode 접미사가 아니라 **symbol 옆의
 * strategy 칸**이 아니라… 지금은 표에 전략 칸이 없다. 그래서 이 GET은
 * `?symbol=`과 `?intervalMin=`을 받아 **한 줄만** 돌린다. 표를 훑는 것은
 * 전략 칸이 생긴 뒤에 붙인다 — 없는 칸을 미리 읽으면 질의가 통째로 죽는다
 * (이미 그렇게 여덟 곳이 죽어 있었다).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const adminSecret = process.env.ADMIN_SECRET || '';
  const byCron = safeEqual(req.headers.get('x-admin-secret'), adminSecret)
    || safeEqual(url.searchParams.get('secret'), adminSecret);

  let uid: string | null = null;
  if (!byCron) {
    const { getUserIdFromRequest } = await import('@/lib/supabase/admin');
    uid = await getUserIdFromRequest(req.headers.get('authorization'));
    if (!uid) {
      return NextResponse.json({ ok: false, error: '인증 필요' }, { status: 401 });
    }
  }
  if (!adminSecret) {
    return NextResponse.json({
      ok: false, error: 'admin_secret_missing',
      message: 'ADMIN_SECRET이 없어 진입 엔진을 부를 수 없습니다 — Vercel에 넣고 재배포하세요',
    }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    note: '단타는 POST로 실행합니다. 화면이 열려 있는 동안 앱이 간격마다 POST를 보냅니다.',
    // 화면이 고를 수 있는 값을 서버가 알려준다 — 화면에 목록을 또 적으면
    // 두 곳이 어긋난다.
    supported: (await import('@/lib/strategies/scalpRun')).SUPPORTED_INTERVALS,
    adminSecretSet: !!adminSecret,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
