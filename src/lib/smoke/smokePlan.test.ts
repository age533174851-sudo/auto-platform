// src/lib/smoke/smokePlan.test.ts
//
// **스모크 테스트가 조용히 초록이 되는 길을 전부 막는다.**
//
// 이 기능의 목적은 "배관이 뚫려 있는가"를 확인하는 것이다. 그래서
// 가장 나쁜 고장은 진입이 실패하는 것이 아니라 **아무것도 확인하지
// 않고 PASS라고 적는 것**이다. 그러면 다음 날 아침 실전 창에서
// 그대로 터진다.

import { test, eq, assert } from '../../test/harness';
import {
  smokeRequestVerdict, stepsOf, smokeVerdict, holdUntilMs, closeDue,
  smokeBlocksStrategy, preflightVerdict, unprotectedExposureVerdict,
  smokeTestnetVerdict, unresolvedExposureBlock, legacySmokeExposureVerdict,
  legacyExposureClearance, exposureGateAfterVenueCheck,
  STEP_ORDER, HOLD_CHOICES, DEFAULT_HOLD_MIN, MAX_HOLD_MIN, SMOKE_STRATEGY_ID,
  type StepId, type StepState,
} from './smokePlan';
import { confirmedBinanceOpenOrders, combinedSmokeOpenOrderEvidence } from '../engine/venuePositionOps';
import { requireBinanceVenueRows } from '../exchanges/binanceFutures';
import { residualVerdict } from '../engine/orderOwnership';

const OK_BODY = {
  symbol: 'ETHUSDT', side: 'LONG', connectionId: 'conn-1', mode: 'TESTNET',
  marginUsd: 10, leverage: 100, holdMin: 10,
};

/** 모든 단계를 한 상태로 채운다 */
const allSteps = (state: StepState, over: Partial<Record<StepId, StepState>> = {}) => {
  const m: any = {};
  for (const id of STEP_ORDER) m[id] = { state: over[id] ?? state, note: '' };
  return stepsOf(m);
};

