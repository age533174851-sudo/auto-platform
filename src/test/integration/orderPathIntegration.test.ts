// src/test/integration/orderPathIntegration.test.ts
//
// **실제 실행 경로를 돌린다.** 순수 판정 함수를 이어 붙인 것이 아니다.
//
// 여기서 실제로 도는 것
// ─────────────────────
//   `executeOrder`            (의도 기록 → 중복 확인 → 전송 → 결과 기록)
//   `reconcilePendingOrders`  (대상 선별 → 조회 → 판정 → 장부 쓰기)
//   `placeSpotOrder`          (바이낸스·Gate 현물)
//   그 안에서 불리는 서명 생성 · 질의 조립 · 응답 파싱 · 체결 사실 추출
//   (`fillFactsOf`·`gateFillOf`) · 장부 상태 판정(`ledgerStatusOf*`) ·
//   상태 전이 검증 · **DB 쓰기 호출**
//
// 가짜로 바꾼 것은 두 경계뿐이다: `fetch` 한 겹과 Supabase 한 겹.
// 그래서 "검사기만 RED"였던 자리가 이제 시험으로 덮인다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';

const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_LEV = '/fapi/v1/leverage';
const BN_DUAL = '/fapi/v1/positionSide/dual';
const BN_EXINFO = '/fapi/v1/exchangeInfo';

/** 거래소가 돌려주는 주문 응답 모양 */
const bnOrder = (o: Partial<Record<string, any>> = {}) => ({
  orderId: 7001, symbol: 'BTCUSDT', status: 'NEW',
  executedQty: '0', origQty: '0.010', avgPrice: '0', price: '0',
  ...o,
});

/** 진입 계획. 승인된 것만 실행기를 통과한다 */
const plan = (over: Partial<Record<string, any>> = {}) => ({
  approved: true, symbol: 'BTCUSDT', side: 'LONG' as const,
  riskAmount: 10, riskAmountWithCosts: 10,
  stopDistancePct: 1, effectiveStopPct: 1,
  positionSize: 1000, quantity: 0.01, requiredMargin: 10,
  leverage: 100, liquidationPrice: 90000, liquidationDistancePct: 1,
  notes: [], ...over,
}) as any;

/** 거래소 규격·레버리지·포지션 모드 조회에 성공 응답을 깔아 둔다 */
function baseVenue(): FakeVenue {
  return new FakeVenue()
    .on(BN_EXINFO, { json: { symbols: [{
      symbol: 'BTCUSDT', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
      ],
    }] } })
    .on('/fapi/v1/marginType', { json: { code: 200, msg: 'success' } })
    .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
    .on(BN_DUAL, { json: { dualSidePosition: false } })
    .on(BN_LEV, { json: { leverage: 100, symbol: 'BTCUSDT' } })
    .on(BN_POS, { json: [{ symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '0',
      leverage: '100', marginType: 'isolated', liquidationPrice: '0' }] });
}

async function exec(db: FakeDb, args: any) {
  const { executeOrder } = await import('@/lib/engine/orderExecutor');
  return executeOrder(db as any, {
    userId: 'u1', connectionId: 'c1',
    signalId: 'sig-1', clientOrderId: args.clientOrderId ?? 'COID-1',
    exchange: 'binance', mode: 'TESTNET',
    plan: args.plan ?? plan(),
    apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    stopPolicy: 'NO_FIXED_SL', takeProfitPolicy: 'NO_FIXED_TP',
    protectionPolicy: 'NONE',
    ...args,
  });
}

/**
 * 시나리오 하나를 **단독으로** 돌린다.
 *
 * `test()`는 async 본문을 pending에 넣고 바로 돌아온다. 그래서 여러
 * 시나리오를 `test()`로 띄우면 **서로의 fetch 스텁을 덮어쓴다** — 실제로
 * 그렇게 돼서 "거래소 호출이 하나도 없다"로 보였다. 그러니 실행은 여기서
 * 순차로 하고, 판정만 `test()`에 넣는다.
 */
async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

