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
  windowVerdict, originalV1Signal, tradingDayKst,
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
      await noteCycle(sb, cycle.id, {
        last_trading_day: wv.tradingDay, last_outcome: 'BLOCKED', last_reason: ksg.message,
      });
      return NextResponse.json({ ...base, ok: false, error: ksg.error, message: ksg.message },
        { status: ksg.status });
    }
  } catch (e: any) {
    return NextResponse.json({ ...base, ok: false, error: 'kill_switch_unknown',
      message: `킬스위치를 확인하지 못해 막았습니다: ${e?.message || e}` }, { status: 503 });
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
      await noteCycle(sb, cycle.id, {
        last_trading_day: wv.tradingDay, last_outcome: 'BLOCKED', last_reason: why,
      });
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
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'BLOCKED', last_reason: status.size.reason,
    });
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

  let bars: any[] = [];
  let barsError: string | null = null;
  try {
    const { fetchVenueBars } = await import('@/lib/markets/venueBars');
    // 09:10~09:30은 5분봉 네 개다. 여유를 두고 받아서 판정 함수가 고른다.
    const r: any = await fetchVenueBars({
      exchange, symbol, interval: '5m', limit: 60, testnet, nowMs,
    });
    bars = Array.isArray(r?.bars) ? r.bars : Array.isArray(r) ? r : [];
    if (bars.length === 0) barsError = r?.error || '봉을 받지 못했습니다';
  } catch (e: any) { barsError = String(e?.message || e); }

  // ── 7. 방향 ──
  //
  // **여기가 비어 있다.** 규칙이 들어오면 `originalV1Signal`만 채운다.
  const sig = barsError
    ? { side: null, code: 'BARS_UNAVAILABLE' as const,
        reason: `봉을 읽지 못했습니다 — ${barsError}`, evidence: {} }
    : originalV1Signal({ bars: bars as any });

  base.signal = { side: sig.side, code: sig.code, reason: sig.reason, evidence: sig.evidence };

  if (sig.code === 'RULE_NOT_CONFIGURED') {
    // **거래일을 소진하지 않는다.** 판단한 것이 아니라 판단할 규칙이
    // 없는 것이다. 규칙이 오늘 안에 들어오면 오늘도 판단할 수 있어야 한다.
    return NextResponse.json({
      ...base, outcome: 'NO_SIGNAL', ruleConfigured: false,
      reason: sig.reason,
      needsInput: [
        '09:10~09:30 구간에서 롱/숏/관망을 나누는 조건 (무슨 봉을 · 무엇과 비교해 · 어떤 임계값으로)',
        '손절 규칙 (진입가 대비 몇 % 또는 그 구간의 저가/고가 등)',
        '익절 규칙 (목표가 · 분할 여부)',
      ],
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (sig.code === 'BARS_UNAVAILABLE') {
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'FAILED', last_reason: sig.reason,
    });
    return NextResponse.json({ ...base, ok: false, outcome: 'FAILED', message: sig.reason },
      { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  if (!sig.side) {
    await noteCycle(sb, cycle.id, {
      last_trading_day: wv.tradingDay, last_outcome: 'NO_TRADE', last_reason: sig.reason,
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
  const why = '진입 방향은 정해졌지만 손절·익절 규칙이 아직 입력되지 않아 주문을 만들지 않습니다 — '
    + '손절 없이 100배로 들어가지 않습니다';
  await noteCycle(sb, cycle.id, {
    last_trading_day: wv.tradingDay, last_outcome: 'BLOCKED', last_reason: why,
  });
  return NextResponse.json({
    ...base, outcome: 'BLOCKED', blocked: 'EXIT_RULE_NOT_CONFIGURED',
    plan: {
      side: sig.side,
      requestedLeverage: REQUESTED_LEVERAGE,
      orderMarginUsd: status.size.marginUsd,
      notionalUsd: status.size.marginUsd == null ? null : status.size.marginUsd * REQUESTED_LEVERAGE,
      dryRun,
    },
    message: why,
  }, { headers: { 'Cache-Control': 'no-store' } });
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
    ruleConfigured: originalV1Signal({ bars: [] }).code !== 'RULE_NOT_CONFIGURED',
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
