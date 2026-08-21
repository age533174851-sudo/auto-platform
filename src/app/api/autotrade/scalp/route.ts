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

  // ── 점검인가 실주문인가 ──
  //
  // **플래그 이름을 여기서 직접 쓰지 않는다.** 예전에는 `body.dryRun`만
  // 읽었는데, 레지스트리가 선언한 이 전략의 점검 플래그는 `checkOnly`다.
  // 화면의 [지금 점검하기]는 `strategyRunRequest()`가 만든 `{checkOnly:true}`를
  // 보내므로 **그 값을 아무도 안 읽었고**, `dryRun`은 undefined라 조건이
  // 맞으면 주문 경로까지 갔다. 사용자는 "주문은 안 냅니다"라고 적힌
  // 버튼을 눌렀다.
  const { checkOnlyOf, checkFlagNote } = await import('@/lib/strategies/checkFlag');
  const check = checkOnlyOf('scalp', body);
  const dryRun = check.checkOnly;
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
    // 왜 주문이 안 나갔는지를 **값으로** 준다 — 문장에서 되짚게 하면
    // 문장이 바뀔 때 화면이 조용히 틀린다.
    checkOnly: check.checkOnly, checkFlag: { via: check.via, declared: check.declared, mismatch: check.mismatch },
    checkNote: checkFlagNote(check),
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
  // ── 킬 스위치 ──
  //
  // **여기 없었다.** liveTradingGate와 킬스위치는 다른 장치다 —
  // 앞엣것은 "이 배포에서 실거래를 허용하는가", 뒤엣것은 "이 계좌를
  // 지금 멈춰라"다. 사용자가 누르는 건 뒤엣것이다.
  {
    const { killSwitchGate } = await import('@/lib/risk/killSwitch');
    const ksg = await killSwitchGate(sb, body.connectionId);
    if (!ksg.allowed) {
      return NextResponse.json({
        ...base, executed: false, blocked: 'KILL_SWITCH', error: ksg.message,
      }, { status: ksg.status, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // ── 닫아 줄 사람이 있는가 ──
  //
  // 청산 감시가 죽어 있으면 트레일링·본전이동·시간청산이 안 돈다.
  // **못 여는 것은 불편이고 못 닫는 것은 사고다.**
  {
    const { exitMonitorGate } = await import('@/lib/engine/exitMonitorGate');
    const em = await exitMonitorGate(sb);
    if (em.blockEntry) {
      return NextResponse.json({
        ...base, executed: false, blocked: 'EXIT_MONITOR_STALE', error: em.reason,
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  // ── DB가 코드를 따라왔는가 ──
  //
  // 코드가 요구하는 칸이 DB에 없으면 쓰기는 조용히 실패하고 매매는
  // 계속된다(054에서 실제로 일어난 일). 적용은 migrate 워크플로가
  // 자동으로 하고, 여기서는 끝났는지만 본다.
  {
    const { migrationGate } = await import('@/lib/system/migrationGate');
    const mg = await migrationGate(sb);
    if (!mg.entryAllowed) {
      return NextResponse.json({
        ...base, executed: false, blocked: 'MIGRATION_PENDING', error: mg.entryReason,
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
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
  // ── 미확정 주문을 **먼저 확정해 본다** ──
  //
  // 아래 체크리스트는 결과를 모르는 주문이 남아 있으면 막는다. 그건 맞는
  // 판정인데, 지금까지 그걸 **푸는 것**은 하루 한 번 도는 크론뿐이었다.
  // 그래서 00시 05분에 응답을 못 받으면 그날 하루 자동매매가 통째로 멎었고,
  // 더 나쁘게는 거래소에 열려 있을지 모르는 포지션을 하루 종일 아무도
  // 확인하지 않았다.
  //
  // 대조가 필요한 순간은 크론이 도는 시각이 아니라 **다음 주문을 내려는
  // 지금**이다. 여기서 한 번 물어보고 들어간다.
  //
  // 실패해도 진입을 막지 않는다 — 못 풀었으면 아래 체크리스트가 원래대로
  // 막는다. 여기서 또 막으면 같은 이유로 두 번 막는 것이고, 사유는 한 곳에
  // 적히는 게 낫다.
  let reconcileTried: { resolved: number; error?: string } | null = null;
  try {
    const { reconcilePendingOrders } = await import('@/lib/engine/orderExecutor');
    const r = await reconcilePendingOrders(sb, {
      exchange: conn.exchange as 'binance' | 'gate',
      apiKey: conn.apiKey,
      apiSecret: conn.apiSecret,
      testnet: !connIsLive,
      // 언제나 좁힌다. 안 좁히면 이 사람의 키로 남의 주문을 물어보고,
      // 없다는 답을 남의 행에 쓴다.
      userId,
      connectionId: body.connectionId,
    });
    reconcileTried = { resolved: r.resolved };
  } catch (e: any) {
    reconcileTried = { resolved: 0, error: e?.message || '대조 실패' };
  }

  const { collectChecklistInput } = await import('@/lib/engine/preflight');
  const { runChecklist } = await import('@/lib/engine/preTradeChecklist');
  const checkInput = await collectChecklistInput({
    sb, userId,
    // **어느 연결을 점검하는지 명시한다.** 안 넘기면 preflight가
    // '활성 연결 아무거나 하나'를 집는다 — 연결이 둘 이상이면 내 Gate로
    // 거래하면서 다른 계좌 상태를 보고 통과/차단하게 된다.
    connectionId: body.connectionId || null,
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
  // ── 시장 국면 ──
  //
  // **이것도 단타에만 없었다.** 일봉 사다리는 collectRegime을 부르고
  // 그 판정을 체크리스트 항목으로 넣는다. 단타는 안 불렀고, 안 부르면
  // `regimeFilter`도 꺼진 채라 항목이 목록에 아예 안 나온다 —
  // "통과했다"가 아니라 **물어본 적이 없다**인데 화면은 구분이 안 됐다.
  //
  // 일봉을 따로 받는다(closes를 안 넘긴다). 단타가 들고 있는 것은
  // 분봉이고, 그걸 일봉 국면 판정에 넣으면 200일선 자리에 200분선이
  // 들어간다 — 위의 거래량 기준선을 안 넘기는 것과 같은 이유다.
  const { collectRegime } = await import('@/lib/risk/regimeCheck');
  const regimeFacts = await collectRegime({
    symbol,
    side: plan.side === 'SHORT' ? 'SHORT' : 'LONG',
  });
  checkInput.regime = {
    status: regimeFacts.verdict.status,
    reason: regimeFacts.verdict.reason,
  };

  const checklist = runChecklist(checkInput, {
    market: 'USDM', intent: 'ENTRY',
    regimeFilter: regimeFacts.enabled,
  });
  if (!checklist.allowed) {
    return NextResponse.json({
      ...base, executed: false, blocked: 'CHECKLIST_BLOCKED',
      error: checklist.summary,
      // **대조를 시도했다는 사실을 적는다.** 미확정 주문 때문에 막혔는데
      // 화면에 아무 말이 없으면, 사용자는 그저 막힌 것으로 읽고 크론이
      // 돌 때까지 기다리는 수밖에 없다고 생각한다.
      reconcile: reconcileTried,
      checklist: {
        allowed: false, passed: checklist.passed, total: checklist.total,
        unknownCount: checklist.unknownCount,
        results: checklist.results, blockers: checklist.blockers,
      },
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 경제일정·변동성·펀딩 거부권 ──
  //
  // **이 라우트에는 이게 하나도 없었다.**
  //
  // 일봉 사다리(daily-ladder)는 runTradingPipeline을 통과하면서 캘린더·
  // 변동성 기준선·펀딩·갭 거부권을 전부 받는다. 그런데 단타는 체크리스트만
  // 돌았다 — 그리고 체크리스트에는 이벤트 항목이 없다.
  //
  // 즉 **CPI나 FOMC 발표 순간에도 단타는 그대로 진입한다.** 분 단위로
  // 도는 쪽이라 오히려 더 자주 맞는다. 발표 직후에는 호가가 벌어지고
  // 손절이 건너뛰어지는데, 그 자리가 정확히 이 전략이 들어가는 자리다.
  //
  // 새 경로를 만들지 않는다 — 웹훅이 쓰는 applyVetoToSignal을 그대로 쓴다.
  // 규칙을 두 벌 두면 한쪽만 고쳐진다.
  try {
    const { applyVetoToSignal } = await import('@/lib/engine/tradingPipeline');
    const veto = await applyVetoToSignal(sb, {
      side: plan.side === 'SHORT' ? 'SHORT' : 'LONG',
      symbol,
      leverage: plan.leverage ?? 1,
      // 변동성 기준선은 일봉이 필요하다. 단타는 분봉만 갖고 있으므로
      // **넘기지 않는다** — 분봉으로 계산한 값을 일봉 기준선 자리에
      // 넣으면 비교 대상이 달라져 언제나 '평소보다 크다'가 된다.
      currentVolume: bars?.volumes?.[bars.volumes.length - 1],
      avgVolume: bars?.volumes?.length
        ? bars.volumes.reduce((a: number, b: number) => a + b, 0) / bars.volumes.length
        : undefined,
    });
    if (!veto.allowed) {
      return NextResponse.json({
        ...base, executed: false, blocked: 'RISK_VETO',
        error: veto.reason,
        veto: veto.veto ?? null,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
  } catch (e: any) {
    // **거부권 조회가 실패하면 진입하지 않는다.**
    //
    // 캘린더를 못 읽었다는 것은 "발표가 없다"가 아니라 "모른다"이다.
    // 여기서 통과시키면 발표 시각에 정확히 들어가고, 그건 이 검사를
    // 만든 이유의 정반대다. riskVeto의 CALENDAR_UNAVAILABLE도 같은 규칙이다.
    return NextResponse.json({
      ...base, executed: false, blocked: 'VETO_UNAVAILABLE',
      error: `거부권 검사를 돌리지 못해 진입하지 않았습니다 (${e?.message || e})`,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 숏은 롱의 부호 반전이 아니다 ──
  //
  // 지금까지 `allowShort`는 켜고 끄는 스위치일 뿐이었고, 진입 검사는
  // 방향을 안 봤다. 그래서 숏이 롱과 **똑같은 검사**를 통과해 나갔다.
  //
  // 숏에만 있는 위험이 있다. 가장 비싼 것은 **청산가가 손절보다 가까운**
  // 경우다 — 숏은 청산가도 손절도 진입가 위에 있어서, 순서가 뒤집히면
  // 손절이 발동하기 전에 청산된다. 사용자는 "손절 1%"라고 믿는 채로
  // 계좌가 통째로 날아간다.
  if (plan.side === 'SHORT') {
    const { shortGuard } = await import('@/lib/engine/shortGuard');

    // ── 펀딩과 상위 시간봉을 실제로 읽는다 ──
    //
    // 이 둘을 안 넘기면 shortGuard의 해당 검사는 **한 번도 돌지 않는다.**
    // 함수는 받을 준비가 돼 있는데 값이 안 들어가는, 이 저장소에서 가장
    // 자주 반복된 모양이다.
    //
    // **못 읽으면 null로 넘긴다.** 0이나 'RANGE'로 채우면 확인한 적 없는
    // 것을 확인했다고 적는 셈이고, 그러면 검사가 도는 것처럼 보이면서
    // 실제로는 아무것도 안 본다.
    let fundingPct: number | null = null;
    let htf: 'UP' | 'DOWN' | 'RANGE' | null = null;
    try {
      const { futuresFundingRate } = await import('@/lib/exchanges/futuresAdapter');
      fundingPct = await futuresFundingRate(barExchange, symbol, barTestnet);
    } catch { /* null — 그 검사를 건너뛴다 */ }
    try {
      // 상위 시간봉은 현재 주기의 4배로 본다. 15분이면 1시간,
      // 1시간이면 4시간. 같은 봉으로 '상위'를 판정하면 뜻이 없다.
      const { klineInterval: ki } = await import('@/lib/strategies/scalpRun');
      const upper = ki(intervalMin * 4);
      if (upper) {
        const ub = await fetchBars(symbol, upper, 120, barExchange, barTestnet);
        if (ub?.closes?.length) {
          const { trendOf } = await import('@/lib/markets/trend');
          htf = trendOf(ub.closes, 50).dir;
        }
      }
    } catch { /* null — 못 읽었다고 숏을 막지는 않는다 */ }

    // 청산가는 계획이 계산한 값을 쓴다. **없으면 그 검사만 건너뛴다** —
    // 못 읽었다고 숏을 통째로 막으면 조회가 흔들릴 때마다 멈춘다.
    const sg = shortGuard({
      entryPrice: Number(scalp.signal.entry),
      stopPrice: scalp.signal.stop ?? null,
      liquidationPrice: plan.liquidationPrice ?? null,
      recentHighs: bars?.highs ?? null,
      recentLows: bars?.lows ?? null,
      atr: (scalp as any)?.atr ?? null,
      fundingRatePct8h: fundingPct,
      higherTrend: htf,
    });
    // 무엇을 읽었고 무엇을 못 읽었는지 응답에 남긴다. 이게 없으면
    // "검사를 통과했다"와 "검사가 안 돌았다"가 화면에서 같아 보인다.
    (base as any).shortInputs = {
      fundingPct, higherTrend: htf,
      liquidationPrice: plan.liquidationPrice ?? null,
    };
    if (!sg.allowed) {
      return NextResponse.json({
        ...base, executed: false, blocked: 'SHORT_GUARD',
        error: sg.summary,
        shortFindings: sg.findings,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    // 막지는 않지만 적어 둘 것들. 응답에 실어 화면이 보여줄 수 있게 한다.
    (base as any).shortFindings = sg.findings;
  }

  // ── 사용자가 손으로 닫았는가 ──
  //
  // 자동매매가 롱을 열었는데 사용자가 거래소 앱에서 손으로 닫았다면,
  // 진입 조건이 아직 참이어도 **다시 열면 안 된다.** 그건 사용자가
  // "이건 아니다"라고 말한 것이고, 곧바로 다시 여는 것은 그 의사를
  // 무시하는 것이다. 그리고 사용자는 또 닫는다 — 그 싸움의 수수료는
  // 사용자가 낸다.
  //
  // 지금까지 있던 방어는 reentryCheck(시간 간격)뿐이라, 간격이 지나면
  // 그대로 반복됐다.
  //
  // 무엇으로 닫혔는지는 **우리가 건 보호 주문이 아직 살아 있는가**로
  // 가른다. 손절로 닫혔다면 그 주문은 체결돼서 없고, 사용자가 닫았다면
  // 아직 남아 있다.
  try {
    const { classifyClose, suppressGate } = await import('@/lib/engine/manualOverride');
    const { data: lastOrd } = await (sb as any).from('live_orders')
      .select('id, sl_order_id, tp_order_id, updated_at, created_at')
      .eq('connection_id', body.connectionId).eq('symbol', symbol)
      .eq('status', 'FILLED')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();

    if (lastOrd && (lastOrd.sl_order_id || lastOrd.tp_order_id)) {
      const { futuresPositionRisk, futuresExchangeOf } = await import('@/lib/exchanges/futuresAdapter');
      const ex = futuresExchangeOf(conn.exchange);
      if (ex) {
        const rr = await futuresPositionRisk(ex, conn.apiKey, conn.apiSecret, symbol, !connIsLive);
        // 미체결 주문. **못 읽으면 null이다** — 빈 배열로 접으면
        // "보호 주문이 사라졌다"가 되어 손절 체결로 오인하고, 그러면
        // 곧바로 다시 연다.
        let openIds: string[] | null = null;
        try {
          if (ex === 'binance') {
            const bf = await import('@/lib/exchanges/binanceFutures');
            const oo = await bf.getFuturesOpenOrders(conn.apiKey, conn.apiSecret, !connIsLive, symbol);
            openIds = oo.success ? (oo.orders || []).map((o: any) => String(o.orderId)) : null;
          } else {
            const gf = await import('@/lib/exchanges/gateFutures');
            const gp = await import('@/lib/exchanges/gatePlan');
            const c = gp.toGateContract(symbol);
            const po = c ? await gf.getPriceOrdersGateFutures(conn.apiKey, conn.apiSecret, c, !connIsLive) : null;
            openIds = po == null ? null : po.map((o: any) => String(o?.id));
          }
        } catch { openIds = null; }

        const cause = classifyClose({
          hasPosition: rr.risk?.positionAmt == null ? null : Math.abs(rr.risk.positionAmt) > 0,
          stopOrderId: lastOrd.sl_order_id, takeProfitOrderId: lastOrd.tp_order_id,
          openOrderIds: openIds,
        });

        if (cause.shouldSuppress) {
          const atMs = Date.parse(String(lastOrd.updated_at || lastOrd.created_at));
          const gate = suppressGate(
            { atMs: Number.isFinite(atMs) ? atMs : Date.now(), cause: cause.cause }, Date.now());
          if (!gate.allowed) {
            return NextResponse.json({
              ...base, executed: false, blocked: 'MANUAL_OVERRIDE',
              error: `${cause.reason} — ${gate.reason}`,
              cause: cause.cause,
            }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
          }
        }
      }
    }
  } catch {
    // **조회 실패가 진입을 막지는 않는다.** 여기는 추가 방어선이고,
    // 앞의 체크리스트가 이미 통과한 상태다. 이 검사 하나가 실패했다고
    // 자동매매를 세우면 조회가 흔들릴 때마다 멈춘다.
  }

  // ── 주문 ──
  //
  // clientOrderId에 봉 시각을 넣는다. 같은 봉에서 두 번 불려도 거래소가
  // 중복으로 거부한다 — 재진입 간격 검사가 실수로 빠져도 마지막 방어선이
  // 하나 남는다.
  const barBucket = Math.floor(Date.now() / (intervalMin * 60_000));

  // ── 같은 봉에서 두 번 들어가지 않는다 (멱등 키) ──
  //
  // **이 경로에는 중복 차단이 없었다.** 웹훅에는 webhook_dedup을 쓰는
  // claimSignal이 있는데 단타에는 없었고, 단타가 이 저장소에서 가장
  // 자주 도는 경로다. 스케줄러가 겹쳐 돌거나 사용자가 두 번 누르면
  // 같은 봉에서 두 번 들어간다.
  //
  // 지금까지 유일한 방어는 clientOrderId였다. 그건 거래소가 막아 주는
  // 것이라 **거래소까지 다녀와야** 알고, Gate는 바이낸스와 중복 판정
  // 규칙이 다르다. 여기서 먼저 끊으면 둘 다 해결된다.
  //
  // 봉 하나에 한 번이므로 이웃 버킷을 보지 않는다 — 다음 봉의 진입은
  // 재발사가 아니라 새 기회다. 만료는 두 봉으로 둬서 늦게 온 재시도까지
  // 덮는다.
  {
    const { claimSignal } = await import('@/lib/risk/idempotency');
    const barSec = Math.max(60, intervalMin * 60);
    const claim = await claimSignal(
      sb,
      { key: `scalp:${body.connectionId}:${symbol}:${interval}:${barBucket}`, neighbors: [], clientScoped: true },
      barSec * 2,
    );
    if (claim.duplicate) {
      return NextResponse.json({
        ...base, executed: false, blocked: 'DUPLICATE_SIGNAL',
        error: `이 봉(${interval})에서는 이미 진입했습니다 — ${claim.reason || '중복 신호'}`,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    // **막았다고 적지 않는다.** 표가 없어서 통과한 것과 중복이 아니어서
    // 통과한 것은 다르다. 응답에 실어 보내 사용자가 지금 이중 진입
    // 방어가 없는 상태라는 것을 알게 한다.
    if (claim.installed === false) (base as any).dedupInstalled = false;
  }

  // ── 주문 직전에 배율을 맞추고 되읽어 확인한다 ──
  //
  // 점검 목록의 배율 항목은 blocking:false라, 거래소가 5배인데 계획이
  // 50배여도 경고만 뜨고 주문이 그대로 나갔다. 필요 증거금이 열 배가
  // 되어 대개 거부되고, 그 거부는 "왜 안 됐는지 모르겠다"로 남는다.
  //
  // **규칙은 leverageSync 한 곳에만 둔다** — 일봉 사다리와 단타가 다른
  // 규칙을 쓰면 언젠가 한쪽만 고쳐진다.
  const { ensureLeverage } = await import('@/lib/engine/leverageSync');
  const levSync = await ensureLeverage(plan.leverage, {
    read: async () => {
      const { futuresPositionRisk, futuresExchangeOf } = await import('@/lib/exchanges/futuresAdapter');
      const ex = futuresExchangeOf(conn.exchange);
      if (!ex) return null;
      const rr = await futuresPositionRisk(ex, conn.apiKey, conn.apiSecret, symbol, !connIsLive);
      // **0을 배율로 읽지 않는다.** Gate에서 0은 교차 증거금이라는 뜻이다.
      const lev = Number(rr?.risk?.leverage);
      return Number.isFinite(lev) && lev > 0 ? lev : null;
    },
    write: async (lev: number) => {
      try {
        const { futuresSetLeverage, futuresExchangeOf } = await import('@/lib/exchanges/futuresAdapter');
        const ex = futuresExchangeOf(conn.exchange);
        if (!ex) return { ok: false, message: `알 수 없는 거래소입니다 (${conn.exchange})` };
        const w = await futuresSetLeverage(ex, conn.apiKey, conn.apiSecret, symbol, lev, !connIsLive);
        return { ok: w.success, message: w.message };
      } catch (e: any) { return { ok: false, message: e?.message || String(e) }; }
    },
  });

  if (!levSync.ok) {
    return NextResponse.json({
      ...base, executed: false, blocked: 'LEVERAGE_MISMATCH',
      error: levSync.reason,
      leverage: {
        intended: levSync.intended, before: levSync.before, after: levSync.after,
        code: levSync.code, exchangeMessage: levSync.exchangeMessage ?? null,
      },
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }

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
