// src/lib/smoke/startAttempt.ts
//
// **한 회차를 시작한다 — 사람이 눌렀든 워커가 이어 갔든 같은 경로로.**
//
// 왜 함수로 빼는가
// ────────────────
// 1회차는 사람이 버튼을 눌러 시작하고, 2회차부터는 워커가 이어 간다.
// 두 곳에 각자 시작 절차를 두면 **한쪽만 고쳐진다** — 이 저장소에서
// 가장 자주 난 고장이다. 실제로 그 모양으로 난 것이:
//   · 저장에는 strategyId를 실었는데 토글에는 안 실은 것
//   · SL은 거는데 TP는 안 거는 것
//   · 진입 id는 소유권을 새겼는데 SL/TP id는 이어 붙인 것
//
// 그래서 시작은 여기 하나뿐이다.
//
// 여기서 새로 판정하지 않는다
// ───────────────────────────
// 사전 확인 · 진입 관문 · 실제 체결가 기준 SL/TP · 되읽기 · 진입 완료
// 판정은 전부 이미 있다. 이 파일은 **순서대로 부르고 결과를 적을 뿐**이다.

import { preflightVerdict, holdUntilMs, SMOKE_STRATEGY_ID } from './smokePlan';
import { resolveExitPolicy, liquidationGuard, DEFAULT_EXIT_POLICY_ID } from '../strategies/exitPolicy';

export type AttemptSource = 'USER' | 'FLY_WORKER' | 'GITHUB_FALLBACK';

export interface StartAttemptInput {
  userId: string;
  connectionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  marginUsd: number;
  leverage: number;
  holdMin: number;
  /** 반복 묶음. 1회짜리 단독 실행이면 null */
  runId?: string | null;
  attemptNo?: number | null;
  source: AttemptSource;
  exitPolicyId?: string | null;
}

export interface StartAttemptResult {
  ok: boolean;
  code: 'STARTED' | 'BLOCKED' | 'FAILED' | 'UNKNOWN' | 'ERROR' | 'DUPLICATE';
  /** 만들어진 smoke_tests 줄. 만들지도 못했으면 null */
  row: any | null;
  message: string;
  status: number;
}

const step = (state: string, note: string) => ({ state, note: String(note ?? '').slice(0, 400) });
const isMissing = (m: any) => /does not exist|schema cache|relation/i.test(String(m));

