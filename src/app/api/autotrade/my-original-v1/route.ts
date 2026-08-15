// /api/autotrade/my-original-v1
//
// **원본 전략 v1 — 독립 실행기.**
//
// 왜 daily-ladder를 부르지 않는가
// ───────────────────────────────
// 이름만 새로 만들고 기존 계단식을 대신 부르면, 화면에는 두 전략이
// 보이는데 실제로 도는 것은 하나다. 그러면 나중에 "내 원본이 계단식보다
// 나은가"를 물었을 때 **같은 것끼리 비교하게 된다.** 이 저장소에서
// 반복해서 난 사고의 다른 얼굴이다.
//
// 그래서 이 라우트는 자기 판단·자기 크기·자기 기록을 갖는다.
// 공유하는 것은 **안전장치뿐**이다 — 킬스위치·점검 목록·모드 관문·
// 주문 실행기. 그것들은 전략마다 다르면 안 된다.
//
// 지금 이 전략은 주문을 내지 않는다
// ─────────────────────────────────
// 사용자의 원본 규칙 중 **둘이 아직 안 들어왔다:**
//
//   1. 09:10~09:30 봉을 보고 롱/숏을 정하는 조건
//   2. 손절·익절 규칙
//
// 둘 다 추측해서 만들면 그건 다른 전략이 사용자 계좌에서 도는 것이다.
// 특히 2번이 없으면 **손절 없이 100배로 들어가게 되는데**, 이 저장소가
// 무엇보다 피해 온 일이다.
//
// 그래서 규칙이 들어올 때까지 이 라우트는 **평가만 하고 진입하지 않는다.**
// 나머지는 전부 실제로 돈다: 시간창 판정 · 하루 1회 · 가상 원장 · 구간별
// 주문 크기 · 킬스위치 · 충돌 검사 · 기록. 오늘 테스트넷에서 확인할 수
// 있는 것도 그 전부다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import { STRATEGY_MY_ORIGINAL_V1 } from '@/lib/strategies/registry';
import { cycleStatusOf, CYCLE_TARGET_USD } from '@/lib/strategies/ladderCycle';
import {
  resolveExitPolicy, exitPricesFor, liquidationGuard, DEFAULT_EXIT_POLICY_ID,
} from '@/lib/strategies/exitPolicy';
import {
  windowVerdict, originalV1Signal, tradingDayKst,
  venueBarsToWindowBars, consumesTradingDay,
  signalRuleConfigured, exitRuleConfigured,
  WINDOW_START_KST, WINDOW_END_KST, LATE_GRACE_MIN,
} from '@/lib/strategies/originalV1';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 이 전략의 기본 시드. 예약에 값이 없을 때 쓴다 */
const DEFAULT_SEED_USD = 1_000;

/** 이 전략이 요청하는 배율. **조용히 낮추지 않는다** */
const REQUESTED_LEVERAGE = 100;

const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

