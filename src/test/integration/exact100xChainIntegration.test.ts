// src/test/integration/exact100xChainIntegration.test.ts
//
// **Exact100X 한 포지션의 일생을 한 번에 따라간다.**
//
// 왜 구간 시험만으로는 부족한가
// ─────────────────────────────
// 이 저장소에는 구간마다 시험이 있다 — 진입(`orderPathIntegration`),
// 전용 종료(`exitAuthorityRun`, 33건), 보유 연장(`holdExtension`),
// 관측(`exact100xObservation`). 그런데 **구간끼리는 전부 손으로 만든
// fixture로 이어져 있다.**
//
// 그래서 다음이 통과한다: 진입 경로가 장부에 적는 줄의 모양이 바뀌어도
// (계약 세 칸을 안 적거나, 체결 시각을 안 남기거나, 손절 정책 이름이
// 달라져도) 감시 쪽 시험은 제 fixture를 쓰므로 **전부 초록이다.**
// 운영에서는 그 포지션이 전용 종료 권한에 영원히 잡히지 않는다 —
// 100배 포지션이 4시간 청산 없이 방치된다는 뜻이다.
//
// 그래서 여기서는 **손으로 만든 줄을 쓰지 않는다.** 실제 실행기가 장부에
// 적은 줄을 **그대로** 읽어 감시 경로에 먹인다. 이음매가 끊기면 여기서
// 끊긴다.
//
//   ① 진입    실제 `executeOrder` (Exact100X 계약 · NO_FIXED_SL)
//   ② 장부    FakeDb에 실제로 적힌 `live_orders` 줄
//   ③ 선정    실제 `managedCandidates` — ②의 줄을 그대로 넣는다
//   ④ 종료    실제 `runExitAuthority` + 실제 `venuePositionOps`
//   ⑤ 잔여    재조회로 0 확인 · 추가 주문 0건
//   ⑥ 관측    실측 표본 자격 정본
//
// 거래소는 가짜다(HTTP 경계 한 겹). **실제 주문은 나가지 않는다.**

import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
import { executeOrder } from '../../lib/engine/orderExecutor';
import { managedCandidates } from '../../lib/engine/managedPosition';
import { runExitAuthority } from '../../lib/engine/exitAuthorityRun';
import { exitIntentId } from '../../lib/engine/exitIntent';
import { verifiedTestnetObservationEligibility } from '../../lib/engine/riskObservationEligibility';
import { EXECUTION_CONTRACT_VERSION } from '../../lib/execution/profile';
import * as ops from '../../lib/engine/venuePositionOps';

const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_DUAL = '/fapi/v1/positionSide/dual';
const BN_EXINFO = '/fapi/v1/exchangeInfo';
const SYMBOL = 'BTCUSDT';
const QTY = 0.01;
const FOUR_HOURS_MS = 4 * 60 * 60_000;

/** Exact100X 실행 계약. **정본 상수를 쓴다** — 숫자를 지어내지 않는다 */
const IDENT = {
  profileId: 'MAX_LEV_100X',
  presetId: 'EXACT_100X',
  contractVersion: EXECUTION_CONTRACT_VERSION,
};

const CREDS = {
  exchange: 'binance' as const,
  apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64), testnet: true,
};

/** 거래소 규격·모드·레버리지 기본 응답 */
function baseVenue(): FakeVenue {
  return new FakeVenue()
    .on(BN_EXINFO, { json: { symbols: [{
      symbol: SYMBOL, filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      ],
    }] } })
    .on('/fapi/v1/marginType', { json: { code: 200, msg: 'success' } })
    .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
    .on(BN_DUAL, { json: { dualSidePosition: false } })
    .on('/fapi/v1/leverage', { json: { leverage: 100, symbol: SYMBOL } });
}

/** 승인된 100배 진입 계획 */
const plan = () => ({
  approved: true, symbol: SYMBOL, side: 'LONG' as const,
  riskAmount: 10, riskAmountWithCosts: 10,
  stopDistancePct: 1, effectiveStopPct: 1,
  positionSize: 1000, quantity: QTY, requiredMargin: 10,
  leverage: 100, liquidationPrice: 59400, liquidationDistancePct: 1,
  notes: [],
}) as any;

/** 포지션 한 줄 (거래소 응답 모양) */
const posRow = (amt: string) => ([{
  symbol: SYMBOL, positionAmt: amt, entryPrice: amt === '0' ? '0' : '60000',
  leverage: '100', marginType: 'isolated',
  liquidationPrice: amt === '0' ? '0' : '59400', updateTime: 1,
}]);