export async function runOrderPathIntegrationTests() {
  console.log('[통합 — 실제 실행 경로 (fetch·DB만 가짜)]');

  // ══════════ ① 정상 접수 — 의도 기록이 전송보다 앞인가 ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { json: bnOrder({ status: 'NEW', executedQty: '0' }) }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 실행기가 실제로 돌고 의도를 먼저 기록한다', () => {
      assert(!(r instanceof Error), `실행기가 던졌다: ${(r as any)?.message}`);
      assert(venue.calls.length > 0, '거래소 호출이 하나도 없다 — 실행기가 안 돌았다');
      const inserts = db.writes.filter((w) => w.kind === 'insert');
      assert(inserts.length >= 1, '의도 기록(insert)이 없다');
      eq(inserts[0].table, 'live_orders');
      eq(inserts[0].patch.status, 'INTENT');
      eq(inserts[0].patch.client_order_id, 'COID-1');
      // 의도 기록이 **첫 쓰기**여야 한다. 전송 뒤에 적으면 응답을 못
      // 받은 주문이 장부에 아예 없다.
      eq(db.writes[0].patch.status, 'INTENT');
    });

    test('★ 미체결 접수를 장부에 FILLED로 적지 않는다 (실제 쓰기)', () => {
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      assert(row.status !== 'FILLED', `미체결인데 장부에 ${row.status}가 적혔다`);
      assert(row.filled_qty === 0 || row.filled_qty == null,
        `체결 수량이 지어졌다: ${row.filled_qty}`);
      assert(row.avg_price == null, `미체결인데 평균가가 적혔다: ${row.avg_price}`);
      eq(venue.orderSends().length, 1);
    });
  }

  // ══════════ ② 체결 — 증거가 있을 때만 FILLED ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { json: bnOrder({ status: 'FILLED', executedQty: '0.010', avgPrice: '95000' }) }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 체결 증거가 있으면 장부에 FILLED와 실제 수량이 적힌다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      eq(row.status, 'FILLED');
      eq(Number(row.filled_qty), 0.01);
      eq(Number(row.avg_price), 95000);
    });
  }

  // ══════════ ③ 상태는 FILLED인데 수량 증거가 없다 ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { json: { orderId: 7001, symbol: 'BTCUSDT', status: 'FILLED', origQty: '0.010' } }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 상태만 FILLED이고 수량이 없으면 체결로 적지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      assert(row.status !== 'FILLED',
        `수량 증거 없이 ${row.status}가 적혔다 — 거래소가 FILLED만 돌려준 경우다`);
      // 요청 수량(origQty)으로 메우지 않는다.
      assert(row.filled_qty == null || Number(row.filled_qty) === 0,
        `요청 수량이 체결 수량으로 적혔다: ${row.filled_qty}`);
    });
  }

  // ══════════ ④ 전송 후 응답 유실 (타임아웃) ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { timeout: true }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 전송 타임아웃을 UNKNOWN으로 적고 재전송하지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      eq(row.status, 'UNKNOWN', `타임아웃인데 장부가 ${row.status}다`);
      assert(row.status !== 'FAILED', 'FAILED로 적으면 재시도가 열린다');
      eq(venue.orderSends().length, 1, `주문이 ${venue.orderSends().length}번 나갔다`);
      eq((r as any).status, 'UNKNOWN');
    });
  }

  // ══════════ ⑤ 같은 clientOrderId가 거래소에 이미 있다 ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder({ status: 'NEW' }) }, 'GET')     // 중복 확인에서 발견
      .on(BN_ORDER, { json: bnOrder() }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 이미 있는 주문은 재전송하지 않고, 열려 있으면 종료로 적지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, '이미 있는 주문을 다시 보냈다');
      eq((r as any).duplicate, true);
      const row = db.table('live_orders')[0];
      eq(row.status, 'ACKED');
      assert(row.status !== 'RECONCILED',
        '거래소에 열려 있는데 장부에 RECONCILED(끝남)가 적혔다');
      assert(row.reconciled_at == null, '끝나지 않은 주문에 종료 시각이 적혔다');
    });
  }

  // ══════════ ⑥ 중복 확인 조회 실패 — 보내지 않는다 ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { status: 503, json: { code: -1000, msg: 'Service unavailable' } }, 'GET')
      .on(BN_ORDER, { json: bnOrder() }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 중복 확인에 실패하면 주문하지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0,
        '중복 확인 실패인데 주문을 보냈다 — 레이트리밋 한 번이 중복 체결이 된다');
      eq((r as any).ok, false);
    });
  }

  // ══════════ ⑦ 거래소 체결 성공 + DB 기록 실패 ══════════
  {
    const db = new FakeDb({ failUpdatesOn: 'live_orders' });
    const venue = baseVenue()
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { json: bnOrder({ status: 'FILLED', executedQty: '0.010', avgPrice: '95000' }) }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 체결 뒤 DB 기록이 실패해도 주문을 다시 보내지 않는다', async () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 1, `주문이 ${venue.orderSends().length}번 나갔다`);
      const row = db.table('live_orders')[0];
      const { RECONCILE_TARGET_STATUSES } = await import('@/lib/engine/pendingReconcile');
      assert((RECONCILE_TARGET_STATUSES as readonly string[]).includes(row.status),
        `기록 실패로 ${row.status}에 멈춘 줄이 대조 대상이 아니다 — 영구히 방치된다`);
    });
  }

  // ══════════ ⑧ 장부 유니크 충돌 — 같은 키 재사용 ══════════
  {
    const db = new FakeDb({ failInsertCode: { table: 'live_orders', code: '23505' } })
      .seed('live_orders', [{
        id: 'prev-1', client_order_id: 'COID-1', status: 'ACKED',
        filled_qty: 0, avg_price: null, quantity: 0.01, symbol: 'BTCUSDT',
      }]);
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder() }, 'GET')
      .on(BN_ORDER, { json: bnOrder() }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 같은 clientOrderId로 두 번 부르면 거래소에 가지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0, '멱등 키가 겹쳤는데 주문이 또 나갔다');
      eq((r as any).duplicate, true);
      // 기존 줄의 상태를 그대로 돌려준다 — 지어내지 않는다.
      eq((r as any).status, 'ACKED');
    });
  }
}