function safeEqual(a: any, b: any): boolean {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (!x || !y || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

export async function POST(req: NextRequest) {
  const adminSecret = process.env.ADMIN_SECRET || '';
  const byAdmin = !!adminSecret && safeEqual(req.headers.get('x-admin-secret'), adminSecret);

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // 실행기(evaluationRunner)가 부를 때는 admin 시크릿 + userId를 싣는다.
  // 사람이 화면에서 부를 때는 로그인 토큰으로 자기 것만 부른다.
  let userId: string | null = byAdmin ? String(body?.userId || '') || null : null;
  if (!userId) {
    userId = await resolveUserId(
      req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  }
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const connectionId = String(body?.connectionId || '');
  const mode = String(body?.mode || 'TESTNET').toUpperCase();
  const dryRun = body?.dryRun === true;
  const nowMs = Date.now();

  if (!symbol) return NextResponse.json({ ok: false, error: 'missing_symbol' }, { status: 400 });
  if (!connectionId) {
    return NextResponse.json({
      ok: false, error: 'missing_connection',
      message: '거래소 연결이 없으면 주문을 낼 수 없습니다',
    }, { status: 400 });
  }

  // ── 실전은 아직 열지 않는다 ──
  //
  // 레지스트리의 `liveReady: false`와 **같은 사실을 여기서도 막는다.**
  // 한 곳에만 두면 그 한 곳을 우회하는 호출이 생긴다.
  if (mode.startsWith('LIVE') || mode === 'SHADOW_LIVE') {
    return NextResponse.json({
      ok: false, error: 'live_not_ready', executed: false,
      message: '원본 v1은 아직 실전에서 돌릴 수 없습니다 — 테스트넷에서 먼저 검증합니다',
    }, { status: 403 });
  }

  const base: Record<string, any> = {
    ok: true, executed: false, strategyId: STRATEGY_MY_ORIGINAL_V1,
    symbol, mode,
    window: {
      startKst: `${String(WINDOW_START_KST.hh).padStart(2, '0')}:${String(WINDOW_START_KST.mm).padStart(2, '0')}`,
      endKst: `${String(WINDOW_END_KST.hh).padStart(2, '0')}:${String(WINDOW_END_KST.mm).padStart(2, '0')}`,
      graceMin: LATE_GRACE_MIN,
    },
  };

  // ── 1. 이 회차의 가상 원장 ──
  //
  // **거래소 잔고를 쓰지 않는다.** 테스트넷 계좌의 가상 자금으로 크기를
  // 정하면 $1,000 → $10,000 → $100,000 규칙을 시험하는 것이 아니다.
  const seedUsd = (() => {
    const n = Number(body?.seedUsd);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SEED_USD;
  })();

  let cycle: any = null;
  try {
    const { data, error } = await (sb as any).from('strategy_cycles')
      .select('*')
      .eq('user_id', userId).eq('strategy_id', STRATEGY_MY_ORIGINAL_V1)
      .eq('symbol', symbol).eq('connection_id', connectionId)
      .eq('mode', mode).eq('state', 'RUNNING').maybeSingle();
    if (error) throw new Error(error.message);
    cycle = data;

    if (!cycle) {
      // 첫 회차를 연다. **읽지 못한 것과 없는 것은 다르므로** 여기까지
      // 온 것은 진짜로 없는 것이다(위에서 error를 던진다).
      const { data: made, error: e2 } = await (sb as any).from('strategy_cycles')
        .insert({
          user_id: userId, strategy_id: STRATEGY_MY_ORIGINAL_V1, strategy_version: '1',
          symbol, connection_id: connectionId, mode,
          cycle_no: 1, first_seed_usd: seedUsd, seed_usd: seedUsd, equity_usd: seedUsd,
          target_usd: CYCLE_TARGET_USD, state: 'RUNNING',
        }).select('*').single();
      if (e2) throw new Error(e2.message);
      cycle = made;
    }
  } catch (e: any) {
    const msg = String(e?.message || e);
    return NextResponse.json({
      ...base, ok: false,
      error: isMissing(msg) ? 'table_missing' : 'cycle_read_failed',
      message: isMissing(msg)
        ? 'strategy_cycles 표가 없습니다 — 마이그레이션 051을 적용하세요. '
          + '이 표가 없으면 가상 원장을 읽을 수 없고, 거래소 잔고로 대신 계산하지 않습니다'
        : `가상 원장을 읽지 못했습니다: ${msg}`,
    }, { status: 503 });
  }

  // ── 2. 오늘 판단할 차례인가 ──
  //
  // **거래소를 부르기 전에 본다.** 창 밖이면 아무것도 조회하지 않는다 —
  // 15분마다 깨어나는 실행기가 하루 종일 거래소를 두드릴 이유가 없다.
  const wv = windowVerdict({ nowMs, lastEvaluatedDay: cycle.last_trading_day });
  base.tradingDay = wv.tradingDay;
  base.windowCode = wv.code;

  if (wv.code === 'MISSED') {
    // **놓친 것을 기록한다.** 조용히 넘기면 "어제 왜 안 들어갔지"의 답이
    // 어디에도 없다. 기록해 두면 오늘은 더 시도하지 않는다.
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'MISSED', last_reason: wv.reason,
    });
    return NextResponse.json({ ...base, reason: wv.reason, outcome: 'MISSED' },
      { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!wv.evaluate) {
    return NextResponse.json({ ...base, reason: wv.reason, skipped: true },
      { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 3. 킬스위치 ──
  //
  // 다른 실행기와 **같은 관문**을 쓴다. 확인하지 못하면 막힌다.
  try {
    const { killSwitchGate } = await import('@/lib/risk/killSwitch');
    const ksg = await killSwitchGate(sb, connectionId);
    if (!ksg.allowed) {
      // **거래일을 소비하지 않는다.** 킬스위치는 판단이 아니라 환경이다 —
      // 사람이 풀면 같은 날 안에 다시 볼 수 있어야 한다.
      await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: ksg.message });
      return NextResponse.json({ ...base, ok: false, error: ksg.error, message: ksg.message },
        { status: ksg.status });
    }
  } catch (e: any) {
    return NextResponse.json({ ...base, ok: false, error: 'kill_switch_unknown',
      message: `킬스위치를 확인하지 못해 막았습니다: ${e?.message || e}` }, { status: 503 });
  }

  // ── 4-a. 같은 종목에 다른 전략이 **켜져 있는가** ──
  //
  // ONE_WAY 계좌는 종목당 포지션이 하나다. daily-ladder BTCUSDT와
  // my-original-v1 BTCUSDT가 둘 다 켜져 있으면, 한쪽의 청산이 다른 쪽
  // 포지션을 닫고 한쪽의 손절이 다른 쪽 진입에 발동한다.
  // 주문에 소유권을 새겨도 **포지션은 가를 수 없다.**
  try {
    const { symbolOwnershipConflict } = await import('@/lib/engine/orderOwnership');
    const { data, error } = await (sb as any).from('autotrade_schedules')
      .select('symbol, connection_id, strategy_id, enabled')
      .eq('user_id', userId);
    // **못 읽은 것을 '겹치는 것 없음'으로 읽지 않는다.**
    const v = symbolOwnershipConflict({
      rows: error ? null : (data ?? []),
      myStrategyId: STRATEGY_MY_ORIGINAL_V1, symbol, connectionId,
    });
    if (!v.ok) {
      await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: v.reason });
      return NextResponse.json({ ...base, ok: false, blocked: v.code, message: v.reason },
        { status: v.code === 'SCHEDULES_UNKNOWN' ? 503 : 409 });
    }
  } catch (e: any) {
    const why = `같은 종목의 다른 예약을 확인하지 못했습니다: ${e?.message || e}`;
    return NextResponse.json({ ...base, ok: false, error: 'conflict_unknown', message: why },
      { status: 503 });
  }

  // ── 4-b. 이 종목에 스모크 테스트가 도는가 ──
  //
  // 스모크 테스트는 사람이 방향을 골라 지금 열어 둔 포지션이다.
  // ONE_WAY 계좌는 종목당 포지션이 하나라, 그 위로 전략이 들어가면
  // 어제 사고(수량 2배 · netting 찌꺼기)가 그대로 재현된다.
  try {
    const { smokeBlocksStrategy } = await import('@/lib/smoke/smokePlan');
    const { data, error } = await (sb as any).from('smoke_tests')
      .select('state, symbol, connection_id')
      .eq('user_id', userId)
      .in('state', ['PREFLIGHT', 'ENTERING', 'HOLDING', 'CLOSING']).limit(20);
    // 표가 없는 배포(052 미적용)는 '스모크가 없다'와 같다 — 기능 자체가 없다.
    const missingTable = !!error && isMissing(error.message);
    const v = smokeBlocksStrategy({
      rows: missingTable ? [] : (error ? null : (data ?? [])),
      symbol, connectionId,
    });
    if (v.blocked) {
      await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: v.reason });
      return NextResponse.json({ ...base, ok: false, blocked: v.code, message: v.reason },
        { status: v.code === 'SMOKE_UNKNOWN' ? 503 : 409 });
    }
  } catch (e: any) {
    const why = `스모크 테스트 진행 여부를 확인하지 못했습니다: ${e?.message || e}`;
    return NextResponse.json({ ...base, ok: false, error: 'smoke_unknown', message: why }, { status: 503 });
  }

  // ── 4. 이 종목을 다른 전략이 들고 있는가 ──
  //
  // 포지션 소유권이 아직 없다. 같은 계좌·같은 종목에 두 전략이 들어가면
  // 한쪽의 청산이 다른 쪽 포지션을 건드린다. **소유권이 생기기 전까지는
  // 겹치면 들어가지 않는다.**
  try {
    const { strategyOf } = await import('@/lib/strategies/ledger');
    const { data, error } = await (sb as any).from('live_orders')
      .select('side, filled_qty, quantity, signal_id')
      .eq('user_id', userId).eq('symbol', symbol)
      .in('status', ['FILLED', 'RECONCILED'])
      .order('created_at', { ascending: true }).limit(500);
    // **조회 실패를 '아무도 안 들고 있다'로 읽지 않는다.**
    if (error) throw new Error(error.message);

    const net = new Map<string, number>();
    for (const r of (Array.isArray(data) ? data : [])) {
      const owner = strategyOf(r);
      if (!owner || owner === STRATEGY_MY_ORIGINAL_V1) continue;
      const q = Number(r.filled_qty ?? r.quantity) || 0;
      if (q <= 0) continue;
      net.set(owner, (net.get(owner) ?? 0) + (String(r.side).toUpperCase() === 'BUY' ? q : -q));
    }
    const holders = Array.from(net.entries()).filter(([, q]) => Math.abs(q) > 1e-12).map(([k]) => k);
    if (holders.length > 0) {
      const why = `${symbol}을(를) 다른 전략(${holders.join(' · ')})이 들고 있습니다 — `
        + '포지션 소유권이 생기기 전까지 같은 종목에 두 전략이 들어가지 않습니다';
      // 다른 전략이 들고 있는 것도 환경이다. 그 포지션이 닫히면 같은
      // 날 안에 다시 볼 수 있어야 한다 — 거래일을 소비하지 않는다.
      await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: why });
      return NextResponse.json({ ...base, ok: false, blocked: 'BLOCK_CONFLICT', message: why },
        { status: 409 });
    }
  } catch (e: any) {
    const why = `다른 전략의 보유 여부를 확인하지 못했습니다: ${e?.message || e}`;
    return NextResponse.json({ ...base, ok: false, error: 'conflict_unknown', message: why },
      { status: 503 });
  }

  // ── 5. 이번 주문 크기 ──
  //
  // 자릿수 구간이 정한다. 잔고 비율이 아니다.
  const status = cycleStatusOf({ seedUsd: cycle.seed_usd, equityUsd: cycle.equity_usd });
  base.cycle = {
    cycleNo: cycle.cycle_no,
    seedUsd: status.seedUsd, equityUsd: status.equityUsd, pnlUsd: status.pnlUsd,
    state: status.state, targetUsd: CYCLE_TARGET_USD, toTargetX: status.toTargetX,
    band: status.size.bandLabel || null,
    orderMarginUsd: status.size.marginUsd,
    entries: cycle.entries,
  };

  if (status.state === 'COMPLETE') {
    // **거래소 잔고를 건드리지 않는다.** 장부상의 사건이다.
    await completeCycle(sb, cycle, status);
    return NextResponse.json({
      ...base, outcome: 'CYCLE_COMPLETE',
      reason: `회차 ${cycle.cycle_no} 완료 — 가상 원장 $${status.equityUsd?.toLocaleString()}. `
        + `다음 회차는 최초 시드 $${Number(cycle.first_seed_usd).toLocaleString()}로 다시 시작합니다`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!status.size.ok) {
    // 크기를 못 정하는 것도 판단이 아니다 — 거래일을 소비하지 않는다.
    await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: status.size.reason });
    return NextResponse.json({ ...base, ok: false, blocked: status.size.code, message: status.size.reason },
      { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 6. 판단 구간의 봉 ──
  const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
  const creds = await loadFuturesCreds(sb, userId, connectionId);
  if (!creds.ok) {
    return NextResponse.json({ ...base, ok: false, error: creds.error, message: (creds as any).message },
      { status: creds.status });
  }
  const exchange = (creds as any).exchange as 'binance' | 'gate';
  const testnet = (creds as any).testnet as boolean;
  base.exchange = exchange;
  base.testnet = testnet;

  // ── 봉을 줄 단위로 바꾼다 ──
  //
  // `fetchVenueBars`는 배열이 아니라 **열 단위 객체**를 준다
  // ({ opens, highs, lows, closes, volumes, openTimes }). 예전에는
  // `Array.isArray(r.bars)`로 검사해서 **정상 수신한 봉이 매번 빈 배열**이
  // 됐고, Gate가 멀쩡히 봉을 주는데도 "봉을 받지 못했습니다"로 실패했다.
  //
  // 변환은 originalV1 한 곳에 있다 — 여기서 모양을 다시 짐작하지 않는다.
  let bars: any[] = [];
  let barsError: string | null = null;
  try {
    const { fetchVenueBars } = await import('@/lib/markets/venueBars');
    // 09:10~09:30은 5분봉 네 개다. 여유를 두고 받아서 판정 함수가 고른다.
    const r = await fetchVenueBars({
      exchange, symbol, interval: '5m', limit: 60, testnet, nowMs,
    });
    if (r?.error || !r?.bars) {
      barsError = r?.error || '봉을 받지 못했습니다';
    } else {
      const conv = venueBarsToWindowBars(r.bars);
      if (!conv.ok) barsError = conv.error;
      else bars = conv.bars;
      base.barsSource = (r as any).source ?? null;
    }
  } catch (e: any) { barsError = String(e?.message || e); }

  // ── 7. 방향 ──
  //
  // **여기가 비어 있다.** 규칙이 들어오면 `originalV1Signal`만 채운다.
  const sig = barsError
    ? { side: null, code: 'BARS_UNAVAILABLE' as const,
        reason: `봉을 읽지 못했습니다 — ${barsError}`, evidence: {} }
    : originalV1Signal({ bars: bars as any, tradingDay: wv.tradingDay });

  base.signal = { side: sig.side, code: sig.code, reason: sig.reason, evidence: sig.evidence };

  if (sig.code === 'WINDOW_BARS_MISSING') {
    // **거래일을 소진하지 않는다.** 판단한 것이 아니라 볼 봉이 아직
    // 없는 것이다 — 창이 막 열렸을 때 이 상태가 될 수 있다.
    // 그래도 사유는 남긴다: 아무 기록이 없으면 "왜 아직 아무것도 없지"의
    // 답이 어디에도 없다.
    await noteCycle(sb, cycle.id, { last_outcome: 'FAILED', last_reason: sig.reason });
    return NextResponse.json({
      ...base, outcome: 'FAILED', retryable: true, reason: sig.reason,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (sig.code === 'BARS_UNAVAILABLE') {
    // ── 조회 실패로 그 거래일을 잃지 않는다 ──
    //
    // 예전에는 여기서 `last_trading_day`를 오늘로 적었다. 그러면 다음
    // tick이 ALREADY_DONE으로 건너뛰어, **같은 창·같은 유예 안인데도
    // 다시 시도할 수 없었다.** 실제로 그래서 하루를 통째로 잃었다.
    //
    // 조회 실패는 판단이 아니다. 사유만 남기고 슬롯은 그대로 둔다.
    await noteCycle(sb, cycle.id, { last_outcome: 'FAILED', last_reason: sig.reason });
    return NextResponse.json({
      ...base, ok: false, outcome: 'FAILED', retryable: true, message: sig.reason,
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!sig.side) {
    // **판정이 끝났다 — 여기서만 오늘의 슬롯을 쓴다.**
    // 어떤 결과가 슬롯을 쓰는지는 consumesTradingDay 한 곳이 정한다.
    await noteCycle(sb, cycle.id, {
      ...(consumesTradingDay(sig.code) ? { last_trading_day: wv.tradingDay } : {}),
      last_outcome: 'NO_TRADE', last_reason: sig.reason,
    });
    return NextResponse.json({ ...base, outcome: 'NO_SIGNAL', reason: sig.reason },
      { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 8. 진입 ──
  //
  // 방향이 나왔다. 그런데 **손절 규칙이 아직 없다.**
  //
  // 여기서 임의의 손절폭(2%·ATR 등)을 넣으면 그건 사용자의 전략이 아니다.
  // 그리고 손절 없이 100배로 들어가는 것은 이 저장소가 무엇보다 피해 온
  // 일이다. 그래서 방향까지만 기록하고 주문은 만들지 않는다.
  //
  // **`exitRuleConfigured()`가 true가 되기 전에는 여기서 멈춘다.**
  // 임의의 손절폭(2%·ATR 등)을 넣으면 그건 사용자의 전략이 아니고,
  // 손절 없이 100배로 들어가는 것은 이 저장소가 가장 피하는 일이다.
  if (!exitRuleConfigured()) {
    const why = `진입 방향은 ${sig.side}로 정해졌지만 손절·익절 규칙이 아직 입력되지 않아 `
      + '주문을 만들지 않습니다 — 손절 없이 100배로 들어가지 않습니다';
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'BLOCKED', last_reason: why,
    });
    return NextResponse.json({
      ...base, outcome: 'BLOCKED', blocked: 'EXIT_RULE_NOT_CONFIGURED', message: why,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 청산 정책 ──
  //
  // **진입 전략과 별개다.** 원본은 청산이 재량이었고, 여기 걸리는
  // 손절·익절은 검증용으로 정한 정책이다. id·버전이 따로 붙어 기록되므로
  // 나중에 청산만 바꿔 가며 비교할 수 있다.
  const ep = resolveExitPolicy(body?.exitPolicyId ?? DEFAULT_EXIT_POLICY_ID);
  if (!ep.ok || !ep.spec) {
    return NextResponse.json({ ...base, ok: false, blocked: 'UNKNOWN_EXIT_POLICY', message: ep.message },
      { status: 400 });
  }
  base.exitPolicy = {
    id: ep.spec.id, version: ep.spec.version, name: ep.spec.name,
    stopPct: ep.spec.stopPct, takeProfitPct: ep.spec.takeProfitPct,
    partial: ep.spec.partial, note: ep.spec.note,
    // **이 값이 원본 전략의 규칙이 아니라는 사실을 응답에도 적는다.**
    isOriginalRule: false,
  };

  // ── 손절이 청산보다 먼저 오는가 ──
  //
  // 100배·유지증거금 0.4%면 청산 거리는 0.6%다. 손절을 그 바깥에 두면
  // 손절이 작동하기 전에 청산된다 — 증거금 전액이 사라진다.
  // **모르면 막는다.**
  const lg = liquidationGuard({ leverage: REQUESTED_LEVERAGE, stopPct: ep.spec.stopPct });
  base.liquidationGuard = lg;
  if (!lg.ok) {
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'BLOCKED', last_reason: lg.reason,
    });
    return NextResponse.json({
      ...base, outcome: 'BLOCKED', blocked: lg.code, message: lg.reason,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 크기 ──
  //
  // 증거금은 자릿수 구간이 정했다. 수량 = 증거금 × 배율 ÷ 진입가.
  // 진입가는 방금 읽은 구간 종가를 기준으로 한다.
  const entryRef = Number(sig.evidence?.windowClose);
  const marginUsd = Number(status.size.marginUsd);
  if (!Number.isFinite(entryRef) || entryRef <= 0 || !Number.isFinite(marginUsd) || marginUsd <= 0) {
    const why = '진입가나 증거금을 확정하지 못했습니다 — 주문을 만들지 않습니다';
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'BLOCKED', last_reason: why,
    });
    return NextResponse.json({ ...base, ok: false, outcome: 'BLOCKED', message: why },
      { headers: { 'Cache-Control': 'no-store' } });
  }
  const notionalUsd = marginUsd * REQUESTED_LEVERAGE;
  const quantity = notionalUsd / entryRef;

  const prices = exitPricesFor({ side: sig.side, entryPrice: entryRef, spec: ep.spec });
  if (!prices.ok || prices.stop == null) {
    return NextResponse.json({ ...base, ok: false, outcome: 'BLOCKED', message: prices.reason },
      { headers: { 'Cache-Control': 'no-store' } });
  }

  base.plan = {
    side: sig.side, requestedLeverage: REQUESTED_LEVERAGE,
    orderMarginUsd: marginUsd, notionalUsd,
    entryRef, quantity,
    stopLoss: prices.stop, takeProfit: prices.takeProfit,
  };

  if (dryRun) {
    return NextResponse.json({ ...base, outcome: 'NO_SIGNAL', dryRun: true,
      reason: '미리보기 — 주문을 보내지 않았습니다' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 9. 어제 것이 아직 열려 있는가 ─────────────────────
  //
  // **이 블록이 없어서 어제 사고가 났다.**
  //
  //   BTCUSDT  기존 SHORT + 같은 방향 SHORT → 수량이 2배가 됐다
  //   ETHUSDT  기존 SHORT + 반대 LONG → 상계되어 0.01 ETH 찌꺼기가 남았다
  //   Gate     이전 날짜 조건부 주문이 안 치워진 채 새것까지 4개가 쌓였다
  //
  // 순서는 하나뿐이다: 포지션 확인 → (필요하면) 전량 청산 → **거래소
  // 재조회로 0 확인** → 옛 보호주문 정리 → 그 다음에만 신규 진입.
  // 어느 단계든 '모른다'면 들어가지 않는다.
  const venue = {
    exchange, apiKey: (creds as any).key, apiSecret: (creds as any).secret, testnet,
  };
  let lifecycle: any = null;
  try {
    const ops = await import('@/lib/engine/venuePositionOps');
    const { entryGate, reversalProgress } = await import('@/lib/engine/positionLifecycle');
    const { orphanCleanupPlan, cleanupOutcome } = await import('@/lib/engine/orderOwnership');
    const { closeVerdict } = await import('@/lib/engine/closeEvidence');

    const before = await ops.readOpenPosition(venue, symbol);
    const gate = entryGate({ read: before, desiredSide: sig.side });
    lifecycle = {
      before: { ok: before.ok, found: before.found, side: before.side, qty: before.qty },
      gate: { ok: gate.ok, code: gate.code, reason: gate.reason },
    };

    if (!gate.ok && !gate.needsReversal) {
      // 같은 방향이거나 조회 실패다. **거래일을 소비하지 않는다** —
      // 그 포지션이 정리되면 같은 창 안에 다시 볼 수 있어야 한다.
      await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: gate.reason });
      return NextResponse.json({
        ...base, ok: false, outcome: 'BLOCKED', blocked: gate.code,
        lifecycle, message: gate.reason,
      }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }

    if (gate.needsReversal) {
      // ── 반전 ──
      //
      // 반대 주문 하나로 뒤집지 않는다. 닫는 것과 여는 것은 다른 주문이고,
      // 그 사이에 **닫혔다는 증거**가 들어가야 한다.
      const closeRes = await ops.closeSymbolPosition(venue, symbol, before.side);
      const after = await ops.readOpenPosition(venue, symbol);
      const cv = closeVerdict({
        before: { ok: before.ok, found: before.found, amount: before.qty ?? null, error: before.error },
        order: { attempted: closeRes.attempted, ok: closeRes.ok, error: closeRes.error },
        after: { ok: after.ok, found: after.found, amount: after.qty ?? null, error: after.error },
      });

      // 포지션이 0으로 확인됐을 때만 고아 정리로 넘어간다.
      const orders = cv.closed ? await ops.readProtectiveOrders(venue, symbol) : null;
      const plan = orphanCleanupPlan({
        position: { ok: after.ok, found: after.found, qty: after.qty },
        orders, myStrategyId: STRATEGY_MY_ORIGINAL_V1,
      });
      // **내 것이라고 확인된 id만** 취소한다. cancelAll은 남의 손절을 지운다.
      const cancelRes = plan.cancel.length
        ? await ops.cancelProtectiveOrders(venue, symbol, plan.cancel)
        : { cancelled: [] as string[], failed: [] as any[] };
      const cleaned = cleanupOutcome({ plan, cancelled: plan.ok ? cancelRes.cancelled : null });

      const rv = reversalProgress({
        closeRequested: closeRes.attempted,
        closeAccepted: closeRes.attempted ? closeRes.ok : null,
        closeVerdict: cv,
        protectionCleaned: cleaned.cleaned,
      });
      lifecycle.reversal = {
        stage: rv.stage, code: rv.code, ok: rv.ok,
        close: { attempted: closeRes.attempted, accepted: closeRes.ok, error: closeRes.error },
        closeVerdict: { closed: cv.closed, code: cv.code, reason: cv.reason },
        cleanup: { code: plan.code, cancelled: cancelRes.cancelled, kept: plan.keep, reason: cleaned.reason },
      };

      if (!rv.ok) {
        // **여기서 멈춘다.** 열려 있을 수 있는 포지션 위로 신규 진입을
        // 내지 않는다 — 그게 어제의 2배 포지션과 찌꺼기다.
        const why = `${gate.reason} · ${rv.reason}`;
        await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: why });
        return NextResponse.json({
          ...base, ok: false, outcome: 'BLOCKED', blocked: rv.code,
          lifecycle, message: why,
        }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
      }
    }
  } catch (e: any) {
    // **예외를 '깨끗하다'로 읽지 않는다.** 확인하지 못한 것은 통과가 아니다.
    const why = `기존 포지션 상태를 확인하지 못했습니다 — ${e?.message || e}. 신규 진입을 내지 않습니다`;
    await noteCycle(sb, cycle.id, { last_outcome: 'BLOCKED', last_reason: why });
    return NextResponse.json({ ...base, ok: false, outcome: 'BLOCKED', blocked: 'LIFECYCLE_UNKNOWN',
      lifecycle, message: why }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
  base.lifecycle = lifecycle;

  // ── 주문 ──
  //
  // **주문 경로는 기존 실행기를 그대로 쓴다.** 배율 적용·포지션 모드 확인·
  // 수량 규격·보호 주문 부착·되돌리기가 전부 거기 있다. 여기서 다시 짜면
  // 수동 주문과 자동 주문이 서로 다른 검사를 받게 된다.
  //
  // `protectionPolicy: 'REQUIRED'` — 손절을 못 걸면 **방금 연 포지션을
  // 즉시 되돌린다.** 아무도 안 보는 시각에 100배 포지션이 보호 없이
  // 남는 것보다 낫다.
  try {
    const { executeOrder } = await import('@/lib/engine/orderExecutor');
    const { tagStrategy } = await import('@/lib/strategies/ledger');
    const { ownedClientOrderId } = await import('@/lib/engine/orderOwnership');

    // ── 같은 행동은 같은 id ──
    //
    // Worker가 재시도하든 GitHub 예비 실행기가 동시에 깨우든 HTTP
    // 타임아웃 뒤 다시 보내든, **같은 (전략 · 거래일 · 종목 · 목적)이면
    // 같은 id**다. 시각을 섞으면 재시도마다 새 주문이 되고 그건 중복이다.
    // 이 id에 소유권이 새겨져 있어서, 나중에 이 주문의 보호주문만 골라
    // 취소할 수 있다 — 남의 손절을 지우지 않는다.
    const clientOrderId = ownedClientOrderId({
      owner: { strategyId: STRATEGY_MY_ORIGINAL_V1, strategyVersion: '1', symbol, connectionId, mode },
      logicalKey: wv.tradingDay ?? '', purpose: 'ENTRY',
    });

    const exec = await executeOrder(sb, {
      userId, connectionId,
      // 장부에 소유 전략을 새긴다 — 다른 전략의 충돌 검사가 이걸 읽는다.
      signalId: tagStrategy(`${STRATEGY_MY_ORIGINAL_V1}:${wv.tradingDay}`, STRATEGY_MY_ORIGINAL_V1),
      clientOrderId,
      exchange, mode: 'TESTNET',
      source: 'AUTOTRADE',
      protectionPolicy: 'REQUIRED',
      stopLoss: prices.stop,
      ...(prices.takeProfit != null ? { takeProfit: prices.takeProfit } : {}),
      // **판단 참고가가 아니라 실제 체결가에서 다시 잰다.**
      // 위 prices는 09:10~09:30 합성 봉 종가로 계산한 값이고, 시장가
      // 100배는 그 가격에 체결되지 않는다. 0.2% 밀리면 −0.4% 손절이
      // −0.2%가 되는데, 청산 거리가 0.6%인 자리에서 그건 손절이 아니다.
      exitPct: {
        stopPct: ep.spec.stopPct,
        takeProfitPct: ep.spec.takeProfitPct ?? null,
        // 이 청산 정책은 손절과 익절이 한 쌍이다 — 익절이 없으면
        // 진입을 완료로 보지 않는다.
        requireTakeProfit: ep.spec.takeProfitPct != null && ep.spec.takeProfitPct > 0,
      },
      apiKey: (creds as any).key,
      apiSecret: (creds as any).secret,
      plan: {
        approved: true,
        symbol, side: sig.side,
        riskAmount: marginUsd, riskAmountWithCosts: marginUsd,
        stopDistancePct: ep.spec.stopPct, effectiveStopPct: ep.spec.stopPct,
        positionSize: notionalUsd, quantity,
        requiredMargin: marginUsd, leverage: REQUESTED_LEVERAGE,
        // 청산가는 실행기가 거래소에서 다시 읽는다. 여기서는 추정 거리만
        // 넘긴다 — 0을 넣으면 손절 방향 재확인이 통째로 꺼진다.
        liquidationPrice: sig.side === 'LONG'
          ? entryRef * (1 - (lg.liquidationDistancePct ?? 0.6) / 100)
          : entryRef * (1 + (lg.liquidationDistancePct ?? 0.6) / 100),
        liquidationDistancePct: lg.liquidationDistancePct ?? 0,
        notes: [
          `자릿수 구간 ${status.size.bandLabel} · 증거금 $${marginUsd}`,
          `청산 정책 ${ep.spec.id} v${ep.spec.version} (원본 규칙 아님)`,
        ],
      } as any,
    } as any);

    // ── 진입했다고 적어도 되는가 ──
    //
    // **`exec.ok === true`는 진입이 아니다.** 접수만 됐어도 true고,
    // 체결이 확정되지 않아도 true고, 포지션이 없어 손절을 안 걸었을
    // 때도 true다. 어제 장부에 ENTERED가 적혀 있었고 거래소는 다른
    // 말을 하고 있었다.
    //
    // 증거를 전부 모아 판정한다: 체결 확정 · 수량 · 방향 · **거래소
    // 재조회** · 배율/포지션 모드 · 손절 되읽기 · (필수면) 익절 되읽기.
    const ops = await import('@/lib/engine/venuePositionOps');
    const { enteredVerdict, outcomeOf } = await import('@/lib/engine/entryEvidence');
    const posAfter = await ops.readOpenPosition(venue, symbol);

    const ev = enteredVerdict({
      expectedSide: sig.side,
      settled: exec?.settled ?? null,
      filledQty: exec?.filledQty ?? null,
      avgPrice: exec?.avgPrice ?? null,
      rejected: exec?.ok === false,
      position: posAfter,
      leverageConfirmed: exec?.leverageConfirmed ?? null,
      positionModeConfirmed: exec?.positionModeConfirmed ?? null,
      stop: exec?.protection?.stop ?? null,
      takeProfit: exec?.protection?.takeProfit ?? null,
      takeProfitRequired: ep.spec.takeProfitPct != null && ep.spec.takeProfitPct > 0,
    });

    const entered = ev.entered;
    const outcome = outcomeOf(ev);
    const why = entered
      ? `${sig.side} 진입 확인 · 증거금 $${marginUsd} · ${REQUESTED_LEVERAGE}배 · `
        + `실제 체결가 ${exec?.exitBasis?.basisPrice ?? exec?.avgPrice} · `
        + `손절 ${exec?.protection?.stop?.triggerPrice ?? '?'}`
        + (exec?.protection?.takeProfit?.found ? ` · 익절 ${exec.protection.takeProfit.triggerPrice}` : '')
      : `${ev.reason}${exec?.message ? ` (실행기: ${exec.message})` : ''}`;

    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay,
      last_outcome: outcome,
      last_reason: why,
      // **확인된 진입만 센다.** UNKNOWN에서 세면 실제보다 많아지고,
      // 그 숫자로 자금관리 구간이 움직인다.
      ...(entered ? { entries: Number(cycle.entries || 0) + 1 } : {}),
    });

    return NextResponse.json({
      ...base,
      executed: entered,
      outcome,
      ok: entered,
      // **재시도해도 되는가.** UNKNOWN이면 false다 — 여기서 재시도를
      // 열면 앞 주문이 붙는 사이에 한 번 더 나가고, 그게 2배 포지션이다.
      retryable: ev.retryable,
      entryEvidence: { code: ev.code, have: ev.have, missing: ev.missing },
      order: {
        status: exec?.status ?? null, clientOrderId,
        exchangeOrderId: exec?.exchangeOrderId ?? null,
        filledQty: exec?.filledQty ?? null, avgPrice: exec?.avgPrice ?? null,
        // **거래소에서 다시 읽어 확인한 것만 적는다.** 생성 응답은 접수다.
        slOrderId: exec?.slOrderId ?? null, tpOrderId: exec?.tpOrderId ?? null,
        protection: exec?.protection ?? null,
        exitBasis: exec?.exitBasis ?? null,
        unprotected: exec?.unprotected ?? null,
        // false면 '아직 모른다'이지 '안 됐다'가 아니다.
        settled: exec?.settled ?? null,
      },
      position: { ok: posAfter.ok, found: posAfter.found, side: posAfter.side, qty: posAfter.qty },
      message: why,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    const why = `주문 경로에서 예외가 났습니다 — ${e?.message || e}`;
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'FAILED', last_reason: why,
    });
    return NextResponse.json({ ...base, ok: false, outcome: 'FAILED', message: why },
      { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** GET은 상태만 본다. 주문을 내지 않으므로 로그인만으로 연다 */
export async function GET(req: NextRequest) {
  const userId = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let cycles: any[] = [];
  let cyclesError: string | null = null;
  try {
    const { data, error } = await (sb as any).from('strategy_cycles')
      .select('*').eq('user_id', userId).eq('strategy_id', STRATEGY_MY_ORIGINAL_V1)
      .order('cycle_no', { ascending: false }).limit(20);
    if (error) throw new Error(error.message);
    cycles = data || [];
  } catch (e: any) {
    const msg = String(e?.message || e);
    cyclesError = isMissing(msg)
      ? 'strategy_cycles 표가 없습니다 — 마이그레이션 051을 적용하세요' : msg;
  }

  const now = Date.now();
  return NextResponse.json({
    ok: !cyclesError,
    strategyId: STRATEGY_MY_ORIGINAL_V1,
    // **규칙이 비어 있다는 사실을 화면이 그대로 적을 수 있어야 한다.**
    // **진입 규칙과 청산 규칙을 따로 말한다.** 하나로 묶으면 화면이
    // '규칙 있음'만 보고 주문이 나갈 거라고 읽는다.
    entryRuleConfigured: signalRuleConfigured(),
    exitRuleConfigured: exitRuleConfigured(),
    entryRule: 'KST 09:10~09:30 합성 봉 · 종가 > 시가 → LONG · 종가 < 시가 → SHORT '
      + '(봉의 세기는 기록만 하고 진입·크기·배율에 쓰지 않습니다)',
    tradingDayKst: tradingDayKst(now),
    window: {
      startKst: '09:10', endKst: '09:30', graceMin: LATE_GRACE_MIN,
      note: '실행기 호출 시각이 아니라 거래일 기준으로 하루 한 번 판단합니다',
    },
    ladder: [
      { band: '$100~$999', marginUsd: 10 },
      { band: '$1,000~$9,999', marginUsd: 100 },
      { band: '$10,000~$99,999', marginUsd: 1000 },
    ],
    targetUsd: CYCLE_TARGET_USD,
    cycles: cycles.map(c => ({
      ...c,
      status: cycleStatusOf({ seedUsd: c.seed_usd, equityUsd: c.equity_usd }),
    })),
    cyclesError,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

/** 회차 줄에 판단 결과를 적는다. **기록 실패가 판단을 되돌리지는 않는다** */
async function noteCycle(sb: any, id: string, patch: Record<string, any>): Promise<void> {
  try {
    await sb.from('strategy_cycles')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  } catch { /* 다음 주기에 다시 적힌다 */ }
}

/**
 * 목표에 닿은 회차를 닫고 다음 회차를 연다.
 *
 * **성과를 덮어쓰지 않는다.** 완료된 회차는 그대로 남고, 새 줄이 최초
 * 시드로 열린다 — 그래야 "같은 시드로 몇 번 만에 갔는가"를 회차끼리
 * 비교할 수 있다.
 */
async function completeCycle(sb: any, cycle: any, status: any): Promise<void> {
  try {
    await sb.from('strategy_cycles').update({
      state: 'COMPLETE',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_outcome: 'CYCLE_COMPLETE',
      last_reason: `목표 $${CYCLE_TARGET_USD.toLocaleString()} 도달 (원장 $${status.equityUsd})`,
    }).eq('id', cycle.id).eq('state', 'RUNNING');

    const seed = Number(cycle.first_seed_usd);
    await sb.from('strategy_cycles').insert({
      user_id: cycle.user_id, strategy_id: cycle.strategy_id,
      strategy_version: cycle.strategy_version,
      symbol: cycle.symbol, connection_id: cycle.connection_id, mode: cycle.mode,
      cycle_no: Number(cycle.cycle_no) + 1,
      first_seed_usd: seed, seed_usd: seed, equity_usd: seed,
      target_usd: CYCLE_TARGET_USD, state: 'RUNNING',
    });
  } catch { /* 다음 평가에서 다시 시도한다 */ }
}
