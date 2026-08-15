// /api/autotrade/smoke-test
//
// **강제 스모크 테스트 — 지금 한 바퀴 돌린다.**
//
// POST : 시작한다 (사전확인 → 진입 → 체결 확인 → 체결가 기준 SL/TP →
//        되읽기 → 마감 시각 저장). 여기서 끝나지 않는다 — 청산은
//        Fly Worker가 `/settle`로 한다. **브라우저를 닫아도 닫힌다.**
// GET  : 내 테스트 목록과 진행 상태
//
// 왜 시장 판단을 안 하는가
// ────────────────────────
// 이건 전략이 아니다. 방향은 사람이 고르고, 확인하려는 것은 **배관**이다:
// 진입이 나가나 · 체결이 읽히나 · 실제 체결가로 손절이 붙나 · 익절이
// 붙나 · 되읽으면 보이나 · 브라우저를 닫아도 청산이 도나 · 끝나고
// 고아 주문이 0인가. 매일 아침 20분 창을 기다리며 확인하던 것들이다.
//
// 새로 짜지 않는다
// ────────────────
// 진입 관문 · 소유권 · 체결가 기준 SL/TP · 되읽기 · 진입 완료 판정은
// 전부 이미 있다. 여기서는 **순서대로 부를 뿐**이다 — 다시 짜면
// 스모크에서는 통과하고 실전에서는 막히는 두 벌이 생긴다.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin, resolveUserId } from '@/lib/supabase/admin';
import {
  smokeRequestVerdict, preflightVerdict, stepsOf, smokeVerdict,
  holdUntilMs, SMOKE_STRATEGY_ID, HOLD_CHOICES, SMOKE_SYMBOLS, DEFAULT_HOLD_MIN,
  STEP_LABEL, STEP_ORDER,
} from '@/lib/smoke/smokePlan';
import { resolveExitPolicy, liquidationGuard, DEFAULT_EXIT_POLICY_ID } from '@/lib/strategies/exitPolicy';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

/** 단계 하나를 기록한다. **없는 단계를 통과로 만들지 않는다** */
function step(state: 'PASS' | 'FAIL' | 'UNKNOWN' | 'RUNNING' | 'SKIPPED', note: string) {
  return { state, note: String(note ?? '').slice(0, 400) };
}