export function runSmokePlanTests() {

  test('★ ORDERS_ZERO: regular empty but Algo present cannot pass', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: true, orders: [] },
      { success: true, orders: [{ algoId: '9000000000000000001', symbol: 'ETHUSDT' }] },
    );
    assert(orders !== null);
    const v = residualVerdict({ position: { ok: true, found: false },
      orders, myStrategyId: SMOKE_STRATEGY_ID, ownedIds: [] });
    eq(v.ok, false); eq(v.code, 'UNKNOWN_PRESENT');
  });

  test('★ ORDERS_ZERO: ordinary orders cannot disappear from dual-book evidence', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: true, orders: [{ orderId: '123', symbol: 'ETHUSDT' }] },
      { success: true, orders: [] },
    );
    assert(orders !== null);
    const v = residualVerdict({ position: { ok: true, found: false },
      orders, myStrategyId: SMOKE_STRATEGY_ID, ownedIds: [] });
    eq(v.ok, false); eq(v.code, 'UNKNOWN_PRESENT');
  });

  test('★ ORDERS_ZERO: flat position read failure cannot pass empty books', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: true, orders: [] }, { success: true, orders: [] },
    );
    const v = residualVerdict({ position: { ok: false, found: false },
      orders, myStrategyId: SMOKE_STRATEGY_ID, ownedIds: [] });
    eq(v.ok, false); eq(v.code, 'POSITION_NOT_ZERO');
  });

  test('★ ORDERS_ZERO: Algo GET failure or malformed 200 is UNKNOWN', () => {
    for (const algo of [
      { success: false, orders: [] },
      { success: true, orders: {} },
    ]) {
      const orders = combinedSmokeOpenOrderEvidence(
        { success: true, orders: [] }, algo,
      );
      eq(orders, null);
      const v = residualVerdict({ position: { ok: true, found: false },
        orders, myStrategyId: SMOKE_STRATEGY_ID, ownedIds: [] });
      eq(v.ok, false); eq(v.code, 'ORDERS_UNKNOWN');
    }
  });

  test('★ ORDERS_ZERO: both successful empty books permit clear evidence', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: true, orders: [] }, { success: true, orders: [] },
    );
    assert(Array.isArray(orders));
    const v = residualVerdict({ position: { ok: true, found: false },
      orders, myStrategyId: SMOKE_STRATEGY_ID, ownedIds: [] });
    eq(v.ok, true); eq(v.code, 'CLEAR');
  });

  // ── Regression: failed Binance GET must not become an empty account ──
  test('★ openOrders HTTP failure with orders:[] is UNKNOWN, not zero', () => {
    const orders = confirmedBinanceOpenOrders({ success: false, orders: [] });
    eq(orders, null, 'A failed read must not impersonate zero open orders');
    const verdict = preflightVerdict({
      position: { ok: true, found: false, qty: 0 }, orders,
    });
    eq(verdict.ok, false);
    eq(verdict.code, 'UNKNOWN');
  });

  test('★ successful openOrders with [] alone permits empty-order preflight', () => {
    const orders = confirmedBinanceOpenOrders({ success: true, orders: [] });
    assert(Array.isArray(orders));
    eq(orders!.length, 0);
    const verdict = preflightVerdict({
      position: { ok: true, found: false, qty: 0 }, orders,
    });
    eq(verdict.code, 'CLEAR');
  });

  test('★ successful openOrders reporting live order must remain blocked', () => {
    const orders = confirmedBinanceOpenOrders({
      success: true, orders: [{ orderId: 'order-1', type: 'LIMIT' }],
    });
    const verdict = preflightVerdict({
      position: { ok: true, found: false, qty: 0 }, orders,
    });
    eq(verdict.ok, false);
    eq(verdict.code, 'ORDERS_OPEN');
  });

  test('★ malformed or missing Binance result cannot impersonate a successful empty list', () => {
    for (const x of [
      null, undefined, { orders: [] }, { success: false, orders: [] },
      { success: true, orders: null },
      { success: true, orders: {} },
      { success: 'true', orders: [] },
    ] as any[]) {
      eq(confirmedBinanceOpenOrders(x), null);
    }
  });

  test('★ 200 responses with non-array positionRisk payload fail closed', () => {
    for (const malformed of [null, undefined, {}, { positions: [] }, false, 0, '[]']) {
      let rejected = false;
      try { requireBinanceVenueRows(malformed, 'INVALID_POSITION_RISK_SHAPE'); }
      catch (e: any) { rejected = String(e?.message).includes('INVALID_POSITION_RISK_SHAPE'); }
      assert(rejected, 'Malformed positionRisk was interpreted as an empty position list');
    }
    eq(requireBinanceVenueRows([], 'INVALID_POSITION_RISK_SHAPE').length, 0);
  });

  test('★ 200 responses with non-array openOrders payload fail closed', () => {
    for (const malformed of [null, undefined, {}, { orders: [] }, 0, false]) {
      let rejected = false;
      try { requireBinanceVenueRows(malformed, 'INVALID_OPEN_ORDERS_SHAPE'); }
      catch (e: any) { rejected = String(e?.message).includes('INVALID_OPEN_ORDERS_SHAPE'); }
      assert(rejected, 'Malformed openOrders was interpreted as no open orders');
    }
    eq(requireBinanceVenueRows([{ orderId: '1' }], 'INVALID_OPEN_ORDERS_SHAPE').length, 1);
  });

  test('★ Binance regular [] but Algo TP/SL order is NOT empty preflight', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: true, orders: [] },
      { success: true, orders: [{ algoId: 'algo-12', symbol: 'BTCUSDT', orderType: 'STOP_MARKET' }] },
    );
    assert(Array.isArray(orders));
    eq(orders!.length, 1);
    eq(orders![0].kind, 'ALGO');
    const verdict = preflightVerdict({ position: { ok: true, found: false, qty: 0 }, orders });
    eq(verdict.code, 'ORDERS_OPEN');
  });

  test('★ Binance Algo API failure + regular zero = UNKNOWN, never CLEAR', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: true, orders: [] },
      { success: false, orders: [] },
    );
    eq(orders, null);
    eq(preflightVerdict({ position: { ok: true, found: false, qty: 0 }, orders }).code,
      'UNKNOWN');
  });

  test('★ Binance ordinary API failure + Algo zero = UNKNOWN, never CLEAR', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: false, orders: [] }, { success: true, orders: [] },
    );
    eq(orders, null);
  });

  test('★ Binance two successful empty books = preflight CLEAR (not order authorization)', () => {
    const orders = combinedSmokeOpenOrderEvidence(
      { success: true, orders: [] }, { success: true, orders: [] },
    );
    eq(orders?.length, 0);
    eq(preflightVerdict({ position: { ok: true, found: false, qty: 0 }, orders }).code,
      'CLEAR');
  });

  test('★ malformed Algo readback and missing success cannot invent zero protection', () => {
    for (const x of [null, { success: true, orders: null },
      { success: true, orders: {} }, { orders: [] }] as any[]) {
      const orders = combinedSmokeOpenOrderEvidence({ success: true, orders: [] }, x);
      eq(orders, null);
    }
    let rejected = false;
    try { requireBinanceVenueRows({ orders: [] }, 'INVALID_OPEN_ALGO_ORDERS_SHAPE'); }
    catch (e: any) { rejected = String(e?.message).includes('INVALID_OPEN_ALGO_ORDERS_SHAPE'); }
    assert(rejected, 'Malformed 200 Algo payload must block');
  });

  test('★ Binance new smoke cannot use sole ordinary order list as preflight evidence', () => {
    // Explicit source-level wiring check so a future refactor cannot regress
    // to the old single book read while these isolated helper tests stay green.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const code = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/smoke/startAttempt.ts'), 'utf8');
    assert(code.includes('ops.readAllOpenOrdersForSmoke(venue, i.symbol)'));
    assert(!code.includes('const ordersBefore = await ops.readProtectiveOrders(venue, i.symbol)'));
  });

  test('★ failed entry and settlement residuals require BOTH Binance order books', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const start = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/smoke/startAttempt.ts'), 'utf8');
    const settle = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/smoke/settleAttempt.ts'), 'utf8');
    assert(start.includes('const ordersAfter = await ops.readAllOpenOrdersForSmoke(venue, i.symbol)'));
    assert(!start.includes('const ordersAfter = await ops.readProtectiveOrders(venue, i.symbol)'));
    assert(settle.includes('const leftover = await ops.readAllOpenOrdersForSmoke(venue, row.symbol)'));
    assert(!settle.includes('const leftover = plan.ok ? (cx.leftover ?? await ops.readProtectiveOrders'));
  });

  test('★ legacy read-only diagnostic with 3 successful empty reads is NOT authorization', () => {
    const r = legacySmokeExposureVerdict({
      symbol: 'BTCUSDT',
      positionRead: { success: true, positions: [] },
      regularOrderRead: { success: true, orders: [] },
      algoOrderRead: { success: true, orders: [] },
    });
    eq(r.code, 'OBSERVED_FLAT_NOW');
    eq(r.positionCount, 0);
    eq(r.regularOrderCount, 0);
    eq(r.algoOrderCount, 0);
    eq(r.canClearHistoricalUnknown, false);
    eq(r.mayStartSmoke, false);
  });

  test('★ old -1111 history cannot clear if regular or Algo order still exists', () => {
    for (const [regular,algo] of [[1,0],[0,1],[2,3]]) {
      const r = legacySmokeExposureVerdict({
        symbol: 'BTCUSDT',
        positionRead: { success: true, positions: [] },
        regularOrderRead: { success: true, orders: Array(regular).fill({}) },
        algoOrderRead: { success: true, orders: Array(algo).fill({}) },
      });
      eq(r.code, 'EXPOSURE_OPEN');
      eq(r.mayStartSmoke, false);
    }
  });

  test('★ legacy venue cannot report flat while BTCUSDT position remains open', () => {
    const r = legacySmokeExposureVerdict({
      symbol: 'BTCUSDT',
      positionRead: { success: true,
        positions: [{ symbol: 'BTCUSDT', amount: 0.002, side: 'LONG' }] },
      regularOrderRead: { success: true, orders: [] },
      algoOrderRead: { success: true, orders: [] },
    });
    eq(r.code, 'EXPOSURE_OPEN');
    eq(r.positionCount, 1);
    eq(r.canClearHistoricalUnknown, false);
  });

  test('★ a failure in any of 3 signed reads remains UNKNOWN, even if 2 are empty', () => {
    const base: any = {
      symbol: 'BTCUSDT',
      positionRead: { success: true, positions: [] },
      regularOrderRead: { success: true, orders: [] },
      algoOrderRead: { success: true, orders: [] },
    };
    for (const key of ['positionRead', 'regularOrderRead', 'algoOrderRead']) {
      const r = legacySmokeExposureVerdict({
        ...base, [key]: { success: false, orders: [], positions: [] },
      });
      eq(r.code, 'UNKNOWN');
      eq(r.mayStartSmoke, false);
    }
  });

  test('★ malformed authenticated position and Algo 200 payload fail UNKNOWN', () => {
    for (const invalid of [
      { success: true, positions: {} },
      { success: true, positions: [{ symbol: 'BTCUSDT', amount: NaN }] },
      { success: true, positions: [{ symbol: 'BTCUSDT', amount: null }] },
    ]) {
      const r = legacySmokeExposureVerdict({
        symbol: 'BTCUSDT', positionRead: invalid,
        regularOrderRead: { success: true, orders: [] },
        algoOrderRead: { success: true, orders: [] },
      });
      eq(r.code, 'UNKNOWN');
    }
  });

  test('★ legacy diagnostic has no data writes and only authentication-owned rows', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const route = fs.readFileSync(path.resolve(process.cwd(),
      'src/app/api/autotrade/smoke-test/legacy-evidence/route.ts'), 'utf8');
    assert(route.includes("resolveUserId(req.headers.get('authorization'), null, null)"));
    assert(route.includes(".eq('id', testId).eq('user_id', userId).maybeSingle()"));
    assert(route.includes("creds.isTestnetRaw !== true"));
    assert(route.includes('getFuturesOpenAlgoOrders('));
    assert(route.includes('getFuturesOpenOrders('));
    assert(route.includes('getFuturesPositions('));
    assert(!/\.insert\s*\(|\.update\s*\(|\.delete\s*\(|\.upsert\s*\(/.test(route));
    assert(!route.includes("export async function GET("),
      'GET route with cross-site links might allow unreviewed account scans');
  });

  test('★ historical -1111 UNKNOWN row PZ PASS without ORDERS_ZERO remains blocked', () => {
    const prior = {
      id: 'synthetic-legacy-1111', connection_id: 'conn-1', state: 'UNKNOWN',
      steps: {
        PREFLIGHT: { state: 'PASS' },
        ENTRY: { state: 'FAIL', note: '[-1111] Precision error' },
        POSITION_ZERO: { state: 'PASS' },
      },
    };
    const v = unresolvedExposureBlock({ rows: [prior], connectionId: 'conn-1' });
    eq(v.blocked, true);
    eq(v.code, 'EXPOSURE_UNKNOWN');
    eq(v.offenders.length, 1);
  });

  test('★ legacy unknown only clears after BOTH venue-zero facts are recorded', () => {
    const v = unresolvedExposureBlock({
      rows: [{
        id: 'synthetic-legacy-1111', connection_id: 'conn-1', state: 'UNKNOWN',
        steps: { POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'PASS' } },
      }],
      connectionId: 'conn-1',
    });
    eq(v.blocked, false);
    eq(v.code, 'CLEAR');
  });

  console.log('[과거 UNKNOWN 회차 — 거래소 증거로만 풀린다]');

  /** 거래소가 셋 다 비어 있다고 **읽힌** 상태 */
  const FLAT = {
    positionRead: { success: true, positions: [] },
    regularOrderRead: { success: true, orders: [] },
    algoOrderRead: { success: true, orders: [] },
  };
  const unknownBlock = (ids = ['t-legacy']) =>
    unresolvedExposureBlock({
      rows: ids.map(id => ({ id, connection_id: 'c-1', state: 'UNKNOWN', steps: {} })),
      connectionId: 'c-1',
    });

  test('★ state=UNKNOWN에 단계 기록이 없으면 "노출 없음"이 아니라 미확인이다', () => {
    // 이것이 열려 있던 구멍이다. 단계 기록이 없다는 이유로 건너뛰면,
    // 정리됐는지 **모르는** 회차 위에 새 회차가 그대로 열린다.
    const v = unknownBlock();
    eq(v.blocked, true);
    eq(v.code, 'EXPOSURE_UNKNOWN');
    eq(v.offenders.join(','), 't-legacy');
  });

  test('★ 정산이 예외로 끝나 state=FAIL만 남은 회차도 미확인으로 막는다', () => {
    const v = unresolvedExposureBlock({
      rows: [{
        id: 't-settle-threw', connection_id: 'c-1', state: 'FAIL',
        steps: { CLOSE: { state: 'UNKNOWN' }, RECONCILE: { state: 'UNKNOWN' } },
      }],
      connectionId: 'c-1',
    });
    eq(v.blocked, true);
    eq(v.code, 'EXPOSURE_UNKNOWN');
  });

  test('★ 사전 확인에서 멈춘 회차(BLOCKED)는 노출이 아니다', () => {
    // 주문을 낸 적이 없다. 이것까지 막으면 한 번 막힌 뒤로 영영
    // 시작할 수 없고, 그 상태를 푸는 길은 아무도 쓰지 않는다.
    const v = unresolvedExposureBlock({
      rows: [{
        id: 't-blocked', connection_id: 'c-1', state: 'BLOCKED',
        steps: { PREFLIGHT: { state: 'FAIL' } },
      }],
      connectionId: 'c-1',
    });
    eq(v.blocked, false);
    eq(v.code, 'CLEAR');
  });

  test('★ 세 장부가 모두 0으로 **읽혀야만** 과거 UNKNOWN이 풀린다', () => {
    const c = legacyExposureClearance({ block: unknownBlock(), ...FLAT });
    eq(c.cleared, true);
    eq(c.code, 'CLEARED_BY_VENUE');
    eq(c.positionCount, 0); eq(c.regularOrderCount, 0); eq(c.algoOrderCount, 0);
  });

  test('★ 셋 중 하나라도 못 읽으면 풀리지 않는다 — 0건이 아니라 모른다', () => {
    for (const key of ['positionRead', 'regularOrderRead', 'algoOrderRead'] as const) {
      const c = legacyExposureClearance({
        block: unknownBlock(), ...FLAT, [key]: { success: false, message: 'timeout' },
      });
      eq(c.cleared, false, key);
      eq(c.code, 'READ_FAILED', key);
      // **못 읽은 장부는 0이 아니라 null로 적힌다**
      const counts: any = c;
      const field = key === 'positionRead' ? 'positionCount'
        : key === 'regularOrderRead' ? 'regularOrderCount' : 'algoOrderCount';
      eq(counts[field], null, key);
    }
  });

  test('★ 200이어도 배열이 아니면 "비어 있음"으로 읽지 않는다', () => {
    for (const bad of [
      { positionRead: { success: true, positions: {} } },
      { regularOrderRead: { success: true, orders: null } },
      { algoOrderRead: { success: true, orders: 'none' } },
      { positionRead: { success: true, positions: [{ symbol: 'BTCUSDT', amount: NaN }] } },
      { positionRead: { success: true, positions: [{ symbol: 7, amount: 1 }] } },
    ]) {
      const c = legacyExposureClearance({ block: unknownBlock(), ...FLAT, ...bad });
      eq(c.cleared, false, JSON.stringify(bad));
      eq(c.code, 'READ_FAILED', JSON.stringify(bad));
    }
  });

  test('★ 포지션·일반 주문·조건부 주문이 하나라도 남으면 풀리지 않는다', () => {
    for (const residual of [
      { positionRead: { success: true, positions: [{ symbol: 'ETHUSDT', amount: 0.1 }] } },
      { regularOrderRead: { success: true, orders: [{ orderId: 1, symbol: 'ETHUSDT' }] } },
      { algoOrderRead: { success: true, orders: [{ algoId: '9001', symbol: 'ETHUSDT' }] } },
    ]) {
      const c = legacyExposureClearance({ block: unknownBlock(), ...FLAT, ...residual });
      eq(c.cleared, false, JSON.stringify(residual));
      eq(c.code, 'EXPOSURE_OPEN', JSON.stringify(residual));
    }
  });

  test('★ 다른 종목에 남은 노출도 막는다 — 이 판정은 연결 단위다', () => {
    // 요청 종목이 BTCUSDT여도 ETHUSDT에 남은 포지션이 막아야 한다.
    const c = legacyExposureClearance({
      block: unknownBlock(), ...FLAT,
      positionRead: { success: true, positions: [{ symbol: 'ETHUSDT', amount: 0.5 }] },
    });
    eq(c.code, 'EXPOSURE_OPEN');
    eq(c.positionCount, 1);
  });

  test('★ FAIL로 기록된 회차는 거래소가 비어 있어도 기계가 풀지 않는다', () => {
    const block = unresolvedExposureBlock({
      rows: [{ id: 't-fail', connection_id: 'c-1', state: 'FAIL',
        steps: { POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'FAIL' } } }],
      connectionId: 'c-1',
    });
    eq(block.code, 'UNPROTECTED_UNRESOLVED');
    const c = legacyExposureClearance({ block, ...FLAT });
    eq(c.cleared, false);
    eq(c.code, 'NOT_CLEARABLE');
  });

  test('★ 장부를 못 읽은 차단은 거래소 증거로 풀지 않는다', () => {
    const block = unresolvedExposureBlock({ rows: null, connectionId: 'c-1' });
    eq(block.code, 'LEDGER_UNREADABLE');
    eq(legacyExposureClearance({ block, ...FLAT }).code, 'NOT_CLEARABLE');
  });

  test('★ 막히지 않은 상태를 "풀렸다"로 돌려주지 않는다', () => {
    const block = unresolvedExposureBlock({ rows: [], connectionId: 'c-1' });
    eq(block.blocked, false);
    eq(legacyExposureClearance({ block, ...FLAT }).cleared, false);
  });

  test('★ 거래소 증거는 옛 회차의 판정을 고치지 않는다', () => {
    // 푸는 것은 "지금 새 회차를 열어도 되는가" 하나뿐이다. 옛 줄의
    // UNKNOWN을 PASS로 바꾸면 그 회차가 통과한 것처럼 보인다.
    const rows = [{ id: 't-legacy', connection_id: 'c-1', state: 'UNKNOWN', steps: {} }];
    const before = JSON.stringify(rows);
    const block = unresolvedExposureBlock({ rows, connectionId: 'c-1' });
    eq(legacyExposureClearance({ block, ...FLAT }).cleared, true);
    eq(JSON.stringify(rows), before, '판정 함수가 장부 줄을 고쳤습니다');
    // 같은 줄을 다시 보면 여전히 막힌다 — 증거는 저장되지 않는다.
    eq(unresolvedExposureBlock({ rows, connectionId: 'c-1' }).blocked, true);
  });

  test('★ 관문은 하나다 — 합친 판정이 blocked를 말한다', () => {
    const open = exposureGateAfterVenueCheck({
      block: unknownBlock(), ...FLAT,
      algoOrderRead: { success: true, orders: [{ algoId: '9001' }] },
    });
    eq(open.blocked, true);
    eq(open.code, 'EXPOSURE_UNKNOWN');
    assert(open.reason.includes('남아 있습니다'), open.reason);

    const clear = exposureGateAfterVenueCheck({ block: unknownBlock(), ...FLAT });
    eq(clear.blocked, false);
    eq(clear.code, 'CLEAR');
    eq(clear.clearance.code, 'CLEARED_BY_VENUE');

    // FAIL로 기록된 차단은 거래소가 비어 있어도 합친 뒤에도 막혀 있다.
    const recordedFail = unresolvedExposureBlock({
      rows: [{ id: 't-fail', connection_id: 'c-1',
        steps: { POSITION_ZERO: { state: 'FAIL' } } }],
      connectionId: 'c-1',
    });
    const still = exposureGateAfterVenueCheck({ block: recordedFail, ...FLAT });
    eq(still.blocked, true);
    eq(still.code, 'UNPROTECTED_UNRESOLVED');
  });

  console.log('[스모크 테스트 — 시작 요청 검사]');

  test('제대로 된 요청은 값으로 확정된다', () => {
    const v = smokeRequestVerdict(OK_BODY);
    eq(v.ok, true); eq(v.code, 'OK');
    eq(v.request!.symbol, 'ETHUSDT'); eq(v.request!.side, 'LONG');
    eq(v.request!.leverage, 100, '배율을 조용히 낮췄다');
  });

  test('실전에서는 열리지 않는다', () => {
    for (const m of ['LIVE_SMALL', 'LIVE_LIMITED', 'SHADOW_LIVE', 'PAPER']) {
      const v = smokeRequestVerdict({ ...OK_BODY, mode: m });
      eq(v.ok, false, m); eq(v.code, 'NOT_TESTNET', m);
    }
  });

  test('아무 종목이나 열지 않는다', () => {
    eq(smokeRequestVerdict({ ...OK_BODY, symbol: 'DOGEUSDT' }).code, 'BAD_SYMBOL');
    eq(smokeRequestVerdict({ ...OK_BODY, symbol: '' }).code, 'BAD_SYMBOL');
  });

  test('방향·증거금·배율·유지시간을 모르는 값으로 받지 않는다', () => {
    eq(smokeRequestVerdict({ ...OK_BODY, side: 'BUY' }).code, 'BAD_SIDE');
    eq(smokeRequestVerdict({ ...OK_BODY, marginUsd: 0 }).code, 'BAD_MARGIN');
    eq(smokeRequestVerdict({ ...OK_BODY, marginUsd: null }).code, 'BAD_MARGIN');
    eq(smokeRequestVerdict({ ...OK_BODY, leverage: 200 }).code, 'BAD_LEVERAGE');
    eq(smokeRequestVerdict({ ...OK_BODY, leverage: 1.5 }).code, 'BAD_LEVERAGE');
    eq(smokeRequestVerdict({ ...OK_BODY, holdMin: 60 }).code, 'BAD_HOLD');
    eq(smokeRequestVerdict({ ...OK_BODY, connectionId: '' }).code, 'NO_CONNECTION');
  });

  test('유지 시간을 안 주면 기본 10분이다', () => {
    const v = smokeRequestVerdict({ ...OK_BODY, holdMin: undefined });
    eq(v.ok, true); eq(v.request!.holdMin, DEFAULT_HOLD_MIN);
  });

  test('고를 수 있는 유지 시간은 1·5·10·30분이다', () => {
    eq(HOLD_CHOICES.join(','), '1,5,10,30');
    for (const m of HOLD_CHOICES) eq(smokeRequestVerdict({ ...OK_BODY, holdMin: m }).ok, true, String(m));
    // 상한이 있어야 워커가 죽었을 때의 노출이 묶인다.
    eq(MAX_HOLD_MIN, 30);
  });

  console.log('[스모크 테스트 — 사전 확인: 남의 것을 덮지 않는다]');

  test('기존 포지션이 있으면 시작하지 않는다 — 자동으로 덮지 않는다', () => {
    const v = preflightVerdict({ position: { ok: true, found: true, qty: 0.01 }, orders: [] });
    eq(v.ok, false); eq(v.code, 'POSITION_OPEN');
    assert(v.reason.includes('덮거나 청산하지 않습니다'), v.reason);
  });

  test('조건부 주문이 남아 있으면 시작하지 않는다', () => {
    const v = preflightVerdict({ position: { ok: true, found: false }, orders: [{ id: '1' }] });
    eq(v.ok, false); eq(v.code, 'ORDERS_OPEN');
    assert(v.reason.includes('대신 지우지 않습니다'), v.reason);
  });

  test('조회 실패를 "깨끗함"으로 읽지 않는다', () => {
    eq(preflightVerdict({ position: { ok: false, found: false }, orders: [] }).code, 'UNKNOWN');
    eq(preflightVerdict({ position: { ok: true, found: false }, orders: null }).code, 'UNKNOWN');
    eq(preflightVerdict({ position: null, orders: [] }).code, 'UNKNOWN');
  });

  test('둘 다 0일 때만 시작한다', () => {
    const v = preflightVerdict({ position: { ok: true, found: false, qty: 0 }, orders: [] });
    eq(v.ok, true); eq(v.code, 'CLEAR');
  });

  console.log('[스모크 테스트 — 최종 판정]');

  test('전부 통과해야 PASS다', () => {
    const v = smokeVerdict(allSteps('PASS'));
    eq(v.code, 'PASS'); eq(v.pass, true);
    eq(v.passed, v.total);
  });

  test('기록이 없는 단계는 PENDING이지 PASS가 아니다', () => {
    // 아무것도 안 한 테스트가 초록으로 보이면 안 된다.
    const v = smokeVerdict(stepsOf({}));
    eq(v.pass, false); eq(v.code, 'RUNNING'); eq(v.passed, 0);
  });

  test('하나라도 FAIL이면 나머지가 초록이어도 FAIL이다', () => {
    const v = smokeVerdict(allSteps('PASS', { ORDERS_ZERO: 'FAIL' }));
    eq(v.code, 'FAIL'); eq(v.pass, false);
    assert(v.reason.includes('잔여 보호주문 0'), v.reason);
  });

  test('테스트가 끝났는데 고아 주문이 남으면 FAIL이다', () => {
    // 어제 Gate에 조건부 주문 4개가 쌓인 그 자리다. 남은 주문은
    // 다음 진입을 친다 — "청산 성공"으로 끝내면 안 된다.
    const v = smokeVerdict(allSteps('PASS', { ORDERS_ZERO: 'FAIL' }));
    eq(v.pass, false);
  });

  test('확인하지 못한 단계가 있으면 PASS가 아니다', () => {
    const v = smokeVerdict(allSteps('PASS', { POSITION_ZERO: 'UNKNOWN' }));
    eq(v.code, 'UNKNOWN'); eq(v.pass, false);
    assert(v.reason.includes('통과로 적지 않습니다'), v.reason);
  });

  test('SL은 붙었는데 TP가 없으면 PASS가 아니다', () => {
    const v = smokeVerdict(allSteps('PASS', { TAKE_PROFIT: 'FAIL' }));
    eq(v.pass, false);
  });

  test('사전 확인에서 막히면 BLOCKED다', () => {
    const v = smokeVerdict(allSteps('PENDING', { PREFLIGHT: 'FAIL' }), 'BLOCKED');
    eq(v.code, 'BLOCKED'); eq(v.pass, false);
  });

  test('모르는 상태 값을 PASS로 눕히지 않는다', () => {
    const s = stepsOf({ ENTRY: { state: 'ㅇㅋ' }, FILL: { state: true }, STOP: {} });
    for (const x of s) eq(x.state, 'PENDING', x.id);
  });

  console.log('[스모크 테스트 — 유지 시간]');

  const NOW = 1_800_000_000_000;

  test('마감 시각은 시작 + 유지 시간이다', () => {
    eq(holdUntilMs(NOW, 10), NOW + 600_000);
    eq(holdUntilMs(NOW, 1), NOW + 60_000);
  });

  test('상한을 넘는 유지 시간은 마감 시각을 만들지 않는다', () => {
    eq(holdUntilMs(NOW, 120), null);
    eq(holdUntilMs(NOW, 0), null);
    eq(holdUntilMs(NOW, -5), null);
  });

  test('마감 전에는 닫지 않는다', () => {
    const v = closeDue({ nowMs: NOW, state: 'HOLDING', holdUntil: new Date(NOW + 300_000).toISOString() });
    eq(v.due, false); eq(v.code, 'WAITING'); eq(v.remainingMs, 300_000);
  });

  test('마감이 지나면 닫는다', () => {
    const v = closeDue({ nowMs: NOW, state: 'HOLDING', holdUntil: new Date(NOW - 1_000).toISOString() });
    eq(v.due, true); eq(v.code, 'DUE');
  });

  test('마감 시각을 못 읽으면 "지금"으로 보지 않는다 — 방금 연 포지션이 바로 닫힌다', () => {
    for (const bad of [null, undefined, '', 'nope', {}]) {
      const v = closeDue({ nowMs: NOW, state: 'HOLDING', holdUntil: bad });
      eq(v.due, false, JSON.stringify(bad));
      eq(v.code, 'NO_DEADLINE', JSON.stringify(bad));
    }
  });

  test('유지 중이 아닌 테스트는 닫지 않는다', () => {
    for (const st of ['PASS', 'FAIL', 'ENTERING', 'BLOCKED', '']) {
      eq(closeDue({ nowMs: NOW, state: st, holdUntil: NOW - 1 }).code, 'NOT_HOLDING', st);
    }
  });

  console.log('[스모크 테스트 — 전략과 섞이지 않는다]');

  test('스모크 거래의 소유 전략은 실제 전략이 아니다', () => {
    eq(SMOKE_STRATEGY_ID, 'smoke-test');
    // registry의 어떤 전략 id와도 같으면 안 된다 — 같으면 그 전략의
    // 승률·손익에 사람이 고른 방향의 10분 왕복이 섞인다.
    for (const real of ['my-original-v1', 'daily-ladder', 'scalp']) {
      assert(SMOKE_STRATEGY_ID !== real, `스모크가 ${real}로 기록된다`);
    }
  });

  test('스모크가 도는 동안 같은 종목 전략 진입을 막는다', () => {
    const rows = [{ state: 'HOLDING', symbol: 'BTCUSDT', connection_id: 'conn-1' }];
    const v = smokeBlocksStrategy({ rows, symbol: 'BTCUSDT', connectionId: 'conn-1' });
    eq(v.blocked, true); eq(v.code, 'SMOKE_RUNNING');
  });

  test('끝난 스모크는 막지 않는다', () => {
    for (const st of ['PASS', 'FAIL', 'BLOCKED']) {
      const v = smokeBlocksStrategy({
        rows: [{ state: st, symbol: 'BTCUSDT', connection_id: 'conn-1' }],
        symbol: 'BTCUSDT', connectionId: 'conn-1',
      });
      eq(v.blocked, false, st);
    }
  });

  test('진입 중·청산 중도 진행 중이다', () => {
    for (const st of ['ENTERING', 'HOLDING', 'CLOSING']) {
      eq(smokeBlocksStrategy({
        rows: [{ state: st, symbol: 'ETHUSDT', connection_id: 'c' }],
        symbol: 'ETHUSDT', connectionId: 'c',
      }).blocked, true, st);
    }
  });

  test('다른 종목·다른 연결은 막지 않는다', () => {
    const rows = [{ state: 'HOLDING', symbol: 'BTCUSDT', connection_id: 'conn-1' }];
    eq(smokeBlocksStrategy({ rows, symbol: 'ETHUSDT', connectionId: 'conn-1' }).blocked, false);
    eq(smokeBlocksStrategy({ rows, symbol: 'BTCUSDT', connectionId: 'conn-2' }).blocked, false);
  });

  test('스모크 목록을 못 읽으면 통과가 아니다', () => {
    const v = smokeBlocksStrategy({ rows: null, symbol: 'BTCUSDT' });
    eq(v.blocked, true); eq(v.code, 'SMOKE_UNKNOWN');
  });

  console.log('[스모크 테스트 — 화면이 그릴 것]');

  test('단계 순서가 실제 실행 순서와 같다', () => {
    // 화면이 위에서 아래로 읽히려면 이 순서가 실행 순서여야 한다.
    eq(STEP_ORDER.join(' → '),
      'PREFLIGHT → ENTRY → FILL → STOP → TAKE_PROFIT → HOLD → CLOSE → POSITION_ZERO → ORDERS_ZERO → RECONCILE');
  });

  test('모든 단계에 한국어 이름이 있다', () => {
    for (const s of stepsOf({})) assert(s.label.length > 0, `${s.id}에 이름이 없다`);
  });

  console.log('[보호 없는 노출 — 진입이 확정되지 않았을 때 줄을 닫는 방법]');

  test('★ 보호 없는 포지션이 남으면 줄을 닫지 않고 정산으로 넘긴다', () => {
    const v = unprotectedExposureVerdict({
      code: 'ENTERED_UNPROTECTED',
      position: { ok: true, found: true, qty: 0.002 },
    });
    eq(v.handoff, 'SETTLE');
    eq(v.positionZero, 'FAIL');
    eq(v.alert, true);
    assert(/남았습니다/.test(v.reason), v.reason);
  });

  test('★ 재조회를 못 했으면 UNKNOWN이고, 그래도 정산으로 넘긴다', () => {
    // **모르는 것을 0으로 적지 않는다.** 그리고 모르는 채로 줄을 닫으면
    // `/settle`이 다시 보지 않는다(HOLDING인 줄만 고른다).
    for (const pos of [null, undefined, { ok: false }, { ok: false, found: false, qty: null }]) {
      const v = unprotectedExposureVerdict({ code: 'UNKNOWN', position: pos as any });
      eq(v.handoff, 'SETTLE');
      eq(v.positionZero, 'UNKNOWN');
      eq(v.alert, true);
    }
  });

  test('★ 포지션 0을 재조회로 확인했을 때만 줄을 닫는다', () => {
    const v = unprotectedExposureVerdict({
      code: 'UNKNOWN',
      position: { ok: true, found: false, qty: 0 },
    });
    eq(v.handoff, 'CLOSE_RECORD');
    eq(v.positionZero, 'PASS');
    eq(v.alert, false);
  });

  test('★ found가 false라도 수량이 남아 있으면 0으로 보지 않는다', () => {
    // 어댑터가 `found`를 못 채우고 수량만 주는 경우가 있다. 수량이
    // 0이 아니면 노출이다 — 두 신호 중 **하나라도** 남았다고 하면 남았다.
    const v = unprotectedExposureVerdict({
      code: 'ENTERED_UNPROTECTED',
      position: { ok: true, found: false, qty: -0.5 },
    });
    eq(v.handoff, 'SETTLE');
    eq(v.positionZero, 'FAIL');
  });

  test('★ 음수 수량(SHORT)도 노출로 센다', () => {
    const v = unprotectedExposureVerdict({
      code: 'ENTERED_UNPROTECTED',
      position: { ok: true, found: true, qty: -0.002 },
    });
    eq(v.positionZero, 'FAIL');
  });

  test('★ 읽을 수 없는 수량을 0으로 눕히지 않는다', () => {
    // `qty`가 NaN이면 "0"이 아니라 "모름"이다. `found`가 false이고
    // 수량이 NaN이면 수량 신호는 없는 것이므로 found를 따른다 —
    // 그래도 **ok가 true일 때만** PASS가 된다.
    const nan = unprotectedExposureVerdict({
      code: 'UNKNOWN', position: { ok: true, found: false, qty: Number.NaN },
    });
    eq(nan.positionZero, 'PASS');
    const unread = unprotectedExposureVerdict({
      code: 'UNKNOWN', position: { ok: undefined, found: false, qty: Number.NaN } as any,
    });
    eq(unread.positionZero, 'UNKNOWN');
  });

  test('★ 코드가 무엇이든 재조회 결과가 판정을 정한다', () => {
    // 보호 실패가 아니더라도(단순 UNKNOWN) 포지션이 남았으면 방치하지
    // 않는다. 문구만 다르다.
    const v = unprotectedExposureVerdict({
      code: 'NOT_ENTERED', position: { ok: true, found: true, qty: 0.001 },
    });
    eq(v.handoff, 'SETTLE');
    eq(v.positionZero, 'FAIL');
    assert(!/보호주문 없는/.test(v.reason), `보호 실패가 아닌데 그 문구를 적었습니다: ${v.reason}`);
  });

  test('★ PASS는 POSITION_ZERO 단계가 받는 값이어야 한다', () => {
    // 단계 상태 어휘를 벗어난 값을 적으면 화면과 진행 판정이 갈린다.
    const ok: StepState[] = ['PASS', 'FAIL', 'UNKNOWN'];
    for (const c of ['ENTERED_UNPROTECTED', 'UNKNOWN', 'NOT_ENTERED']) {
      for (const pos of [{ ok: true, found: true, qty: 1 }, { ok: true, found: false, qty: 0 }, { ok: false }]) {
        const v = unprotectedExposureVerdict({ code: c, position: pos as any });
        assert(ok.includes(v.positionZero as StepState),
          `${c}/${JSON.stringify(pos)} → ${v.positionZero}는 단계 어휘가 아니다`);
      }
    }
  });

  console.log('[스모크 주문 — 확인된 테스트넷 연결에만]');

  test('★ is_testnet === true 만 주문을 낸다', () => {
    const v = smokeTestnetVerdict(true);
    eq(v.ok, true);
    eq(v.code, 'OK');
  });

  test('★ 실전 연결은 거부하고 그렇게 적는다', () => {
    const v = smokeTestnetVerdict(false);
    eq(v.ok, false);
    eq(v.code, 'LIVE_CONNECTION');
    assert(/실전/.test(v.reason), v.reason);
  });

  test('★ 확인되지 않은 환경은 거부하되 실전이라고 부르지 않는다', () => {
    // 둘은 다른 사실이다. 같은 코드로 적으면 "실전 연결이 있다"는
    // 경보가 울리고, 사람은 없는 실전 연결을 찾으러 간다.
    for (const raw of [null, undefined, '', 0, 'true', 'TRUE', 1, {}, []]) {
      const v = smokeTestnetVerdict(raw);
      assert(!v.ok, `${JSON.stringify(raw)}가 통과했습니다`);
      eq(v.code, 'ENV_UNVERIFIED');
      assert(!/실전 연결로는/.test(v.reason),
        `${JSON.stringify(raw)}를 실전이라고 적었습니다: ${v.reason}`);
    }
  });

  test('★ 문자열 "true"를 참으로 읽지 않는다', () => {
    // DB가 텍스트로 돌려주는 경우를 통과시키면 확인이 아니라 추측이 된다.
    eq(smokeTestnetVerdict('true').ok, false);
  });

  console.log('[정리되지 않은 노출 위에 새 회차를 열지 않는다]');

  const PZ = (id: string, state: string | null, over: any = {}) => ({
    id, connection_id: 'c-1',
    steps: state == null ? {} : {
      POSITION_ZERO: { state },
      // 기존 PASS 픽스처는 두 가지 거래소 잔량 검사가 끝난 회차다.
      ...(state === 'PASS' ? { ORDERS_ZERO: { state: 'PASS' } } : {}),
    },
    ...over,
  });

  test('★ 장부를 못 읽으면 막는다 — 못 읽은 것은 "없음"이 아니다', () => {
    for (const rows of [null, undefined, 'nope' as any, 0 as any]) {
      const v = unresolvedExposureBlock({ rows, connectionId: 'c-1' });
      eq(v.blocked, true);
      eq(v.code, 'LEDGER_UNREADABLE');
    }
  });

  test('★ POSITION_ZERO가 FAIL인 회차가 있으면 막는다', () => {
    const v = unresolvedExposureBlock({
      rows: [PZ('t-1', 'PASS'), PZ('t-2', 'FAIL')], connectionId: 'c-1',
    });
    eq(v.blocked, true);
    eq(v.code, 'UNPROTECTED_UNRESOLVED');
    eq(v.offenders.join(','), 't-2');
  });

  test('★ UNKNOWN도 막는다 — 모르는 것 위에 새 회차를 열지 않는다', () => {
    const v = unresolvedExposureBlock({
      rows: [PZ('t-3', 'UNKNOWN')], connectionId: 'c-1',
    });
    eq(v.blocked, true);
    eq(v.code, 'EXPOSURE_UNKNOWN');
    eq(v.offenders.join(','), 't-3');
  });

  test('★ FAIL과 UNKNOWN이 섞이면 FAIL을 먼저 적는다', () => {
    // 둘 다 막지만, 사람이 먼저 봐야 하는 것은 확실히 남은 쪽이다.
    const v = unresolvedExposureBlock({
      rows: [PZ('t-4', 'UNKNOWN'), PZ('t-5', 'FAIL')], connectionId: 'c-1',
    });
    eq(v.code, 'UNPROTECTED_UNRESOLVED');
    eq(v.offenders.join(','), 't-5');
  });

  test('★ 거래소가 0을 확인한 회차(PASS)는 막지 않는다', () => {
    // 이 값은 settleAttempt가 **재조회로만** 적는다 — 장부를 고쳐서
    // 푸는 길이 없다는 뜻이다.
    const v = unresolvedExposureBlock({
      rows: [PZ('t-6', 'PASS'), PZ('t-7', 'PASS')], connectionId: 'c-1',
    });
    eq(v.blocked, false);
    eq(v.code, 'CLEAR');
  });

  test('★ 포지션 0이어도 미결 주문이 FAIL이면 재진입을 막는다', () => {
    const v = unresolvedExposureBlock({ rows: [PZ('o-fail', 'PASS', {
      steps: { POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'FAIL' } },
    })], connectionId: 'c-1' });
    eq(v.blocked, true); eq(v.code, 'UNPROTECTED_UNRESOLVED');
    eq(v.offenders.join(','), 'o-fail');
  });

  test('★ 미결 주문 PENDING·UNKNOWN·누락은 재진입을 막는다', () => {
    for (const oz of ['PENDING', 'UNKNOWN', null]) {
      const steps: any = { POSITION_ZERO: { state: 'PASS' } };
      if (oz != null) steps.ORDERS_ZERO = { state: oz };
      const v = unresolvedExposureBlock({ rows: [PZ('o-unknown', 'PASS', { steps })], connectionId: 'c-1' });
      eq(v.blocked, true, String(oz)); eq(v.code, 'EXPOSURE_UNKNOWN', String(oz));
    }
  });

  test('★ 진입 중인데 잔량 단계가 없으면 확인 불가로 막는다', () => {
    const v = unresolvedExposureBlock({ rows: [PZ('entering', null, { state: 'ENTERING' })], connectionId: 'c-1' });
    eq(v.blocked, true); eq(v.code, 'EXPOSURE_UNKNOWN');
  });

  test('★ 두 잔량 모두 PASS인 회차만 통과한다', () => {
    const v = unresolvedExposureBlock({ rows: [PZ('clean', 'PASS')], connectionId: 'c-1' });
    eq(v.blocked, false); eq(v.code, 'CLEAR');
  });

  test('★ 단계를 적은 적 없는 회차는 노출이 아니다', () => {
    // 진입조차 못 한 회차가 대부분이다. 이것까지 막으면 사전 확인에
    // 한 번 걸린 뒤로 영영 시작할 수 없다.
    const v = unresolvedExposureBlock({
      rows: [PZ('t-8', null), { id: 't-9' }], connectionId: 'c-1',
    });
    eq(v.blocked, false);
    eq(v.code, 'CLEAR');
  });

  test('★ 다른 연결의 노출은 이 연결을 막지 않는다', () => {
    const v = unresolvedExposureBlock({
      rows: [PZ('t-10', 'FAIL', { connection_id: 'c-2' })], connectionId: 'c-1',
    });
    eq(v.blocked, false);
  });

  test('★ 연결을 안 적으면 전부 본다 — 좁히지 못한 것을 통과로 바꾸지 않는다', () => {
    const v = unresolvedExposureBlock({
      rows: [PZ('t-11', 'FAIL', { connection_id: 'c-2' })], connectionId: null,
    });
    eq(v.blocked, true);
  });

  test('★ 단계 상태가 문자열로만 적힌 옛 줄도 읽는다', () => {
    const v = unresolvedExposureBlock({
      rows: [{ id: 't-12', connection_id: 'c-1', steps: { POSITION_ZERO: 'FAIL' } }],
      connectionId: 'c-1',
    });
    eq(v.blocked, true);
    eq(v.code, 'UNPROTECTED_UNRESOLVED');
  });

  test('★ 막은 근거가 된 회차 id를 사유에 적는다', () => {
    // 사람이 바로 찾아볼 수 있어야 한다.
    const v = unresolvedExposureBlock({
      rows: [PZ('t-13', 'FAIL')], connectionId: 'c-1',
    });
    assert(v.reason.includes('t-13'), v.reason);
  });
}