async function save(sb: any, id: string, patch: Record<string, any>): Promise<void> {
  try {
    await sb.from('smoke_tests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  } catch { /* 다음 갱신에서 다시 적힌다 */ }
}

/**
 * 한 회차를 끝까지 연다: 사전확인 → 진입 → 체결 → 체결가 기준 SL/TP →
 * 되읽기 → 마감 시각 저장.
 *
 * **청산은 여기서 하지 않는다.** 마감 시각을 DB에 적고 끝낸다 —
 * 브라우저를 닫아도 워커가 닫으라고 만든 기능이다.
 */
export async function startAttempt(sb: any, i: StartAttemptInput): Promise<StartAttemptResult> {
  const startedMs = Date.now();
  const fail = (code: StartAttemptResult['code'], message: string, status = 200, row: any = null)
    : StartAttemptResult => ({ ok: false, code, row, message, status });

  // ── 자격증명 ──
  const { loadFuturesCreds } = await import('../exchanges/loadCreds');
  const creds = await loadFuturesCreds(sb, i.userId, i.connectionId);
  if (!creds.ok) return fail('ERROR', (creds as any).message, (creds as any).status);

  const exchange = (creds as any).exchange as 'binance' | 'gate';
  const testnet = (creds as any).testnet as boolean;
  // **저장소 규칙: is_testnet === false 만 실전이다.**
  if (testnet !== true) {
    return fail('ERROR',
      '실전 연결로는 스모크 테스트를 돌리지 않습니다 — 진짜 돈으로 배관을 확인하지 않습니다', 403);
  }

  // ── 킬스위치 ──
  //
  // 다른 실행기와 **같은 관문**이다. 반복 중이라고 예외를 두면
  // 사람이 킬스위치를 켠 뒤에도 남은 회차가 계속 나간다.
  try {
    const { killSwitchGate } = await import('../risk/killSwitch');
    const ksg = await killSwitchGate(sb, i.connectionId);
    if (!ksg.allowed) return fail('BLOCKED', ksg.message, ksg.status);
  } catch (e: any) {
    return fail('ERROR', `킬스위치를 확인하지 못해 막았습니다: ${e?.message || e}`, 503);
  }

  // ── 청산 정책 · 청산가 관문 ──
  const ep = resolveExitPolicy(i.exitPolicyId ?? DEFAULT_EXIT_POLICY_ID);
  if (!ep.ok || !ep.spec) return fail('ERROR', ep.message, 400);
  const lg = liquidationGuard({ leverage: i.leverage, stopPct: ep.spec.stopPct });
  if (!lg.ok) return fail('BLOCKED', lg.reason, 400);
  const tpRequired = ep.spec.takeProfitPct != null && ep.spec.takeProfitPct > 0;

  // ── 사전 확인 ──
  //
  // **남의 것을 덮지 않는다.** 그리고 반복에서는 이 확인이 곧
  // "직전 회차가 제대로 치워졌는가"의 마지막 관문이다.
  const ops = await import('../engine/venuePositionOps');
  const venue = { exchange, apiKey: (creds as any).key, apiSecret: (creds as any).secret, testnet };

  const apiT0 = Date.now();
  const posBefore = await ops.readOpenPosition(venue, i.symbol);
  const ordersBefore = await ops.readProtectiveOrders(venue, i.symbol);
  let apiMax = Date.now() - apiT0;

  const pf = preflightVerdict({
    position: { ok: posBefore.ok, found: posBefore.found, qty: posBefore.qty },
    orders: ordersBefore,
  });

  // ── 줄을 만든다 ──
  //
  // 사전 확인에 실패해도 **줄은 남긴다.** 왜 시작하지 못했는지가
  // 어디에도 없으면 반복이 조용히 멈춘 것처럼 보인다.
  let row: any = null;
  try {
    const { data, error } = await sb.from('smoke_tests').insert({
      user_id: i.userId, connection_id: i.connectionId,
      symbol: i.symbol, side: i.side, mode: 'TESTNET',
      margin_usd: i.marginUsd, leverage: i.leverage, hold_min: i.holdMin,
      run_id: i.runId ?? null, attempt_no: i.attemptNo ?? null,
      dispatch_source: i.source,
      state: pf.ok ? 'ENTERING' : 'BLOCKED',
      steps: { PREFLIGHT: step(pf.ok ? 'PASS' : 'FAIL', pf.reason) },
      ...(pf.ok ? {} : { verdict: 'BLOCKED', reason: pf.reason, closed_at: new Date().toISOString() }),
    }).select('*').single();
    if (error) throw new Error(error.message);
    row = data;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (isMissing(msg)) {
      return fail('ERROR', 'smoke_tests 표가 없습니다 — 마이그레이션 052·053을 적용하세요', 503);
    }
    if (/duplicate key|unique constraint/i.test(msg)) {
      // 같은 회차를 둘이 동시에 시작하려 했거나, 같은 종목에 이미 돈다.
      return fail('DUPLICATE',
        `${i.symbol}에 진행 중인 스모크 테스트가 이미 있습니다 — 두 개를 동시에 돌리지 않습니다`, 409);
    }
    return fail('ERROR', msg, 500);
  }

  if (!pf.ok) return { ok: false, code: 'BLOCKED', row, message: pf.reason, status: 200 };

  // ── 진입 ──
  const steps: Record<string, any> = { PREFLIGHT: step('PASS', pf.reason) };
  try {
    const { executeOrder } = await import('../engine/orderExecutor');
    const { ownedClientOrderId } = await import('../engine/orderOwnership');
    const { enteredVerdict } = await import('../engine/entryEvidence');

    // **같은 회차는 같은 id.** 재시도가 중복 주문이 되지 않는다.
    // 회차 줄의 id가 열쇠라 회차마다 다르고 재시도에는 같다.
    const clientOrderId = ownedClientOrderId({
      owner: { strategyId: SMOKE_STRATEGY_ID, symbol: i.symbol, connectionId: i.connectionId, mode: 'TESTNET' },
      logicalKey: String(row.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10),
      purpose: 'ENTRY',
    });

    const priceT0 = Date.now();
    const ref = await priceOf(exchange, i.symbol, testnet);
    apiMax = Math.max(apiMax, Date.now() - priceT0);
    if (ref == null || ref <= 0) {
      steps.ENTRY = step('FAIL', '현재가를 읽지 못해 수량을 정할 수 없었습니다');
      await save(sb, row.id, { state: 'FAIL', verdict: 'FAIL', steps,
        reason: '현재가를 읽지 못했습니다', closed_at: new Date().toISOString(),
        client_order_id: clientOrderId, api_latency_ms_max: apiMax });
      return { ok: false, code: 'FAILED', row, message: '현재가를 읽지 못했습니다', status: 200 };
    }
    const quantity = (i.marginUsd * i.leverage) / ref;

    const orderT0 = Date.now();
    const exec = await executeOrder(sb, {
      userId: i.userId, connectionId: i.connectionId,
      // **전략 성과에 섞이지 않게** 스모크 전용 태그를 붙인다.
      signalId: `${SMOKE_STRATEGY_ID}:${row.id}`,
      clientOrderId,
      exchange, mode: 'TESTNET', source: 'MANUAL',
      protectionPolicy: 'REQUIRED',
      stopLoss: i.side === 'LONG' ? ref * (1 - ep.spec.stopPct / 100) : ref * (1 + ep.spec.stopPct / 100),
      takeProfit: i.side === 'LONG' ? ref * (1 + (ep.spec.takeProfitPct ?? 0) / 100)
        : ref * (1 - (ep.spec.takeProfitPct ?? 0) / 100),
      exitPct: {
        stopPct: ep.spec.stopPct,
        takeProfitPct: ep.spec.takeProfitPct ?? null,
        requireTakeProfit: tpRequired,
      },
      apiKey: (creds as any).key, apiSecret: (creds as any).secret,
      plan: {
        approved: true, symbol: i.symbol, side: i.side,
        riskAmount: i.marginUsd, riskAmountWithCosts: i.marginUsd,
        stopDistancePct: ep.spec.stopPct, effectiveStopPct: ep.spec.stopPct,
        positionSize: i.marginUsd * i.leverage, quantity,
        requiredMargin: i.marginUsd, leverage: i.leverage,
        entryPrice: ref,
        liquidationPrice: i.side === 'LONG'
          ? ref * (1 - (lg.liquidationDistancePct ?? 0.6) / 100)
          : ref * (1 + (lg.liquidationDistancePct ?? 0.6) / 100),
        liquidationDistancePct: lg.liquidationDistancePct ?? 0,
        notes: [
          `스모크 테스트 ${row.id}`,
          i.runId ? `반복 ${i.attemptNo}회차` : '단독 실행',
          `청산 정책 ${ep.spec.id} v${ep.spec.version}`,
        ],
      } as any,
    } as any);
    const entryLatencyMs = Date.now() - orderT0;
    apiMax = Math.max(apiMax, entryLatencyMs);

    steps.ENTRY = (exec?.status === 'REJECTED' || exec?.status === 'FAILED')
      ? step('FAIL', `진입 실패: ${exec?.message || exec?.status}`)
      : step('PASS', `주문 접수 · ${exec?.status ?? ''} ${exec?.exchangeOrderId ?? ''}`.trim());

    const posT0 = Date.now();
    const posAfter = await ops.readOpenPosition(venue, i.symbol);
    apiMax = Math.max(apiMax, Date.now() - posT0);

    const ev = enteredVerdict({
      expectedSide: i.side,
      settled: exec?.settled ?? null,
      filledQty: exec?.filledQty ?? null,
      avgPrice: exec?.avgPrice ?? null,
      rejected: exec?.ok === false,
      position: posAfter,
      leverageConfirmed: exec?.leverageConfirmed ?? null,
      positionModeConfirmed: exec?.positionModeConfirmed ?? null,
      stop: exec?.protection?.stop ?? null,
      takeProfit: exec?.protection?.takeProfit ?? null,
      takeProfitRequired: tpRequired,
    });

    const filled = Number(exec?.filledQty) > 0 && exec?.settled === true;
    steps.FILL = filled
      ? step('PASS', `체결 ${exec?.filledQty} @ ${exec?.exitBasis?.basisPrice ?? exec?.avgPrice} (${entryLatencyMs}ms)`)
      : step(exec?.settled === false ? 'UNKNOWN' : 'FAIL',
        `체결을 확인하지 못했습니다 — 수량 ${exec?.filledQty ?? '?'} · 확정 ${exec?.settled ?? '?'}`);

    const sl = exec?.protection?.stop;
    steps.STOP = sl?.found ? step('PASS', `되읽기 확인 · 트리거 ${sl.triggerPrice}`)
      : step(exec?.protection?.readOk === false ? 'UNKNOWN' : 'FAIL',
        exec?.protection?.reason || '손절을 거래소에서 확인하지 못했습니다');

    const tp = exec?.protection?.takeProfit;
    steps.TAKE_PROFIT = tp?.found ? step('PASS', `되읽기 확인 · 트리거 ${tp.triggerPrice}`)
      : !tpRequired ? step('SKIPPED', '이 정책은 익절을 걸지 않습니다')
        : step(exec?.protection?.readOk === false ? 'UNKNOWN' : 'FAIL',
          '익절을 거래소에서 확인하지 못했습니다');

    const common = {
      client_order_id: clientOrderId,
      entry_order_id: exec?.exchangeOrderId ?? null,
      entry_avg_price: exec?.exitBasis?.basisPrice ?? exec?.avgPrice ?? null,
      entry_qty: exec?.filledQty ?? null,
      ref_price: ref,
      sl_order_id: sl?.orderId ?? null, tp_order_id: tp?.orderId ?? null,
      sl_trigger: sl?.triggerPrice ?? null, tp_trigger: tp?.triggerPrice ?? null,
      entry_latency_ms: entryLatencyMs,
      slippage_pct: exec?.exitBasis?.slippagePct ?? null,
      api_latency_ms_max: apiMax,
    };

    if (!ev.entered) {
      // **모르는 상태에서 다시 주문하지 않는다.** 반복에서는 이 판정이
      // 다음 회차를 멈추는 근거가 된다.
      steps.HOLD = step('SKIPPED', '진입이 확정되지 않아 유지 단계로 가지 않았습니다');
      const verdict = ev.code === 'ENTERED_UNPROTECTED' ? 'FAIL' : 'UNKNOWN';
      await save(sb, row.id, {
        ...common, state: verdict, verdict, steps, reason: ev.reason,
        closed_at: new Date().toISOString(),
      });
      return { ok: false, code: verdict === 'FAIL' ? 'FAILED' : 'UNKNOWN', row, message: ev.reason, status: 200 };
    }

    // ── 마감 시각을 DB에 적는다 ──
    const until = holdUntilMs(startedMs, i.holdMin);
    if (until == null) {
      steps.HOLD = step('FAIL', '마감 시각을 만들지 못했습니다');
      await save(sb, row.id, { ...common, state: 'FAIL', verdict: 'FAIL', steps,
        reason: '마감 시각을 만들지 못했습니다', closed_at: new Date().toISOString() });
      return { ok: false, code: 'FAILED', row, message: '마감 시각을 만들지 못했습니다', status: 200 };
    }
    steps.HOLD = step('RUNNING', `${i.holdMin}분 유지 — ${new Date(until).toISOString()}에 청산합니다`);

    await save(sb, row.id, {
      ...common, state: 'HOLDING', steps,
      hold_until: new Date(until).toISOString(),
      reason: `진입 확인 · ${i.holdMin}분 뒤 자동 청산`,
    });

    const { data: fresh } = await sb.from('smoke_tests').select('*').eq('id', row.id).maybeSingle();
    return {
      ok: true, code: 'STARTED', row: fresh ?? row, status: 200,
      message: `진입 확인 — ${i.holdMin}분 뒤 서버가 전량 청산합니다`,
    };
  } catch (e: any) {
    steps.ENTRY = steps.ENTRY ?? step('UNKNOWN', `진입 경로에서 예외: ${e?.message || e}`);
    await save(sb, row.id, {
      state: 'UNKNOWN', verdict: 'UNKNOWN', steps,
      reason: String(e?.message || e), closed_at: new Date().toISOString(),
    });
    return { ok: false, code: 'UNKNOWN', row, message: String(e?.message || e), status: 200 };
  }
}

/** 수량 계산용 현재가. **못 읽으면 null** — 0으로 눕히지 않는다 */
async function priceOf(exchange: 'binance' | 'gate', symbol: string, testnet: boolean): Promise<number | null> {
  try {
    if (exchange === 'gate') {
      const gf = await import('../exchanges/gateFutures');
      const gp = await import('../exchanges/gatePlan');
      const contract = gp.toGateContract(symbol);
      if (!contract) return null;
      const t = await gf.getTickerGateFutures(contract, testnet);
      const n = Number((t as any)?.last ?? (t as any)?.mark_price);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const bf = await import('../exchanges/binanceFutures');
    const n = await bf.getFuturesTicker(symbol, testnet);
    return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
  } catch { return null; }
}