async function saveSmoke(sb: any, id: string, patch: Record<string, any>): Promise<void> {
  try {
    await sb.from('smoke_tests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  } catch { /* 다음 갱신에서 다시 적힌다 */ }
}

export async function POST(req: NextRequest) {
  const userId = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });

  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // ── 1. 요청을 값으로 확정한다 ──
  const rv = smokeRequestVerdict(body);
  if (!rv.ok || !rv.request) {
    return NextResponse.json({ ok: false, error: rv.code.toLowerCase(), message: rv.message }, { status: 400 });
  }
  const { symbol, side, connectionId, marginUsd, leverage, holdMin } = rv.request;

  // ── 2. 이 연결이 정말 내 것이고 테스트넷인가 ──
  const { loadFuturesCreds } = await import('@/lib/exchanges/loadCreds');
  const creds = await loadFuturesCreds(sb, userId, connectionId);
  if (!creds.ok) {
    return NextResponse.json({ ok: false, error: (creds as any).error, message: (creds as any).message },
      { status: (creds as any).status });
  }
  const exchange = (creds as any).exchange as 'binance' | 'gate';
  const testnet = (creds as any).testnet as boolean;
  // **저장소 규칙: is_testnet === false 만 실전이다.** 그 반대를 여기서
  // 다시 쓰지 않는다 — loadFuturesCreds가 정한 값을 그대로 믿는다.
  if (testnet !== true) {
    return NextResponse.json({
      ok: false, error: 'live_connection',
      message: '실전 연결로는 스모크 테스트를 돌리지 않습니다 — 진짜 돈으로 배관을 확인하지 않습니다',
    }, { status: 403 });
  }

  // ── 3. 킬스위치 ──
  //
  // 다른 실행기와 **같은 관문**을 쓴다. 스모크라고 예외를 두면
  // 킬스위치를 켠 계좌에서 주문이 나간다.
  try {
    const { killSwitchGate } = await import('@/lib/risk/killSwitch');
    const ksg = await killSwitchGate(sb, connectionId);
    if (!ksg.allowed) {
      return NextResponse.json({ ok: false, error: ksg.error, message: ksg.message }, { status: ksg.status });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: 'kill_switch_unknown',
      message: `킬스위치를 확인하지 못해 막았습니다: ${e?.message || e}` }, { status: 503 });
  }

  // ── 4. 청산 정책과 청산가 관문 ──
  //
  // 배율은 사람이 고른 값을 **그대로** 쓴다. 다만 손절이 거래소 청산보다
  // 뒤에 있으면 손절이 작동하기 전에 증거금이 사라진다 — 그건 배관
  // 확인이 아니라 손실이다.
  const ep = resolveExitPolicy(body?.exitPolicyId ?? DEFAULT_EXIT_POLICY_ID);
  if (!ep.ok || !ep.spec) {
    return NextResponse.json({ ok: false, error: 'unknown_exit_policy', message: ep.message }, { status: 400 });
  }
  const lg = liquidationGuard({ leverage, stopPct: ep.spec.stopPct });
  if (!lg.ok) {
    return NextResponse.json({ ok: false, error: lg.code, message: lg.reason, liquidationGuard: lg }, { status: 400 });
  }

  // ── 5. 사전 확인 — 남의 것을 덮지 않는다 ──
  const ops = await import('@/lib/engine/venuePositionOps');
  const venue = { exchange, apiKey: (creds as any).key, apiSecret: (creds as any).secret, testnet };

  const posBefore = await ops.readOpenPosition(venue, symbol);
  const ordersBefore = await ops.readProtectiveOrders(venue, symbol);
  const pf = preflightVerdict({
    position: { ok: posBefore.ok, found: posBefore.found, qty: posBefore.qty },
    orders: ordersBefore,
  });

  // ── 6. 줄을 만든다 ──
  //
  // 사전 확인에 실패해도 **줄은 남긴다.** 왜 시작하지 못했는지가
  // 어디에도 없으면 사용자는 버튼만 계속 누른다.
  const startedMs = Date.now();
  let row: any = null;
  try {
    const { data, error } = await (sb as any).from('smoke_tests').insert({
      user_id: userId, connection_id: connectionId,
      symbol, side, mode: 'TESTNET',
      margin_usd: marginUsd, leverage, hold_min: holdMin,
      state: pf.ok ? 'ENTERING' : 'BLOCKED',
      steps: { PREFLIGHT: step(pf.ok ? 'PASS' : 'FAIL', pf.reason) },
      ...(pf.ok ? {} : { verdict: 'BLOCKED', reason: pf.reason, closed_at: new Date().toISOString() }),
    }).select('*').single();
    if (error) throw new Error(error.message);
    row = data;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (isMissing(msg)) {
      return NextResponse.json({
        ok: false, error: 'table_missing',
        message: 'smoke_tests 표가 없습니다 — 마이그레이션 052를 적용하세요',
      }, { status: 503 });
    }
    // 같은 종목에 이미 진행 중인 테스트가 있으면 부분 유니크 인덱스가 막는다.
    if (/duplicate key|unique constraint/i.test(msg)) {
      return NextResponse.json({
        ok: false, error: 'already_running',
        message: `${symbol}에 진행 중인 스모크 테스트가 이미 있습니다 — 끝난 뒤에 다시 시작하세요`,
      }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: 'insert_failed', message: msg }, { status: 500 });
  }

  if (!pf.ok) {
    return NextResponse.json({
      ok: false, blocked: pf.code, smokeTest: view(row), message: pf.reason,
    }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
  }

  // ── 7. 진입 ──
  //
  // **주문 경로는 기존 실행기를 그대로 쓴다.** 배율 적용·포지션 모드
  // 확인·수량 규격·실제 체결가 기준 보호주문·되읽기·되돌리기가 전부
  // 거기 있다. 여기서 다시 짜면 두 벌이 생긴다.
  const steps: Record<string, any> = { PREFLIGHT: step('PASS', pf.reason) };
  try {
    const { executeOrder } = await import('@/lib/engine/orderExecutor');
    const { ownedClientOrderId } = await import('@/lib/engine/orderOwnership');
    const { enteredVerdict } = await import('@/lib/engine/entryEvidence');

    // 소유권을 새긴 멱등 id. 이 줄의 id가 열쇠라 **재시도해도 같은 값**이다.
    const clientOrderId = ownedClientOrderId({
      owner: { strategyId: SMOKE_STRATEGY_ID, symbol, connectionId, mode: 'TESTNET' },
      logicalKey: String(row.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10),
      purpose: 'ENTRY',
    });
    await saveSmoke(sb, row.id, { client_order_id: clientOrderId });

    // 진입 참고가는 거래소 현재가다. 최종 SL/TP는 **실제 체결가**로
    // 다시 계산된다(orderExecutor의 exitPct) — 이 값은 수량 계산용이다.
    const ref = await priceOf(exchange, symbol, testnet);
    if (ref == null || ref <= 0) {
      steps.ENTRY = step('FAIL', '현재가를 읽지 못해 수량을 정할 수 없었습니다');
      return await finish(sb, row, steps, 'FAIL');
    }
    const quantity = (marginUsd * leverage) / ref;

    const exec = await executeOrder(sb, {
      userId, connectionId,
      // **전략 성과에 섞이지 않게** 스모크 전용 태그를 붙인다.
      signalId: `${SMOKE_STRATEGY_ID}:${row.id}`,
      clientOrderId,
      exchange, mode: 'TESTNET',
      source: 'MANUAL',
      // 손절을 못 걸면 방금 연 포지션을 되돌린다. 스모크라고 느슨하게
      // 하지 않는다 — 느슨하게 확인한 배관은 확인한 것이 아니다.
      protectionPolicy: 'REQUIRED',
      stopLoss: side === 'LONG' ? ref * (1 - ep.spec.stopPct / 100) : ref * (1 + ep.spec.stopPct / 100),
      takeProfit: side === 'LONG' ? ref * (1 + (ep.spec.takeProfitPct ?? 0) / 100)
        : ref * (1 - (ep.spec.takeProfitPct ?? 0) / 100),
      exitPct: {
        stopPct: ep.spec.stopPct,
        takeProfitPct: ep.spec.takeProfitPct ?? null,
        requireTakeProfit: ep.spec.takeProfitPct != null && ep.spec.takeProfitPct > 0,
      },
      apiKey: (creds as any).key, apiSecret: (creds as any).secret,
      plan: {
        approved: true, symbol, side,
        riskAmount: marginUsd, riskAmountWithCosts: marginUsd,
        stopDistancePct: ep.spec.stopPct, effectiveStopPct: ep.spec.stopPct,
        positionSize: marginUsd * leverage, quantity,
        requiredMargin: marginUsd, leverage,
        entryPrice: ref,
        liquidationPrice: side === 'LONG'
          ? ref * (1 - (lg.liquidationDistancePct ?? 0.6) / 100)
          : ref * (1 + (lg.liquidationDistancePct ?? 0.6) / 100),
        liquidationDistancePct: lg.liquidationDistancePct ?? 0,
        notes: [`스모크 테스트 ${row.id}`, `청산 정책 ${ep.spec.id} v${ep.spec.version}`],
      } as any,
    } as any);

    steps.ENTRY = exec?.status === 'REJECTED' || exec?.status === 'FAILED'
      ? step('FAIL', `진입 실패: ${exec?.message || exec?.status}`)
      : step('PASS', `주문 접수 · ${exec?.status ?? ''} ${exec?.exchangeOrderId ?? ''}`.trim());

    const posAfter = await ops.readOpenPosition(venue, symbol);
    const ev = enteredVerdict({
      expectedSide: side,
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

    // 체결 · 손절 · 익절을 **따로** 적는다. 하나로 뭉치면 "무엇이 안
    // 됐는지"가 사라지고, 그게 매일 아침 다시 조사하게 만든 것이다.
    const filled = Number(exec?.filledQty) > 0 && exec?.settled === true;
    steps.FILL = filled
      ? step('PASS', `체결 ${exec?.filledQty} @ ${exec?.exitBasis?.basisPrice ?? exec?.avgPrice}`)
      : step(exec?.settled === false ? 'UNKNOWN' : 'FAIL',
        `체결을 확인하지 못했습니다 — 수량 ${exec?.filledQty ?? '?'} · 확정 ${exec?.settled ?? '?'}`);

    const sl = exec?.protection?.stop;
    steps.STOP = sl?.found ? step('PASS', `되읽기 확인 · 트리거 ${sl.triggerPrice}`)
      : step(exec?.protection?.readOk === false ? 'UNKNOWN' : 'FAIL',
        exec?.protection?.reason || '손절을 거래소에서 확인하지 못했습니다');

    const tp = exec?.protection?.takeProfit;
    const tpRequired = ep.spec.takeProfitPct != null && ep.spec.takeProfitPct > 0;
    steps.TAKE_PROFIT = tp?.found ? step('PASS', `되읽기 확인 · 트리거 ${tp.triggerPrice}`)
      : !tpRequired ? step('SKIPPED', '이 정책은 익절을 걸지 않습니다')
        : step(exec?.protection?.readOk === false ? 'UNKNOWN' : 'FAIL',
          '익절을 거래소에서 확인하지 못했습니다');

    if (!ev.entered) {
      // **모르는 상태에서 다시 주문하지 않는다.** 여기서 재시도를 열면
      // 앞 주문이 붙는 사이에 한 번 더 나가고, 그게 어제의 2배 포지션이다.
      const st = ev.code === 'ENTERED_UNPROTECTED' ? 'FAIL' : 'UNKNOWN';
      steps.HOLD = step('SKIPPED', '진입이 확정되지 않아 유지 단계로 가지 않았습니다');
      return await finish(sb, row, steps, st === 'FAIL' ? 'FAIL' : 'UNKNOWN', {
        entry_avg_price: exec?.avgPrice ?? null,
        entry_qty: exec?.filledQty ?? null,
        entry_order_id: exec?.exchangeOrderId ?? null,
        reason: ev.reason,
      });
    }

    // ── 8. 마감 시각을 **DB에** 적는다 ──
    //
    // 여기가 이 기능의 핵심이다. 화면 타이머로 닫으면 탭을 닫는 순간
    // 포지션이 그대로 남는다. 서버에 적어 두면 24시간 도는 워커가 닫는다.
    const until = holdUntilMs(startedMs, holdMin);
    if (until == null) {
      steps.HOLD = step('FAIL', '마감 시각을 만들지 못했습니다');
      return await finish(sb, row, steps, 'FAIL');
    }
    steps.HOLD = step('RUNNING', `${holdMin}분 유지 — ${new Date(until).toISOString()}에 청산합니다`);

    await saveSmoke(sb, row.id, {
      state: 'HOLDING',
      steps,
      hold_until: new Date(until).toISOString(),
      entry_order_id: exec?.exchangeOrderId ?? null,
      entry_avg_price: exec?.exitBasis?.basisPrice ?? exec?.avgPrice ?? null,
      entry_qty: exec?.filledQty ?? null,
      sl_order_id: sl?.orderId ?? null, tp_order_id: tp?.orderId ?? null,
      sl_trigger: sl?.triggerPrice ?? null, tp_trigger: tp?.triggerPrice ?? null,
      reason: `진입 확인 · ${holdMin}분 뒤 자동 청산`,
    });

    const { data: fresh } = await (sb as any).from('smoke_tests').select('*').eq('id', row.id).maybeSingle();
    return NextResponse.json({
      ok: true, smokeTest: view(fresh ?? { ...row, steps, state: 'HOLDING' }),
      message: `진입 확인 — ${holdMin}분 뒤 서버가 전량 청산합니다. **브라우저를 닫아도 됩니다**`,
    }, { headers: { 'Cache-Control': 'no-store' } });

  } catch (e: any) {
    steps.ENTRY = steps.ENTRY ?? step('UNKNOWN', `진입 경로에서 예외: ${e?.message || e}`);
    return await finish(sb, row, steps, 'UNKNOWN', { reason: String(e?.message || e) });
  }
}

/** 진행 상태 */
export async function GET(req: NextRequest) {
  const userId = await resolveUserId(
    req.headers.get('authorization'), req.headers.get('x-user-id'), req.headers.get('x-dev-token'));
  if (!userId) return NextResponse.json({ ok: false, error: 'auth_required' }, { status: 401 });
  const sb = getSupabaseAdmin();
  if (!sb) return NextResponse.json({ ok: false, error: 'supabase_not_configured' }, { status: 503 });

  let rows: any[] = [];
  let tableMissing = false;
  try {
    const { data, error } = await (sb as any).from('smoke_tests')
      .select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
    if (error) throw new Error(error.message);
    rows = data || [];
  } catch (e: any) {
    if (isMissing(e?.message)) tableMissing = true;
    else return NextResponse.json({ ok: false, error: 'query_failed', message: String(e?.message || e) }, { status: 500 });
  }

  return NextResponse.json({
    ok: !tableMissing,
    ...(tableMissing ? {
      error: 'table_missing',
      message: 'smoke_tests 표가 없습니다 — 마이그레이션 052를 적용하세요',
    } : {}),
    tests: rows.map(view),
    // 화면이 고를 것들. **서버가 정한 목록만** 쓴다 — 화면에 또 적으면
    // 한쪽만 바뀌고, 그때 서버가 거부하는 값을 화면이 보여준다.
    options: {
      symbols: SMOKE_SYMBOLS, holdChoices: HOLD_CHOICES, defaultHoldMin: DEFAULT_HOLD_MIN,
      stepOrder: STEP_ORDER, stepLabels: STEP_LABEL,
    },
    note: '이 거래는 SMOKE_TEST로 따로 기록되며 전략 승률·strategy_cycles·원본 전략 손익에 섞이지 않습니다',
  }, { headers: { 'Cache-Control': 'no-store' } });
}

// ── 안쪽 도구 ────────────────────────────────────────

/** 화면이 읽는 모양. **단계는 순수 함수가 만든다** */
function view(r: any) {
  const steps = stepsOf(r?.steps);
  const v = smokeVerdict(steps, r?.state);
  return {
    id: r?.id, symbol: r?.symbol, side: r?.side, mode: r?.mode,
    marginUsd: r?.margin_usd, leverage: r?.leverage, holdMin: r?.hold_min,
    state: r?.state, holdUntil: r?.hold_until,
    entry: {
      orderId: r?.entry_order_id, avgPrice: r?.entry_avg_price, qty: r?.entry_qty,
      slOrderId: r?.sl_order_id, tpOrderId: r?.tp_order_id,
      slTrigger: r?.sl_trigger, tpTrigger: r?.tp_trigger,
    },
    steps, verdict: v, reason: r?.reason ?? null,
    createdAt: r?.created_at, closedAt: r?.closed_at,
  };
}

/** 끝내고 판정을 적는다 */
async function finish(sb: any, row: any, steps: Record<string, any>, code: string, extra: Record<string, any> = {}) {
  const list = stepsOf(steps);
  const v = smokeVerdict(list, code === 'BLOCKED' ? 'BLOCKED' : undefined);
  await saveSmoke(sb, row.id, {
    state: v.code === 'PASS' ? 'PASS' : v.code === 'RUNNING' ? 'FAIL' : v.code,
    steps, verdict: v.code, closed_at: new Date().toISOString(),
    ...extra,
  });
  const { data: fresh } = await (sb as any).from('smoke_tests').select('*').eq('id', row.id).maybeSingle();
  return NextResponse.json({
    ok: v.pass, smokeTest: view(fresh ?? { ...row, steps }), message: extra.reason ?? v.reason,
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

/** 수량 계산용 현재가. **못 읽으면 null** — 0으로 눕히지 않는다 */
async function priceOf(exchange: 'binance' | 'gate', symbol: string, testnet: boolean): Promise<number | null> {
  try {
    if (exchange === 'gate') {
      const gf = await import('@/lib/exchanges/gateFutures');
      const gp = await import('@/lib/exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      const t = await gf.getTickerGateFutures(contract, testnet);
      const n = Number(t?.last ?? t?.mark_price);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const bf = await import('@/lib/exchanges/binanceFutures');
    const n = await bf.getFuturesTicker(symbol, testnet);
    return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
  } catch { return null; }
}