/** 시나리오 하나를 단독으로 — `fetch` 스텁이 겹치지 않게 */
async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

/** ① 진입을 실제로 한 번 돌린다. 장부(FakeDb)에 줄이 남는다 */
async function enter(db: FakeDb, over: Record<string, any> = {}) {
  return executeOrder(db as any, {
    userId: 'u1', connectionId: 'c1', signalId: 'sig-1',
    clientOrderId: 'X100-COID-1',
    exchange: 'binance', mode: 'TESTNET',
    plan: plan(),
    apiKey: CREDS.apiKey, apiSecret: CREDS.apiSecret,
    // Exact100X 계약 그대로 — 고정 손절도 고정 익절도 없다
    stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP',
    protectionPolicy: 'NONE',
    executionIdentity: IDENT,
    ...over,
  } as any);
}

export async function runExact100xChainTests() {
  console.log('[통합 — Exact100X 전 구간 (진입 → 장부 → 선정 → 종료 → 잔여)]');

  // ══════════════════════════════════════════════════════════
  // ① 진입 → ② 장부 → ③ 선정
  // ══════════════════════════════════════════════════════════
  const db = new FakeDb();
  const entryVenue = baseVenue()
    .on(BN_POS, { json: posRow('0') })
    .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
    .on(BN_ORDER, { json: {
      orderId: 9001, symbol: SYMBOL, status: 'FILLED',
      executedQty: String(QTY), origQty: String(QTY), avgPrice: '60000', price: '0',
    } }, 'POST');

  const entered = await scenario(entryVenue, () => enter(db));
  const ledger = db.table('live_orders');
  const row = ledger[0] ?? null;

  test('① 진입이 실제로 돌고 체결 수량이 장부에 보존된다 (실제 실행기 · 실제 쓰기)', () => {
    assert(!(entered instanceof Error), `진입이 던졌다: ${(entered as any)?.message}`);
    const e: any = entered;
    eq(e.ok, true, JSON.stringify(entered).slice(0, 200));
    eq(e.filledQty, QTY, '체결 수량이 보존돼야 한다');
    eq(ledger.length, 1, '장부에 한 줄이 남아야 한다');
    eq(entryVenue.orderSends().length, 1, '주문은 정확히 한 번');
    // **상태 이름을 여기서 단정하지 않는다.** 실행기가 체결 증거의 세기에
    // 따라 ACKED/FILLED를 가린다 — 이 시험이 묻는 것은 그다음, 즉
    // "그 상태의 줄을 감시가 집는가"다.
    assert(['ACKED', 'FILLED', 'RECONCILED'].includes(String(ledger[0].status)),
      `진입 상태가 보유 집합 밖이다: ${ledger[0].status}`);
  });

  test('② 장부 줄이 Exact100X로 식별 가능한 모양이다 — 세 칸 + 정책 + 체결 시각', () => {
    assert(row != null, '장부 줄이 없다');
    eq(row.stop_policy, 'NO_FIXED_SL', '고정 손절 없음이 적혀야 한다');
    eq(row.execution_profile_id, IDENT.profileId);
    eq(row.execution_preset_id, IDENT.presetId);
    eq(row.execution_contract_version, IDENT.contractVersion);
    // ★ `acked_at`이 없으면 전용 종료 권한이 이 줄을 **영원히** 집지 않는다.
    //   시간 청산의 기준이 그 값이기 때문이다 (created_at은 보내기 전 시각이라 쓰지 않는다).
    assert(row.acked_at != null, '★ 체결 시각(acked_at)이 장부에 없다');
    assert(Number.isFinite(Date.parse(String(row.acked_at))), '체결 시각을 읽을 수 없다');
  });

  // ③ **손으로 만든 줄이 아니라** 위에서 실제로 적힌 줄을 그대로 넣는다.
  const picked = managedCandidates(ledger);
  const cand = picked.authorityCandidates[0] ?? null;

  test('★ ③ 감시 회차가 그 줄을 전용 종료 후보로 집는다 (이음매)', () => {
    eq(picked.authorityCandidates.length, 1,
      `★ 진입이 적은 줄을 감시가 못 집었다 — 유예: ${JSON.stringify(picked.deferred)}`
      + ` · 건너뜀: ${JSON.stringify(picked.skipped)}`);
    eq(cand.symbol, SYMBOL);
    eq(cand.side, 'LONG');
    eq(cand.exposureClass, 'NO_FIXED_SL_EXACT100X');
    eq(cand.connectionId, 'c1');
    eq(cand.capabilities.timeExit, true, '시간 청산이 열려 있어야 한다');
    assert(Number.isFinite(cand.openedAt), '진입 시각이 숫자여야 한다');
  });

  test('③-b 일반 생명주기는 이 노출을 건드리지 않는다 (자리 유예 유지)', () => {
    eq(picked.positions.length, 0, '트레일링·본전이동이 100배 노출을 집으면 안 된다');
    eq(picked.deferred.length, 1, '인식했다는 기록은 남는다');
    eq(picked.deferred[0].code, 'NO_FIXED_SL_EXIT_UNWIRED');
  });

  // ══════════════════════════════════════════════════════════
  // ④ 종료 → ⑤ 잔여 — 실제 runExitAuthority + 실제 venuePositionOps
  // ══════════════════════════════════════════════════════════
  let closedOnce = false;
  const exitVenue = baseVenue()
    // 닫기 전에는 열려 있고, 닫은 뒤에는 0이다
    .on(BN_POS, { json: () => (closedOnce ? posRow('0') : posRow(String(QTY))) })
    .on(BN_ORDER, { json: () => { closedOnce = true; return {
      orderId: 9002, symbol: SYMBOL, status: 'FILLED',
      executedQty: String(QTY), origQty: String(QTY), avgPrice: '60100',
    }; } }, 'POST');

  let prepared: any = null;
  const deps = {
    leaseOwned: async () => ({ owned: true, identity: { holder: 'test', fence: 1 } as any }),
    prepareClose: async () => {
      const p = await ops.prepareSymbolClose(CREDS, SYMBOL, 'LONG',
        (observedQty) => exitIntentId({
          connectionId: 'c1', exchange: 'binance', symbol: SYMBOL, side: 'LONG',
          executionIdentity: IDENT, reason: 'TIME_EXIT', quantity: observedQty,
        }));
      prepared = p.prepared;
      return { code: p.code, prepared: p.prepared as any, message: p.message };
    },
    revalidateFence: async () => true,
    sendClose: async () => ops.sendSymbolClose(CREDS, prepared),
    readAfter: async () => {
      const r = await ops.readOpenPosition(CREDS, SYMBOL);
      return { ok: r.ok, found: r.found };
    },
  };

  // ★ **라우트와 같은 모양으로 만든다.** 계약은 `positionIdentity` 안에도
  //   들어간다 — 여기서 빠뜨리면 판정이 IDENTITY_INCOMPLETE로 막는다.
  //   (이 시험을 쓰면서 실제로 한 번 빠뜨렸고, 관문이 잡았다.)
  const runCandidate = cand == null ? null : {
    positionIdentity: {
      connectionId: cand.connectionId, exchange: cand.exchange,
      symbol: cand.symbol, side: cand.side,
      executionIdentity: cand.executionIdentity,
      openingOrderId: cand.orderId,
    },
    strategyId: cand.strategyId,
    executionIdentity: cand.executionIdentity,
    capabilities: cand.capabilities,
    reason: 'TIME_EXIT' as const,
    openedAtMs: cand.openedAt,
  };

  // 4시간이 지난 시점에 감시가 돈다
  const exitRun = runCandidate == null ? null : await scenario(exitVenue,
    () => runExitAuthority(runCandidate as any, deps as any, cand.openedAt + FOUR_HOURS_MS + 1));

  test('★ ④ 4시간이 지나면 그 후보를 실제로 닫는다 — 축소 전용 · 반대 방향 · 1건', () => {
    assert(exitRun != null && !(exitRun instanceof Error),
      `종료가 던졌다: ${(exitRun as any)?.message}`);
    const r: any = exitRun;
    eq(r.code, 'CLOSED_VERIFIED', `${r.code} — ${r.reason}`);
    eq(r.attemptedWrite, true);
    eq(r.flatVerified, true, '재조회로 0을 확인해야 CLOSED다');
    const sends = exitVenue.orderSends();
    eq(sends.length, 1, '★ 청산 주문은 정확히 한 번');
    eq(sends[0].params.side, 'SELL', 'LONG을 닫는 주문은 SELL이다');
    eq(sends[0].params.reduceOnly, 'true', '★ 축소 전용이 아니면 반대 진입이 된다');
    eq(Number(sends[0].params.quantity), QTY, '지금 관측한 노출만큼 닫는다');
  });

  test('⑤ 잔여 확인 뒤에는 거래소에 아무것도 더 보내지 않는다', () => {
    eq(exitVenue.orderSends().length, 1, '재시도·추가 주문 0건');
    // 재조회(positionRisk)는 **읽기**다. 쓰기가 아니다.
    assert(exitVenue.countOf(BN_POS) >= 2, '보낸 뒤 다시 읽어야 한다');
  });

  test('⑥ 그 노출은 TESTNET 실측 표본 자격이 있다', () => {
    const el = verifiedTestnetObservationEligibility({
      testnet: true, exchange: 'binance', side: 'LONG',
      executionIdentity: cand?.executionIdentity, positionAmt: QTY,
    });
    eq(el.code, 'ELIGIBLE', el.reason);
  });

  // ══════════════════════════════════════════════════════════
  // ⑦ 이음매가 끊기는 두 경우 — **여기서 끊겨야 한다**
  // ══════════════════════════════════════════════════════════

  // ⑦-A 계약 없이 나간 진입 (090 이전 경로·다른 전략)
  {
    const db2 = new FakeDb();
    const v2 = baseVenue()
      .on(BN_POS, { json: posRow('0') })
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { json: { orderId: 9003, symbol: SYMBOL, status: 'FILLED',
        executedQty: String(QTY), origQty: String(QTY), avgPrice: '60000' } }, 'POST');
    await scenario(v2, () => enter(db2, { executionIdentity: null, clientOrderId: 'X100-COID-2' }));
    const rows2 = db2.table('live_orders');
    const p2 = managedCandidates(rows2);
    test('⑦-A 계약을 안 적은 진입은 전용 후보가 되지 않는다 — 그래도 유예에 남는다', () => {
      eq(rows2.length, 1);
      eq(rows2[0].execution_profile_id, undefined, '계약이 없으면 칸을 붙이지 않는다');
      eq(p2.authorityCandidates.length, 0, '계약을 모르면 전용 권한에 넘기지 않는다');
      eq(p2.deferred.length, 1, '노출을 인식했다는 기록은 남아야 한다');
    });
  }

  // ⑦-B 체결이 확인되지 않은 진입 (접수만 됨)
  {
    const db3 = new FakeDb();
    const v3 = baseVenue()
      .on(BN_POS, { json: posRow('0') })
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { json: { orderId: 9004, symbol: SYMBOL, status: 'NEW',
        executedQty: '0', origQty: String(QTY), avgPrice: '0' } }, 'POST');
    await scenario(v3, () => enter(db3, { clientOrderId: 'X100-COID-3' }));
    const rows3 = db3.table('live_orders');
    const p3 = managedCandidates(rows3);
    test('⑦-B 체결이 확인되지 않은 주문은 후보가 아니다 (미체결을 보유로 읽지 않는다)', () => {
      eq(rows3.length, 1);
      assert(rows3[0].status !== 'FILLED', `미체결이 FILLED로 적혔다: ${rows3[0].status}`);
      eq(p3.authorityCandidates.length, 0);
    });
  }

  // ⑦-C 포지션을 못 읽으면 **주문 0건**이다
  {
    let sent = 0;
    const v4 = baseVenue()
      .on(BN_POS, { status: 500, json: { code: -1001, msg: 'Internal error' } })
      .on(BN_ORDER, { json: () => { sent += 1; return { orderId: 9005, status: 'FILLED' }; } }, 'POST');
    const r4 = runCandidate == null ? null : await scenario(v4,
      () => runExitAuthority(runCandidate as any, { ...deps, sendClose: async () => {
        sent += 1; return { attempted: true, ok: true, error: null };
      } } as any, (cand?.openedAt ?? 0) + FOUR_HOURS_MS + 1));
    test('★ ⑦-C 노출을 못 읽으면 청산 주문을 보내지 않는다', () => {
      const r: any = r4;
      assert(r != null && !(r instanceof Error), `던졌다: ${(r4 as any)?.message}`);
      eq(sent, 0, '★ 모르는 상태에서 청산이 나갔다');
      eq(r.attemptedWrite, false);
      assert(!String(r.code).startsWith('CLOSED'), `못 읽었는데 ${r.code}로 적혔다`);
    });
  }
}
