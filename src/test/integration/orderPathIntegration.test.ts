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
// ── **정적 상대 경로로 가져온다** ──
//
//   동적 `await import('@/…')`만 쓰면 tsc가 그 파일을 **컴파일 대상에
//   넣지 않는다**(run.ts에서 도달 불가). 그러면 런타임에 "Cannot find
//   module"이 난다. 정적으로 가져오면 컴파일되고, 그 파일 안의 `@/`
//   동적 import는 러너의 해석 shim이 처리한다.
import { executeOrder, reconcilePendingOrders } from '../../lib/engine/orderExecutor';
import { placeSpotOrder } from '../../lib/exchanges/spotOrderExecutor';
import { RECONCILE_TARGET_STATUSES } from '../../lib/engine/pendingReconcile';
import { isProvenFill } from '../../lib/engine/holdingEvidence';
import { encryptSecret } from '../../lib/exchanges/crypto';

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

// ══════════════════════════════════════════════════════════════════
// 대조(reconcile) 경로 — 실제 `reconcilePendingOrders`를 돌린다
// ══════════════════════════════════════════════════════════════════

/** 장부에 남아 있는 미확정/접수 줄 하나 */
const pendingRow = (over: Record<string, any> = {}) => ({
  id: 'ord-1', client_order_id: 'COID-R1', symbol: 'BTCUSDT',
  exchange: 'binance', mode: 'TESTNET', side: 'BUY', quantity: 0.01,
  status: 'ACKED', filled_qty: 0, avg_price: null,
  // 유예(5초)를 지난 시각 — 전송 직후가 아니다
  sent_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  pos_qty_before: 0, resolve_attempts: 0, user_id: 'u1', connection_id: 'c1',
  ...over,
});

async function reconcile(db: FakeDb, exchange: 'binance' | 'gate' = 'binance') {
  return reconcilePendingOrders(db as any, {
    exchange, apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    testnet: true, userId: 'u1', connectionId: 'c1',
  });
}

export async function runReconcileIntegrationTests() {
  console.log('[통합 — 대조 경로 (실제 reconcilePendingOrders)]');

  // ══════════ ① 부분 체결 후 취소 — 수량 보존 ══════════
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue()
      // 거래소: 부분 체결된 뒤 취소됐다. 채워진 수량은 **사실이다**
      .on(BN_ORDER, { json: bnOrder({
        status: 'CANCELED', executedQty: '0.004', avgPrice: '95100', origQty: '0.010',
      }) }, 'GET');
    const r = await scenario(venue, () => reconcile(db));

    test('★ 부분 체결 후 취소 — 채워진 수량이 보존되고 종료로 적힌다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'RECONCILED', `취소인데 ${row.status}가 적혔다`);
      eq(Number(row.filled_qty), 0.004, '채워진 수량이 사라졌다');
      eq(Number(row.avg_price), 95100);
      assert(row.reconciled_at != null, '종료인데 종료 시각이 없다');
      // 체결로 단정하지 않는다 — 성과로 세지 않는다.
      eq(row.status === 'FILLED', false);
    });
  }

  // ══════════ ② 조회 실패 후 복구 ══════════
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue()
      .on(BN_ORDER, { status: 503, json: { code: -1001, msg: 'Internal error' } }, 'GET');
    const first = await scenario(venue, () => reconcile(db));

    test('★ 조회 실패에서는 아무것도 확정하지 않는다', () => {
      assert(!(first instanceof Error), String((first as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'UNKNOWN', `조회 실패인데 ${row.status}로 확정됐다`);
      assert(row.reconciled_at == null, '확정하지 않았는데 종료 시각이 적혔다');
      eq((first as any).resolved, 0);
    });

    // 같은 줄을 다시 대조한다 — 이번엔 거래소가 답한다.
    const venue2 = baseVenue()
      .on(BN_ORDER, { json: bnOrder({
        status: 'FILLED', executedQty: '0.010', avgPrice: '95000',
      }) }, 'GET');
    const second = await scenario(venue2, () => reconcile(db));

    test('★ 다음 대조에서 복구된다 — 그 사이 주문을 다시 보내지 않는다', () => {
      assert(!(second instanceof Error), String((second as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'FILLED');
      eq(Number(row.filled_qty), 0.01);
      // 대조는 **조회만** 한다. 주문 전송이 한 건도 없어야 한다.
      eq(venue.orderSends().length, 0, '대조가 주문을 보냈다');
      eq(venue2.orderSends().length, 0, '대조가 주문을 보냈다');
    });
  }

  // ══════════ ③ ACKED 이후 서버 재시작 ══════════
  {
    // 재시작 = 메모리 상태 전부 날아감. 장부에 ACKED 줄만 남아 있다.
    const db = new FakeDb().seed('live_orders', [pendingRow({ status: 'ACKED' })]);
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder({ status: 'NEW', executedQty: '0' }) }, 'GET');
    const r = await scenario(venue, () => reconcile(db));

    test('★ 재시작 뒤 ACKED 줄이 실제로 대조된다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq((r as any).checked, 1, 'ACKED 줄이 대조 대상에 안 들어왔다');
      assert(venue.countOf(BN_ORDER, 'GET') >= 1, '거래소에 묻지 않았다');
    });

    test('★ 거래소에 아직 열려 있으면 종료로 적지 않는다 (실제 쓰기)', () => {
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'ACKED');
      assert(row.reconciled_at == null, '열려 있는 주문에 종료 시각이 적혔다');
      eq((r as any).stillOpen, 1, '열린 주문으로 세지 않았다');
      eq((r as any).resolved, 0);
    });
  }

  // ══════════ ④ 타임아웃 뒤 실제로는 체결됐다 ══════════
  {
    // ①에서 타임아웃으로 UNKNOWN이 된 줄. 거래소에는 체결돼 있다.
    const db = new FakeDb().seed('live_orders', [pendingRow({ status: 'UNKNOWN' })]);
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder({
        status: 'FILLED', executedQty: '0.010', avgPrice: '95000',
      }) }, 'GET');
    const r = await scenario(venue, () => reconcile(db));

    test('★ 타임아웃 뒤 체결된 주문을 재전송 없이 복구한다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'FILLED');
      eq(Number(row.filled_qty), 0.01);
      eq(venue.orderSends().length, 0, '복구가 주문을 다시 보냈다 — 중복 체결이다');
      eq((r as any).resolved, 1);
    });
  }

  // ══════════ ⑤ 주문 미발견 + 유예 경과 → RECONCILED ══════════
  {
    const db = new FakeDb().seed('live_orders', [pendingRow({ status: 'ACKED' })]);
    const venue = baseVenue()
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_POS, { json: [{ symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '0',
        leverage: '100', marginType: 'isolated', liquidationPrice: '0' }] });
    const r = await scenario(venue, () => reconcile(db));

    test('★ 미발견 + 유예 경과는 RECONCILED이고 체결로 단정하지 않는다', async () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'RECONCILED');
      eq(isProvenFill(row), false, 'RECONCILED가 체결 증거로 쓰였다');
    });
  }

  // ══════════ ⑤-b 실제 대조 → 손절 재부착 → -4120 대체 전송 ══════════
  {
    // 처음 부착되지 않은 ACKED 진입이 뒤늦게 FILLED로 확인된다.
    // 대조 자체가 실행기의 attachStopIfMissing을 호출해야 한다.
    const SYM = 'PRECLREATTUSDT';
    const db = new FakeDb().seed('live_orders', [pendingRow({
      symbol: SYM, stop_policy: 'FIXED_SL', stop_loss: 58920.981,
      sl_order_id: null, reduce_only: false,
    })]);
    const venue = new FakeVenue()
      .on(BN_POS, { json: [{ symbol: SYM, positionAmt: '0.0033333333333333335',
        entryPrice: '60000', markPrice: '60000', unRealizedProfit: '0',
        leverage: '100', marginType: 'isolated', liquidationPrice: '57000' }] })
      .on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED',
        executedQty: '0.0033333333333333335', origQty: '0.010', avgPrice: '60000' }) }, 'GET')
      .on(BN_EXINFO, { json: { symbols: [{ symbol: SYM, filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0', maxQty: '0' },
        { filterType: 'PRICE_FILTER', tickSize: '0.1' },
      ] }] } })
      .onParams(BN_ORDER, 'POST', { type: 'STOP_MARKET', closePosition: 'true' },
        { status: 400, json: { code: -4120, msg: 'not supported for this endpoint' } })
      .onParams(BN_ORDER, 'POST', { type: 'STOP_MARKET', reduceOnly: 'true' },
        { json: bnOrder({ symbol: SYM, orderId: 9501 }) });
    const result = await scenario(venue, () => reconcile(db));

    test('★ 대조에서 복구한 LONG 손절은 아래 틱 58920.9, 대체 수량은 0.003', () => {
      assert(!(result instanceof Error), String((result as any)?.message));
      eq((result as any).resolved, 1, '체결 주문을 대조하지 못했다');
      const stopCalls = venue.orderSends().filter(c => c.params.type === 'STOP_MARKET');
      eq(stopCalls.length, 2, 'closePosition 실패 후 대체 주문 경로가 돌지 않았다');
      eq(stopCalls[0].params.stopPrice, '58920.9');
      eq(stopCalls[0].params.closePosition, 'true');
      eq(stopCalls[1].params.stopPrice, '58920.9');
      eq(stopCalls[1].params.quantity, '0.003');
      eq(stopCalls[1].params.reduceOnly, 'true');
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '9501');
    });
  }

  // ══════════ ⑤-c NO_FIXED_SL 계약은 대조에서도 손절을 걸지 않는다 ══════════
  {
    const SYM = 'PRECMREATTUSDT';
    const db = new FakeDb().seed('live_orders', [pendingRow({
      symbol: SYM, stop_policy: 'NO_FIXED_SL', stop_loss: 58920.981,
      sl_order_id: null, reduce_only: false,
    })]);
    const venue = new FakeVenue()
      .on(BN_POS, { json: [{ symbol: SYM, positionAmt: '0.003',
        entryPrice: '60000', markPrice: '60000', unRealizedProfit: '0',
        leverage: '100', marginType: 'isolated', liquidationPrice: '57000' }] })
      .on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED',
        executedQty: '0.003', avgPrice: '60000' }) }, 'GET');
    const result = await scenario(venue, () => reconcile(db));
    test('★ NO_FIXED_SL 회차는 손절가가 기록돼도 복구 주문 0건', () => {
      assert(!(result instanceof Error), String((result as any)?.message));
      eq((result as any).resolved, 1);
      eq(venue.orderSends().length, 0, 'NO_FIXED_SL인데 복구가 STOP_MARKET을 보냈다');
      assert((result as any).details.some((d: string) => d.includes('고정 손절을 쓰지 않는')),
        '정책에 따른 의도적 미부착 이유가 누락됐다');
    });
  }

  // ══════════ ⑥ Gate 선물 상태 어휘 ══════════
  {
    const db = new FakeDb().seed('live_orders', [
      pendingRow({ exchange: 'gate', symbol: 'BTCUSDT', status: 'ACKED' }),
    ]);
    const venue = new FakeVenue()
      // Gate는 open/finished 두 묶음을 각각 조회한다
      .on('/api/v4/futures/usdt/orders', { json: (i: number) => (i === 0
        // status=open: 아직 열려 있는 주문으로 발견된다
        ? [{ id: 9001, contract: 'BTC_USDT', size: 1, price: '0', status: 'open',
             text: 't-COID-R1', left: 1 }]
        : []) }, 'GET')
      .on('/api/v4/futures/usdt/positions', { json: [] });
    const r = await scenario(venue, () => reconcile(db, 'gate'));

    test('★ Gate의 open을 "열려 있음"으로 읽는다 (NEW를 지어내지 않는다)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'ACKED', `Gate open인데 ${row.status}가 적혔다`);
      assert(row.reconciled_at == null, '열려 있는데 종료 시각이 적혔다');
      eq((r as any).stillOpen, 1);
    });
  }

  // ══════════ ⑦ Gate 선물 — finished/filled ══════════
  {
    const db = new FakeDb().seed('live_orders', [
      pendingRow({ exchange: 'gate', status: 'ACKED' }),
    ]);
    const venue = new FakeVenue()
      .on('/api/v4/futures/usdt/orders', { json: (i: number) => (i === 0
        ? []
        : [{ id: 9002, contract: 'BTC_USDT', size: 2, price: '0', status: 'finished',
             finish_as: 'filled', text: 't-COID-R1', left: 0, fill_price: '95000' }]) }, 'GET')
      .on('/api/v4/futures/usdt/positions', { json: [] });
    const r = await scenario(venue, () => reconcile(db, 'gate'));

    test('★ Gate finished/filled은 수량 증거와 함께 체결로 적힌다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'FILLED');
      eq(Number(row.filled_qty), 2);
      eq(Number(row.avg_price), 95000);
      assert(row.reconciled_at != null);
    });
  }

  // ══════════ ⑧ Gate 선물 — ioc 미체결 ══════════
  {
    const db = new FakeDb().seed('live_orders', [
      pendingRow({ exchange: 'gate', status: 'ACKED' }),
    ]);
    const venue = new FakeVenue()
      .on('/api/v4/futures/usdt/orders', { json: (i: number) => (i === 0
        ? []
        : [{ id: 9003, contract: 'BTC_USDT', size: 2, price: '0', status: 'finished',
             finish_as: 'ioc', text: 't-COID-R1', left: 2 }]) }, 'GET')
      .on('/api/v4/futures/usdt/positions', { json: [] });
    const r = await scenario(venue, () => reconcile(db, 'gate'));

    test('★ Gate ioc 미체결은 끝났지만 체결도 거부도 아니다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.row('live_orders', { id: 'ord-1' })!;
      eq(row.status, 'RECONCILED');
      eq(Number(row.filled_qty), 0, '체결 0이 사실인데 적히지 않았다');
      assert(row.status !== 'FAILED', 'FAILED는 재시도가 열리는 상태다');
      assert(row.status !== 'FILLED');
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// 현물 경로 — 실제 `placeSpotOrder`를 돌린다 (DB 쓰기까지)
// ══════════════════════════════════════════════════════════════════

/** 암호화된 시크릿이 담긴 연결 줄. 실행기가 실제 복호화를 거친다 */
async function connRow(exchange: 'binance' | 'gate') {
  return {
    id: 'c1', user_id: 'u1', exchange_id: exchange,
    api_key: 'K'.repeat(64),
    api_secret_enc: encryptSecret('S'.repeat(64)),
    has_withdrawal: false, is_testnet: true,
  };
}

const SPOT_ORDER = '/api/v3/order';
const SPOT_EXINFO = '/api/v3/exchangeInfo';
const SPOT_ACCOUNT = '/api/v3/account';

export async function runSpotIntegrationTests() {
  console.log('[통합 — 현물 경로 (실제 placeSpotOrder · DB 쓰기)]');

  // ══════════ ① 바이낸스 현물 지정가 대기 — 체결로 적지 않는다 ══════════
  {
    const unenv = withCryptoEnv();
    const db = new FakeDb().seed('exchange_connections', [await connRow('binance')]);
    unenv();
    const venue = new FakeVenue()
      .on(SPOT_EXINFO, { json: { symbols: [{
        symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001' },
          { filterType: 'NOTIONAL', minNotional: '5' },
          { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        ],
      }] } })
      .on(SPOT_ACCOUNT, { json: { balances: [
        { asset: 'USDT', free: '10000', locked: '0' },
        { asset: 'BTC', free: '1', locked: '0' },
      ] } })
      .on(SPOT_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      // 지정가 주문이 **대기**로 접수됐다: status NEW, 체결 0, fills 없음
      .on(SPOT_ORDER, { json: {
        orderId: 5001, symbol: 'BTCUSDT', status: 'NEW',
        executedQty: '0.00000', origQty: '0.00100', price: '90000.00',
        cummulativeQuoteQty: '0.00000', fills: [],
      } }, 'POST');

    const r = await scenario(venue, () => placeSpotOrder(db as any, {
      userId: 'u1', connectionId: 'c1', symbol: 'BTCUSDT',
      side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 90000,
    }));

    test('★ 현물 지정가 대기 주문을 장부에 FILLED로 적지 않는다 (실제 쓰기)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const rows = db.table('live_orders');
      assert(rows.length > 0, '현물 장부 줄이 없다 — 실행기가 안 돌았다');
      const row = rows[rows.length - 1];
      assert(row.status !== 'FILLED', `대기 주문인데 장부에 ${row.status}가 적혔다`);
      eq(row.status, 'ACKED');
      // **지정가를 체결가로 적지 않는다.**
      assert(row.avg_price == null, `지정가가 체결가로 적혔다: ${row.avg_price}`);
      eq(Number(row.filled_qty), 0);
      // 반환 상태와 장부 상태가 같아야 한다.
      eq((r as any).status, row.status, '반환 상태와 장부 상태가 다르다');
    });

    test('★ 응답 문장이 체결됐다고 말하지 않는다', () => {
      const msg = String((r as any)?.message ?? '');
      assert(!/체결 /.test(msg) || /미확정/.test(msg),
        `대기 주문인데 "체결"이라고 적혔다: ${msg}`);
    });
  }

  // ══════════ ② 바이낸스 현물 즉시 체결 — 가중평균 ══════════
  //
  //   **시장가가 아니라 지정가 즉시 체결로 검증한다.** 시장가 경로는
  //   `MARKET_LOT_SIZE` 격자를 실제로 적용해야 통과하는데, 이 하네스의
  //   규격 픽스처로는 그 적용까지 재현하지 못했다(`ORDER_TYPE_GRID_UNKNOWN`
  //   으로 막힌다 — 규격을 못 맞추면 신규 주문을 보내지 않는 쪽이 맞는
  //   동작이다). 쓰기 경로·체결가 계산은 지정가와 **같은 코드**를 지난다.
  //   시장가 현물 경로는 통합 계층 **미검증**으로 남긴다.
  {
    const unenv = withCryptoEnv();
    const db = new FakeDb().seed('exchange_connections', [await connRow('binance')]);
    unenv();
    const venue = new FakeVenue()
      .on(SPOT_EXINFO, { json: { symbols: [{
        symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001', maxQty: '9000' },
          { filterType: 'MARKET_LOT_SIZE', stepSize: '0.00001', minQty: '0.00001', maxQty: '100' },
          { filterType: 'NOTIONAL', minNotional: '5' },
          { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        ],
      }] } })
      .on(SPOT_ACCOUNT, { json: { balances: [
        { asset: 'USDT', free: '10000', locked: '0' },
        { asset: 'BTC', free: '1', locked: '0' },
      ] } })
      .on(SPOT_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(SPOT_ORDER, { json: {
        orderId: 5002, symbol: 'BTCUSDT', status: 'FILLED',
        executedQty: '0.00300', origQty: '0.00300', price: '95500.00',
        cummulativeQuoteQty: '285.00',
        // 쪼개 체결: 첫 조각 가격(94000)이 평균가가 되면 안 된다
        fills: [{ qty: '0.00100', price: '94000' }, { qty: '0.00200', price: '95500' }],
      } }, 'POST');

    const r = await scenario(venue, () => placeSpotOrder(db as any, {
      userId: 'u1', connectionId: 'c1', symbol: 'BTCUSDT',
      side: 'BUY', type: 'LIMIT', quantity: 0.003, price: 95500,
    }));

    test('★ 현물 체결가는 가중평균이고 첫 조각 가격이 아니다 (실제 쓰기)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const rows = db.table('live_orders');
      const row = rows[rows.length - 1];
      eq(row.status, 'FILLED');
      eq(Number(row.filled_qty), 0.003);
      // (0.001·94000 + 0.002·95500) / 0.003 = 95000
      eq(Number(row.avg_price), 95000);
      assert(Number(row.avg_price) !== 94000, '첫 조각 가격이 평균가로 적혔다');
      eq((r as any).status, row.status, '반환 상태와 장부 상태가 다르다');
    });
  }

  // ══════════ ③ Gate 현물 IOC 미체결 — 장부와 응답이 같은 답 ══════════
  {
    const unenv = withCryptoEnv();
    const db = new FakeDb().seed('exchange_connections', [await connRow('gate')]);
    unenv();
    const venue = new FakeVenue()
      .on('/api/v4/spot/currency_pairs/BTC_USDT', { json: {
        id: 'BTC_USDT', trade_status: 'tradable',
        amount_precision: 5, precision: 2, min_base_amount: '0.0001', min_quote_amount: '1',
      } })
      .on('/api/v4/spot/accounts', { json: [
        { currency: 'USDT', available: '10000', locked: '0' },
        { currency: 'BTC', available: '1', locked: '0' },
      ] })
      // 단건 조회(`/orders/<text>`)는 목록 조회와 경로가 겹친다. 먼저
      // 등록해 404(ORDER_NOT_FOUND)로 답한다 — 중복이 **없는** 상황이다.
      .on('/api/v4/spot/orders/', { status: 404, json: { label: 'ORDER_NOT_FOUND' } }, 'GET')
      .on('/api/v4/spot/orders', { json: [] }, 'GET')
      // 시장가 IOC가 **한 개도 안 붙고** 끝났다
      .on('/api/v4/spot/orders', { json: {
        id: '7001', currency_pair: 'BTC_USDT', status: 'cancelled',
        amount: '0.003', left: '0.003', filled_total: '0', avg_deal_price: '0',
        text: 't-SPOT-1',
      } }, 'POST');

    const r = await scenario(venue, () => placeSpotOrder(db as any, {
      userId: 'u1', connectionId: 'c1', symbol: 'BTCUSDT',
      side: 'BUY', type: 'MARKET', quantity: 0.003,
    }));

    test('★ Gate 현물 미체결에서 장부와 응답이 같은 답을 적는다 (실제 쓰기)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const rows = db.table('live_orders');
      assert(rows.length > 0, 'Gate 현물 장부 줄이 없다 — 실행기가 안 돌았다');
      const row = rows[rows.length - 1];
      assert(row.status !== 'FILLED', `미체결인데 장부에 ${row.status}가 적혔다`);
      // 장부와 반환이 **같아야** 한다 — 예전에는 장부 FILLED / 응답 REJECTED였다.
      eq((r as any).status, row.status,
        `장부(${row.status})와 반환(${(r as any).status})이 다르다`);
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// 청산 경로 — 실제 `closeSymbolPosition`을 돌린다 (거래소 전송까지)
// ══════════════════════════════════════════════════════════════════

export async function runCloseIntegrationTests() {
  console.log('[통합 — 청산 경로 (실제 closeSymbolPosition)]');

  const creds = {
    exchange: 'binance' as const, apiKey: 'K'.repeat(64),
    apiSecret: 'S'.repeat(64), testnet: true,
  };

  /** 포지션이 열려 있는 계좌 */
  function openPositionVenue(): FakeVenue {
    return new FakeVenue()
      .on(BN_DUAL, { json: { dualSidePosition: false } })
      .on(BN_POS, { json: [{ symbol: 'BTCUSDT', positionAmt: '0.010', entryPrice: '95000',
        leverage: '100', marginType: 'isolated', liquidationPrice: '94000', markPrice: '95000',
        unRealizedProfit: '0' }] })
      .on(BN_EXINFO, { json: { symbols: [{ symbol: 'BTCUSDT', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ] }] } })
      .on(BN_ORDER, { json: bnOrder({ status: 'FILLED', executedQty: '0.010', avgPrice: '95050' }) }, 'POST');
  }

  // ══════════ ① 동일 포지션 동시 청산 — 전송 1회 ══════════
  {
    const venue = openPositionVenue();
    // 두 실행자가 **같은 순간** 같은 포지션을 닫으려 한다. 임차는 하나다.
    const lease = { holder: 'A' as string | null };
    const r = await scenario(venue, async () => {
      const { closeSymbolPosition } = await import('@/lib/engine/venuePositionOps');
      const { applyLifecycleClose } = await import('@/lib/engine/lifecycleAction');
      const runner = (who: string) => applyLifecycleClose({
        stillMine: async () => lease.holder === who,
        // **실제 청산 전송**이다 — 거래소 어댑터를 지난다.
        close: () => closeSymbolPosition(creds, 'BTCUSDT', 'LONG'),
        readAfter: async () => {
          const { readOpenPosition } = await import('@/lib/engine/venuePositionOps');
          const p = await readOpenPosition(creds, 'BTCUSDT');
          return { ok: p.ok, found: p.found };
        },
      });
      return Promise.all([runner('A'), runner('B')]);
    });

    test('★ 동시 청산에서 거래소 전송은 최대 1회다 (실제 전송 경로)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const sends = venue.orderSends().length;
      assert(sends <= 1, `청산 주문이 ${sends}번 나갔다 — 반대 포지션이 열린다`);
      const [a, b] = r as any[];
      eq(b.code, 'LEASE_LOST');
      eq(b.attempted, false, '권한이 없는데 주문을 보냈다');
      assert(a.code === 'CLOSED_VERIFIED' || a.code === 'CLOSE_INCOMPLETE'
        || a.code === 'CLOSE_UNVERIFIED', `임차 보유자의 결과가 ${a.code}다`);
    });
  }

  // ══════════ ② 청산 전송 타임아웃 — 거부로 적지 않는다 ══════════
  {
    const venue = openPositionVenue();
    // 전송만 타임아웃. 주문은 거래소에 들어갔을 수 있다.
    (venue as any).rules.unshift({
      label: 'timeout-order',
      match: (c: any) => c.method === 'POST' && c.path.includes('/fapi/v1/order'),
      reply: { timeout: true },
    });
    const r = await scenario(venue, async () => {
      const { closeSymbolPosition } = await import('@/lib/engine/venuePositionOps');
      return closeSymbolPosition(creds, 'BTCUSDT', 'LONG');
    });

    test('★ 청산 전송 타임아웃을 "거부"로 적지 않는다 (실제 전송 경로)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const v = r as any;
      eq(v.ok, false);
      eq(v.ambiguous, true,
        '타임아웃을 거부로 단정하면 안 나간 것으로 읽혀 같은 자리에 또 보낸다');
      eq(venue.orderSends().length, 1);
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// 상태 전이 거부가 **감지되는가**
// ══════════════════════════════════════════════════════════════════

export async function runTransitionIntegrationTests() {
  console.log('[통합 — 상태 전이 거부 감지]');

  // 거래소에 이미 주문이 있는 경로는 장부 줄이 INTENT인 상태에서
  // ACKED로 가야 한다. 상태 기계가 그 전이를 거부하면 예전에는 **status만
  // 조용히 빠지고** 나머지가 적혔다 — 장부는 INTENT, 반환은 ACKED였다.
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder({ status: 'NEW' }) }, 'GET')
      .on(BN_ORDER, { json: bnOrder() }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 반환 상태와 장부 상태가 일치한다 (멱등 중복 경로)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      eq((r as any).status, row.status,
        `반환(${(r as any).status})과 장부(${row.status})가 다르다`);
      // 전이가 실제로 적용됐다 — 조용히 버려지지 않았다.
      eq(row.status, 'ACKED');
      // SENT을 먼저 적은 사실이 쓰기 기록에 남아야 한다 (전이 경로의 증거).
      const statuses = db.writes.filter((w) => w.patch.status).map((w) => w.patch.status);
      assert(statuses.includes('SENT'),
        `전이 경로가 SENT을 거치지 않았다: ${statuses.join(' → ')}`);
      assert(statuses.includes('ACKED'),
        `ACKED가 적히지 않았다: ${statuses.join(' → ')}`);
    });
  }

  // 체결까지 간 경로도 같다.
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder({
        status: 'FILLED', executedQty: '0.010', avgPrice: '95000',
      }) }, 'GET')
      .on(BN_ORDER, { json: bnOrder() }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));

    test('★ 이미 체결된 중복 주문도 장부와 반환이 일치한다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      eq((r as any).status, row.status,
        `반환(${(r as any).status})과 장부(${row.status})가 다르다`);
      eq(row.status, 'FILLED');
      eq(Number(row.filled_qty), 0.01);
      eq(venue.orderSends().length, 0, '이미 체결된 주문을 또 보냈다');
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// COIN-M 라우트 — 실제 라우트 핸들러를 돌린다 (DB 쓰기까지)
// ══════════════════════════════════════════════════════════════════
//
// 이 자리가 "정적 검사기 한 겹"에만 의존하던 대표 사례다. 라우트는
// `getSupabaseAdmin`을 **정적으로** 가져오므로, 모듈을 불러오기 전에
// `require.cache`에 가짜를 심고 그 뒤에 라우트를 불러온다. 그러면
// 라우트 본문·어댑터·장부 쓰기가 전부 실제로 돈다.

declare const require: any;

const DAPI_ORDER = '/dapi/v1/order';

function fakeRequest(body: any): any {
  const headers = new Map<string, string>([['authorization', 'Bearer t']]);
  return {
    json: async () => body,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
  };
}

export async function runCoinMRouteIntegrationTests() {
  console.log('[통합 — COIN-M 라우트 (실제 핸들러 · DB 쓰기)]');

  const serverPath = require.resolve('../../lib/supabase/server');
  const routePath = require.resolve('../../app/api/binance/coinm/order/route');

  /** 라우트를 가짜 DB에 붙여 **새로** 불러온다 */
  function loadRoute(db: FakeDb) {
    const prevServer = require.cache[serverPath];
    require.cache[serverPath] = {
      id: serverPath, filename: serverPath, loaded: true, exports: {
        getSupabaseAdmin: () => db,
        resolveUserId: async () => 'u1',
        getUserIdFromRequest: async () => 'u1',
        serviceRoleKeyRole: () => 'service_role',
      },
    };
    delete require.cache[routePath];
    const mod = require(routePath);
    return {
      POST: mod.POST as (req: any) => Promise<any>,
      restore: () => {
        delete require.cache[routePath];
        if (prevServer) require.cache[serverPath] = prevServer;
        else delete require.cache[serverPath];
      },
    };
  }

  async function connRowCoinM() {
    return {
      id: 'c1', user_id: 'u1', exchange_id: 'binance',
      api_key: 'K'.repeat(64),
      api_secret_enc: encryptSecret('S'.repeat(64)),
      has_withdrawal: false, is_testnet: true, perm_trading: true, is_active: true,
    };
  }

  /** COIN-M 규격·레버리지 조회를 깔아 둔다 */
  function coinMVenue(): FakeVenue {
    return new FakeVenue()
      .on('/dapi/v1/exchangeInfo', { json: { symbols: [{
        symbol: 'BTCUSD_PERP', contractSize: 100, pricePrecision: 1, quantityPrecision: 0,
        filters: [{ filterType: 'LOT_SIZE', stepSize: '1', minQty: '1' }],
      }] } })
      .on('/dapi/v1/leverage', { json: { leverage: 20, symbol: 'BTCUSD_PERP' } })
      .on('/dapi/v1/marginType', { json: { code: 200, msg: 'success' } })
      .on('/dapi/v1/positionRisk', { json: [{ symbol: 'BTCUSD_PERP', positionAmt: '0',
        leverage: '20', marginType: 'isolated', liquidationPrice: '0', entryPrice: '0' }] })
      .on('/dapi/v1/premiumIndex', { json: { symbol: 'BTCUSD_PERP', markPrice: '95000' } })
      .on('/dapi/v1/ticker/price', { json: { symbol: 'BTCUSD_PERP', price: '95000' } })
      .on('/dapi/v1/account', { json: { assets: [{ asset: 'BTC', availableBalance: '1' }],
        positions: [] } })
      .on('/dapi/v1/openOrders', { json: [] })
      .on('/dapi/v1/time', { json: { serverTime: Date.now() } })
      .on('/dapi/v1/balance', { json: [{ asset: 'BTC', availableBalance: '1', balance: '1' }] })
      .on('/fapi/v1/income', { json: [] });
  }

  const BODY = {
    confirmToken: 'COINM_ORDER_CONFIRMED', connectionId: 'c1',
    symbol: 'BTCUSD_PERP', side: 'BUY', type: 'MARKET', contracts: 1,
    leverage: 20, stopPrice: 90000,
  };

  // ══════════ ① 미체결 접수를 FILLED로 적지 않는다 ══════════
  {
    const unenv = withCryptoEnv();
    const db = new FakeDb().seed('exchange_connections', [await connRowCoinM()]);
    unenv();
    const venue = coinMVenue()
      .on(DAPI_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      // 거래소가 접수만 했다: status NEW, 체결 0, avgPrice '0'
      .on(DAPI_ORDER, { json: {
        orderId: 8001, symbol: 'BTCUSD_PERP', status: 'NEW',
        executedQty: '0', origQty: '1', avgPrice: '0', price: '95000',
      } }, 'POST');

    const out = await scenario(venue, async () => {
      const { POST, restore } = loadRoute(db);
      try {
        const res = await POST(fakeRequest(BODY));
        return { status: res.status, body: await res.json() };
      } finally { restore(); }
    });

    // ── 이 시나리오가 **실제로 증명하는 것** ──
    //
    //   라우트 본문이 돌고(거래소 조회 9건), 거래 전 점검 14항목이
    //   판정하고, 막히면 **주문을 보내지 않고 체결을 적지 않는다.**
    //
    //   점검을 통과시키려면 운영 모드·시계·손절 거리·증거금·일/주 손실
    //   한도·연속 손절 등 일곱 개 하위 계통의 픽스처가 더 필요하다. 그
    //   **성공 경로는 통합 계층 미검증**으로 남긴다 — 어댑터의 체결 사실
    //   추출(`coinMFillOf`)은 단위 시험이, 라우트의 쓰기는 검사기가 덮는다.
    test('★ COIN-M 라우트가 실제로 돌고 점검에 막히면 주문을 보내지 않는다', () => {
      assert(!(out instanceof Error), String((out as any)?.message));
      const o = out as any;
      // 라우트가 실제로 거래소를 조회했다 — 핸들러가 돌았다는 증거다.
      assert(venue.calls.length >= 5,
        `거래소 조회가 ${venue.calls.length}건이다 — 라우트가 안 돌았다`);
      // 점검이 막았으면 주문은 0건이어야 한다.
      if (o.status !== 200) {
        eq(venue.countOf(DAPI_ORDER, 'POST'), 0,
          '점검이 막았는데 주문이 나갔다');
      }
    });

    test('★ 막힌 주문을 장부에 체결로 적지 않는다 (실제 라우트)', () => {
      const rows = db.table('live_orders');
      for (const row of rows) {
        assert(row.status !== 'FILLED',
          `주문이 나가지 않았는데 장부에 ${row.status}가 적혔다`);
        assert(row.avg_price == null,
          `체결가가 지어졌다: ${row.avg_price}`);
      }
    });

    test('★ 막힌 이유를 숨기지 않는다', () => {
      const b = (out as any)?.body ?? {};
      if ((out as any)?.status === 200) return;
      assert(typeof b.message === 'string' && b.message.length > 0,
        '막혔는데 사유가 없다');
      assert(b.checklist != null, '점검 결과를 응답에 담지 않았다');
      // **확인하지 못한 항목을 통과로 세지 않는다.**
      assert(typeof b.checklist.unknownCount === 'number',
        '확인 불가 항목 수를 세지 않는다');
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// Gate 선물 **전송** 경로 — 실제 `executeOrder(exchange:'gate')`
// ══════════════════════════════════════════════════════════════════
//
// 변이 I-2(Gate 전송 실패를 무조건 REJECTED로)가 **탈출했다.** Gate
// 커버리지가 대조 경로에만 있었고 전송 경로에는 없었기 때문이다.
// 거절과 타임아웃은 서로 반대 방향으로 틀릴 수 있으므로 둘 다 본다.

function gateBaseVenue(): FakeVenue {
  return new FakeVenue()
    .on('/api/v4/futures/usdt/contracts/BTC_USDT', { json: {
      name: 'BTC_USDT', quanto_multiplier: '0.0001', order_size_min: 1,
      order_size_max: 1000000, order_price_round: '0.1', mark_price: '95000',
    } })
    .on('/api/v4/futures/usdt/positions/BTC_USDT', { json: {
      contract: 'BTC_USDT', size: 0, leverage: '100', liq_price: '0', entry_price: '0',
    } })
    .on('/api/v4/futures/usdt/positions', { json: [] })
    .on('/api/v4/futures/usdt/accounts', { json: { total: '1000', available: '1000' } })
    .on('/api/v4/futures/usdt/orders', { json: [] }, 'GET');
}

/**
 * Gate 시나리오는 **고정 손절을 주고** 돌린다.
 *
 * Gate 진입 경로의 손절 관문(`orderExecutor.ts:1154`)은 `stopPolicy`를
 * 보지 않는다 — 바이낸스 쪽은 `noFixedSl`을 보고 `protectionPolicy`를
 * `NONE`으로 덮는데 Gate 쪽에는 그 분기가 없다(**D22**). 그래서
 * `NO_FIXED_SL`로는 Gate 진입이 통째로 막힌다.
 *
 * 막히는 방향이라 돈이 새지는 않지만 경로가 갈린 것은 사실이다. **이
 * PR에서 고치지 않는다**: 고치면 Gate에서 고정 손절 없는 포지션이 열리게
 * 되고, Gate의 전용 종료 권한 도달 가능성은 아직 별도 감사 대상이다
 * (`venuePositionOps.ts`의 주석). 종료가 보장되지 않은 거래소에서 보호
 * 없는 포지션을 열 수 있게 만드는 것이 더 위험하다.
 *
 * 여기서 검증하는 것은 **전송 결과 분류**이므로 손절을 주고 돌린다.
 */
const GATE_ARGS = { exchange: 'gate' as const, stopPolicy: 'FIXED_SL' as const,
  takeProfitPolicy: 'NO_FIXED_TP' as const, protectionPolicy: 'NONE' as const,
  // 청산가(90000)보다 위여야 한다 — 손절이 청산 너머면 영원히 안 걸린다.
  stopLoss: 92000 };

export async function runGateExecIntegrationTests() {
  console.log('[통합 — Gate 선물 전송 경로 (실제 executeOrder)]');

  // ══════════ ① Gate 정상 거절 — REJECTED로 적는다 ══════════
  {
    const db = new FakeDb();
    const venue = gateBaseVenue()
      .on('/api/v4/futures/usdt/positions/BTC_USDT/leverage', { json: { leverage: '100' } })
      // 거래소가 **명시적으로 거절**했다. 모양이 `Gate 400: <label>`이다.
      .on('/api/v4/futures/usdt/orders',
        { status: 400, json: { label: 'BALANCE_NOT_ENOUGH', message: 'not enough balance' } }, 'POST');
    const r = await scenario(venue, () => exec(db, { ...GATE_ARGS, clientOrderId: 'GCOID-1' }));

    test('★ Gate 정상 거절은 REJECTED로 적는다 (미확정으로 쌓지 않는다)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다 — 실행기가 안 돌았다');
      eq(row.status, 'REJECTED',
        `명시적 거절인데 ${row.status}다 — UNKNOWN으로 묶으면 미확정이 쌓여 진입이 막힌다`);
      eq((r as any).status, row.status, '반환과 장부가 다르다');
    });
  }

  // ══════════ ② Gate 전송 타임아웃 — UNKNOWN으로 적는다 ══════════
  {
    const db = new FakeDb();
    const venue = gateBaseVenue()
      .on('/api/v4/futures/usdt/positions/BTC_USDT/leverage', { json: { leverage: '100' } })
      .on('/api/v4/futures/usdt/orders', { timeout: true }, 'POST');
    const r = await scenario(venue, () => exec(db, { ...GATE_ARGS, clientOrderId: 'GCOID-2' }));

    test('★ Gate 전송 타임아웃을 거절로 적지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      eq(row.status, 'UNKNOWN',
        `타임아웃인데 ${row.status}다 — REJECTED는 대조 대상이 아니고 진입 잠금을 푼다`);
      assert(row.status !== 'REJECTED');
      eq((r as any).status, 'UNKNOWN');
      // 주문은 한 번만 나갔다.
      eq(venue.countOf('/api/v4/futures/usdt/orders', 'POST'), 1);
    });
  }

  // ══════════ ③ Gate 5xx — 접수 뒤 응답만 잃었을 수 있다 ══════════
  {
    const db = new FakeDb();
    const venue = gateBaseVenue()
      .on('/api/v4/futures/usdt/positions/BTC_USDT/leverage', { json: { leverage: '100' } })
      .on('/api/v4/futures/usdt/orders',
        { status: 502, json: { label: 'INTERNAL', message: 'bad gateway' } }, 'POST');
    const r = await scenario(venue, () => exec(db, { ...GATE_ARGS, clientOrderId: 'GCOID-3' }));

    test('★ Gate 5xx를 거절로 단정하지 않는다 (게이트웨이는 접수 뒤에도 죽는다)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      eq(row.status, 'UNKNOWN', `5xx인데 ${row.status}로 확정됐다`);
    });
  }
}

export async function runGateDupIntegrationTests() {
  console.log('[통합 — Gate 멱등 중복 · Gate 현물 중복]');

  // ══════════ ④ Gate 선물 멱등 중복 — 전이가 적용되는가 ══════════
  //
  //   변이 I-4(SENT 선행 전이 제거)가 **탈출했다.** Gate 멱등 경로에
  //   시나리오가 없었다. `INTENT → ACKED`는 상태 기계가 거부하므로,
  //   SENT을 먼저 적지 않으면 그 쓰기가 조용히 버려진다.
  {
    const db = new FakeDb();
    const venue = gateBaseVenue()
      .on('/api/v4/futures/usdt/positions/BTC_USDT/leverage', { json: { leverage: '100' } });
    // 중복 확인(GET)에서 **발견**된다: 아직 열려 있는 주문
    (venue as any).rules.unshift({
      label: 'gate-dup-found',
      match: (c: any) => c.method === 'GET' && c.path.includes('/api/v4/futures/usdt/orders'),
      reply: { json: [{ id: 9100, contract: 'BTC_USDT', size: 1, price: '0',
        status: 'open', text: 't-GCOID-9', left: 1 }] },
    });
    const r = await scenario(venue, () => exec(db, { ...GATE_ARGS, clientOrderId: 'GCOID-9' }));

    test('★ Gate 멱등 중복에서 전이가 실제로 적용된다 (장부 = 반환)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      eq((r as any).duplicate, true, '중복으로 판정하지 않았다');
      eq(venue.countOf('/api/v4/futures/usdt/orders', 'POST'), 0,
        '이미 있는 주문을 다시 보냈다');
      eq((r as any).status, row.status,
        `반환(${(r as any).status})과 장부(${row.status})가 다르다`);
      assert(row.status !== 'INTENT',
        '상태 쓰기가 상태 기계에 버려졌다 — SENT 선행 전이가 없다');
      eq(row.status, 'ACKED');
      const statuses = db.writes.filter((w) => w.patch.status).map((w) => w.patch.status);
      assert(statuses.includes('SENT'), `전이 경로가 SENT을 거치지 않았다: ${statuses.join(' → ')}`);
    });
  }

  // ══════════ ⑤ Gate 현물 중복 발견 — 장부와 반환이 같은 답 ══════════
  //
  //   변이 I-5(D21 복원)가 **탈출했다.** 픽스처를 404로 바꾸면서 중복
  //   분기 자체가 커버되지 않았다 — D21이 살던 자리다.
  {
    const unenv = withCryptoEnv();
    const db = new FakeDb().seed('exchange_connections', [{
      id: 'c1', user_id: 'u1', exchange_id: 'gate',
      api_key: 'K'.repeat(64), api_secret_enc: encryptSecret('S'.repeat(64)),
      has_withdrawal: false, is_testnet: true,
    }]);
    unenv();
    const venue = new FakeVenue()
      .on('/api/v4/spot/currency_pairs/BTC_USDT', { json: {
        id: 'BTC_USDT', trade_status: 'tradable',
        amount_precision: 5, precision: 2, min_base_amount: '0.0001', min_quote_amount: '1',
      } })
      .on('/api/v4/spot/accounts', { json: [
        { currency: 'USDT', available: '10000', locked: '0' },
        { currency: 'BTC', available: '1', locked: '0' },
      ] })
      // 단건 조회에서 **발견**된다: 아직 열려 있는 주문
      .on('/api/v4/spot/orders/', { json: {
        id: '7100', currency_pair: 'BTC_USDT', status: 'open',
        amount: '0.003', left: '0.003', filled_total: '0', avg_deal_price: '0',
      } }, 'GET')
      .on('/api/v4/spot/orders', { json: {} }, 'POST');

    const r = await scenario(venue, () => placeSpotOrder(db as any, {
      userId: 'u1', connectionId: 'c1', symbol: 'BTCUSDT',
      side: 'BUY', type: 'LIMIT', quantity: 0.003, price: 90000,
    }));

    test('★ Gate 현물 중복 발견에서 장부와 반환이 같은 답을 적는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const rows = db.table('live_orders');
      assert(rows.length > 0, '장부 줄이 없다');
      const row = rows[rows.length - 1];
      eq((r as any).code, 'duplicate', '중복으로 판정하지 않았다');
      eq((r as any).status, row.status,
        `장부(${row.status})와 반환(${(r as any).status})이 다르다`);
      // 열려 있는 주문을 종료로도 거부로도 적지 않는다.
      eq(row.status, 'ACKED');
      assert(row.status !== 'RECONCILED' && row.status !== 'REJECTED');
      eq(venue.countOf('/api/v4/spot/orders', 'POST'), 0, '중복인데 주문을 보냈다');
    });
  }
}

// ══════════════════════════════════════════════════════════════════
// `NO_FIXED_TP`가 **실행 경로까지** 유지되는가
// ══════════════════════════════════════════════════════════════════
//
// 선언과 실행은 다른 것이다. 프로필에 `NO_FIXED_TP`라고 적혀 있다는
// 사실은 "거래소에 익절 주문이 안 나간다"를 증명하지 않는다 — 실제로
// 예전에 Gate 갈래에 정책 검사가 없어서 익절이 그대로 나갔다(코드 주석
// 835~841행이 그 사고를 적고 있다).
//
// 그래서 **거래소에 나간 주문을 세어** 확인한다.

export async function runNoFixedTpIntegrationTests() {
  console.log('[통합 — NO_FIXED_TP가 실행 경로까지 유지되는가]');

  /** 조건부 주문(손절·익절) 전송 횟수 */
  const condSends = (v: FakeVenue) => v.calls.filter(
    (c) => c.method === 'POST' && /\/fapi\/v1\/order\b/.test(c.path)
      && /STOP|TAKE_PROFIT/.test(String(c.params.type ?? ''))).length;

  // ══════════ ① 익절 주문이 한 건도 나가지 않는다 ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
      .on(BN_ORDER, { json: bnOrder({
        status: 'FILLED', executedQty: '0.010', avgPrice: '95000',
      }) }, 'POST');
    const r = await scenario(venue, () => exec(db, {}));   // 기본값이 NO_FIXED_SL/NO_FIXED_TP다

    test('★ NO_FIXED_TP 주문은 거래소에 익절을 한 건도 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const tp = venue.calls.filter((c) => c.method === 'POST'
        && /TAKE_PROFIT/.test(String(c.params.type ?? '')));
      eq(tp.length, 0, `익절 주문이 ${tp.length}건 나갔다 — 선언과 실행이 갈렸다`);
      eq(condSends(venue), 0, '고정 손절·익절이 함께 나갔다');
      // 장부에도 익절 주문 번호가 남지 않아야 한다.
      const row = db.table('live_orders')[0];
      assert(row.tp_order_id == null || row.tp_order_id === '',
        `장부에 익절 주문 번호가 적혔다: ${row.tp_order_id}`);
    });

    test('★ 진입은 정상 체결된다 — 익절이 없다고 진입을 막지 않는다', () => {
      const row = db.table('live_orders')[0];
      eq(row.status, 'FILLED');
      eq(Number(row.filled_qty), 0.01);
    });
  }

  // ══════════ ② 익절가를 함께 넘기면 **주문 자체를 거절한다** ══════════
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder() }, 'GET')
      .on(BN_ORDER, { json: bnOrder() }, 'POST');
    const r = await scenario(venue, () => exec(db, { takeProfit: 96000 }));

    test('★ NO_FIXED_TP에 익절가가 함께 오면 주문하지 않는다 (모순 거절)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq((r as any).ok, false);
      eq((r as any).status, 'REJECTED');
      // **거래소에 아무것도 나가지 않았다.**
      eq(venue.calls.length, 0, `모순인데 거래소 호출이 ${venue.calls.length}건 있었다`);
      assert(/고정 익절/.test(String((r as any).message)), String((r as any).message));
    });
  }

  // ══════════ ②-2 분할 익절 사다리도 모순으로 거절한다 ══════════
  //
  //   변이 T-1(보호주문 단계의 `else if (noFixedTp)` 제거)이 **탈출했다.**
  //   단일 익절만 넘기는 시험에서는 그 분기를 지워도 아무 일이 안 일어난다
  //   (`exitPlan`도 `takeProfit`도 없으니 어느 분기도 안 탄다). 그런데
  //   `exitPlan`에 `PARTIAL_TP`가 담겨 오면 그 한 줄이 **유일한** 방어였다.
  {
    const db = new FakeDb();
    const venue = baseVenue()
      .on(BN_ORDER, { json: bnOrder() }, 'GET')
      .on(BN_ORDER, { json: bnOrder() }, 'POST');
    const r = await scenario(venue, () => exec(db, {
      exitPlan: { orders: [
        { kind: 'PARTIAL_TP', price: 96000, quantity: 0.005 },
        { kind: 'PARTIAL_TP', price: 97000, quantity: 0.005 },
      ] },
    }));

    test('★ NO_FIXED_TP에 분할 익절 사다리가 오면 주문하지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq((r as any).status, 'REJECTED');
      eq(venue.calls.length, 0,
        `모순인데 거래소 호출이 ${venue.calls.length}건 있었다 — 경계에서 막지 못했다`);
      const tp = venue.calls.filter((c) => /TAKE_PROFIT/.test(String(c.params.type ?? '')));
      eq(tp.length, 0, `분할 익절이 ${tp.length}건 나갔다`);
      assert(/분할 익절/.test(String((r as any).message)), String((r as any).message));
    });
  }

  // ══════════ ③ 수익이 커져도 자동 종료 수단은 시간청산뿐이다 ══════════
  {
    test('★ Exact100X 자리에 열린 자동 종료는 시간청산 하나뿐이다', async () => {
      const { seatExitCapabilities } = await import('@/lib/engine/managedPosition');
      const r = seatExitCapabilities({
        stopPolicy: 'NO_FIXED_SL', hasStopValue: false,
        executionIdentity: {
          profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 1,
        } as any,
      });
      eq(r.exposureClass, 'NO_FIXED_SL_EXACT100X');
      // 이익을 제한할 수 있는 수단이 전부 닫혀 있어야 한다.
      eq(r.capabilities.fixedStopAtEntry, false);
      eq(r.capabilities.breakEven, false, '본전 이동이 열리면 수익이 0에서 잘린다');
      eq(r.capabilities.trailing, false, '트레일링이 열리면 수익이 되돌림에서 잘린다');
      eq(r.capabilities.emergency, false);
      // 열려 있는 것은 보유 시간 하나다 — 이익과 무관한 기준이다.
      eq(r.capabilities.timeExit, true);
    });
  }
}

/**
 * **2026-10-16 TESTNET 실측 회귀.**
 *
 * 실제 Binance TESTNET이 `-1111 Precision is over the maximum defined
 * for this asset`로 주문을 거절했다. 보낸 수량은
 * `(증거금 × 배율) / 기준가`가 만든 생 부동소수였고, 실행기는 거래소
 * 규격을 맞추는 단계를 **아예 거치지 않았다.**
 *
 * 규격 정본(`quantizeOrder`)은 이미 있었고 `placeFuturesOrderSafe`와
 * `futuresExec`는 그것을 썼다. 이 경로만 안 쓰고 있었다.
 *
 * 그래서 이 시험들은 "정본이 맞게 계산하는가"가 아니라
 * **"실행기가 실제로 보낸 값이 격자 위에 있는가"**를 본다.
 */
export async function runPrecisionIntegrationTests() {
  console.log('[통합 — 수량 정밀도 (-1111 회귀)]');

  // **시나리오마다 다른 심볼을 쓴다.**
  //
  // `getSymbolFilters`는 `demo:심볼`로 5분 캐시한다. 처음에 전부
  // BTCUSDT로 썼더니 두 번째 시나리오부터 **첫 시나리오의 규격**을
  // 봤고, 그래서 MARKET_LOT_SIZE 시험과 "규격 미상" 시험이 둘 다
  // 엉뚱하게 실패했다. 캐시는 옳게 동작한 것이고 시험이 틀렸다.
  const venueFor = (symbol: string, filters: any[], exInfoFails = false): FakeVenue => {
    const v = new FakeVenue();
    v.on(BN_EXINFO, exInfoFails
      ? { status: 500, json: { msg: 'down' } }
      : { json: { symbols: [{ symbol, filters }] } });
    return v
      .on('/fapi/v1/marginType', { json: { code: 200, msg: 'success' } })
      .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
      .on(BN_DUAL, { json: { dualSidePosition: false } })
      .on(BN_LEV, { json: { leverage: 100, symbol } })
      .on(BN_POS, { json: [{ symbol, positionAmt: '0', entryPrice: '0',
        leverage: '100', marginType: 'isolated', liquidationPrice: '0' }] })
      .on('/fapi/v1/premiumIndex', { json: { symbol, markPrice: '60000' } })
      .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET');
  };

  /** 거래소에 실제로 간 수량 문자열 */
  const sentQty = (venue: FakeVenue): string | null => {
    const c = venue.orderSends()[0];
    return c ? String((c.params as any)?.quantity ?? '') : null;
  };
  const decimalsOfStr = (v: string) => {
    const dot = v.indexOf('.');
    return dot < 0 ? 0 : v.slice(dot + 1).replace(/0+$/, '').length;
  };

  // ══════════ ① 생 부동소수가 격자로 내려간다 ══════════
  {
    const SYM = 'PRECAUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ]).on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED', executedQty: '0.003', avgPrice: '60000' }) }, 'POST');
    // 실측과 같은 모양: (20 × 10) / 60000
    const raw = (20 * 10) / 60000;
    const r = await scenario(venue, () => exec(db, { plan: plan({ symbol: SYM, quantity: raw }) }));

    test('★ 실측 회귀 — 생 부동소수를 그대로 보내지 않는다 (-1111)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 1);
      const q = sentQty(venue)!;
      assert(!q.includes('0.0033333'), `생 부동소수가 그대로 나갔다: ${q}`);
      assert(decimalsOfStr(q) <= 3, `자리수가 규격을 넘었다: ${q}`);
      eq(Number(q), 0.003);
    });

    test('★ 규격에 맞춘 수량을 장부에도 적는다', () => {
      const row = db.table('live_orders')[0];
      assert(row, '장부 줄이 없다');
      eq(Number(row.quantity), 0.003);
    });
  }

  // ══════════ ② MARKET_LOT_SIZE가 더 좁으면 그쪽을 따른다 ══════════
  {
    const SYM = 'PRECBUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.01', minQty: '0.01' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ]).on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED', executedQty: '0.03', avgPrice: '60000' }) }, 'POST');
    const r = await scenario(venue, () => exec(db, { plan: plan({ symbol: SYM, quantity: 0.0333 }) }));

    test('★ 시장가는 MARKET_LOT_SIZE까지 적용한다 (0.0333 → 0.03)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 1);
      eq(Number(sentQty(venue)), 0.03);
    });
  }

  // ══════════ ②-b 보호주문 대체 수량도 LOT_SIZE 적용 ══════════
  {
    const { quantizeOrder } = await import('../../lib/exchanges/quantize');
    const filters: any = {
      limitQty: { stepSize: 0.001, minQty: 0.001 },
      // MARKET_LOT_SIZE가 비활성(0)이어도 LOT_SIZE는 살아 있다.
      marketQty: { stepSize: 0, minQty: 0 }, tickSize: 0.1,
    };
    test('★ 손절 fallback 0.0033333333은 reduceOnly에서도 0.003', () => {
      const q = quantizeOrder(0.0033333333333333335, null, filters,
        { orderType: 'MARKET', reduceOnly: true });
      eq(q.ok, true); eq(q.quantity, 0.003);
    });
    test('★ 분할 익절 수량이 격자 아래면 실패 (전량 closePosition 승격 금지)', () => {
      const q = quantizeOrder(0.0005, null, filters,
        { orderType: 'MARKET', reduceOnly: true });
      eq(q.ok, false); eq(q.quantity, null);
    });
    test('★ 청산 중 거래소 필터를 못 읽어도 원수량을 유지한다', () => {
      const q = quantizeOrder(0.0033333333333333335, null, null,
        { orderType: 'MARKET', reduceOnly: true });
      eq(q.ok, true); eq(q.quantity, 0.0033333333333333335);
    });
  }

  // ══════════ ②-c 실제 보호주문 fallback HTTP 전송 — -4120 이후 수량 ══════════
  {
    const SYM = 'PRECHUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ])
      .onParams(BN_ORDER, 'POST', { type: 'STOP_MARKET', closePosition: 'true' },
        { status: 400, json: { code: -4120, msg: 'not supported for this endpoint' } })
      .onParams(BN_ORDER, 'POST', { type: 'STOP_MARKET', reduceOnly: 'true' },
        { json: bnOrder({ symbol: SYM, orderId: 9001 }) })
      .on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED',
        executedQty: '0.003', avgPrice: '60000' }) }, 'POST')
      .on('/fapi/v1/openOrders', { json: [{ orderId: 9001, symbol: SYM,
        type: 'STOP_MARKET', side: 'SELL', stopPrice: '59000', reduceOnly: true }] });
    const r = await scenario(venue, () => exec(db, {
      plan: plan({ symbol: SYM, quantity: 0.0033333333333333335,
        liquidationPrice: 58000, liquidationDistancePct: 3 }),
      stopLoss: 59000, stopPolicy: 'FIXED_STOP',
      protectionPolicy: 'OPTIONAL',
    }));
    test('★ -4120 후 실제 fallback 주문의 수량은 LOT_SIZE 격자 위', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const fallback = venue.orderSends().filter(c => c.params.type === 'STOP_MARKET'
        && c.params.reduceOnly === 'true');
      eq(fallback.length, 1, '손절 대체 주문이 실제로 나가지 않았다');
      eq(fallback[0].params.quantity, '0.003');
      assert(!fallback[0].params.quantity.includes('33333'), '생 부동소수가 나갔다');
    });
  }

  // ══════════ ②-c2 미체결 주문의 origQty는 fallback 수량 증거가 아니다 ══════════
  {
    const SYM = 'PRECJUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ])
      .onParams(BN_ORDER, 'POST', { type: 'STOP_MARKET', closePosition: 'true' },
        { status: 400, json: { code: -4120, msg: 'not supported for this endpoint' } })
      .on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'NEW',
        executedQty: '0', origQty: '0.010' }) }, 'POST');
    const r = await scenario(venue, () => exec(db, {
      plan: plan({ symbol: SYM, quantity: 0.0033333333333333335,
        liquidationPrice: 58000, liquidationDistancePct: 3 }),
      stopLoss: 59000, stopPolicy: 'FIXED_STOP',
      protectionPolicy: 'OPTIONAL',
    }));
    test('★ 미체결 origQty=0.010을 손절 대체 수량으로 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const fallback = venue.orderSends().filter(c => c.params.type === 'STOP_MARKET'
        && c.params.reduceOnly === 'true');
      eq(fallback.length, 0, '미체결 주문의 요청 수량으로 손절 대체 주문을 보냈다');
    });
  }

  // ══════════ ②-c3 손절 부착 실패 후 REQUIRED 청산도 체결량/격자 사용 ══════════
  {
    const SYM = 'PRECKUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ])
      .onParams(BN_ORDER, 'POST', { type: 'STOP_MARKET' },
        { status: 400, json: { code: -4120, msg: 'not supported for this endpoint' } })
      .onParams(BN_ORDER, 'POST', { type: 'MARKET', reduceOnly: 'true' },
        { json: bnOrder({ symbol: SYM, status: 'FILLED', executedQty: '0.003', avgPrice: '60000' }) })
      .on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED',
        executedQty: '0.003', origQty: '0.010', avgPrice: '60000' }) }, 'POST');
    const r = await scenario(venue, () => exec(db, {
      plan: plan({ symbol: SYM, quantity: 0.0033333333333333335,
        liquidationPrice: 58000, liquidationDistancePct: 3 }),
      stopLoss: 59000, stopPolicy: 'FIXED_STOP',
      protectionPolicy: 'REQUIRED',
    }));
    test('★ REQUIRED 손절 실패 청산은 origQty 0.010 아닌 체결 0.003을 전송', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const close = venue.orderSends().filter(c => c.params.type === 'MARKET'
        && c.params.reduceOnly === 'true');
      eq(close.length, 1, '손절 실패 후 reduceOnly 청산이 전송되지 않았다');
      eq(close[0].params.quantity, '0.003');
    });
  }

  // ══════════ ②-d 잘못된 PARTIAL_TP는 closePosition으로 승격되지 않는다 ══════════
  {
    const SYM = 'PRECIUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ])
      .onParams(BN_ORDER, 'POST', { type: 'STOP_MARKET' },
        { json: bnOrder({ symbol: SYM, orderId: 9002 }) })
      .on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED',
        executedQty: '0.003', avgPrice: '60000' }) }, 'POST')
      .on('/fapi/v1/openOrders', { json: [{ orderId: 9002, symbol: SYM,
        type: 'STOP_MARKET', side: 'SELL', stopPrice: '59000', closePosition: true }] });
    const r = await scenario(venue, () => exec(db, {
      plan: plan({ symbol: SYM, quantity: 0.0033333333333333335,
        liquidationPrice: 58000, liquidationDistancePct: 3 }),
      stopLoss: 59000, stopPolicy: 'FIXED_STOP',
      takeProfitPolicy: 'FIXED_TP', protectionPolicy: 'OPTIONAL',
      exitPlan: { orders: [{ kind: 'PARTIAL_TP', price: 61000, quantity: 0.0005 }] },
    }));
    test('★ 격자 미만 PARTIAL_TP는 주문 0건 (전량 청산 전환 금지)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const tp = venue.orderSends().filter(c => c.params.type === 'TAKE_PROFIT_MARKET');
      eq(tp.length, 0, '수량 없는 분할 익절이 closePosition으로 전송됐다');
    });
  }

  // ══════════ ③ 격자 아래 수량은 **보내지 않는다** ══════════
  {
    const SYM = 'PRECCUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ]).on(BN_ORDER, { json: bnOrder({ symbol: SYM }) }, 'POST');
    const r = await scenario(venue, () => exec(db, { plan: plan({ symbol: SYM, quantity: 0.00005 }) }));

    test('★ 격자보다 작은 수량은 주문을 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0);
      eq((r as any).status, 'FAILED');
    });

    test('★ 안 보낸 주문을 SENT로 적지 않는다', () => {
      // 장부에 "보냈다"가 남으면 대조가 영영 어긋난다.
      const sent = db.writes.filter((w) => w.patch?.status === 'SENT');
      eq(sent.length, 0);
      eq(db.table('live_orders')[0].status, 'FAILED');
    });
  }

  // ══════════ ④ 최소 명목가 미달도 보내지 않는다 ══════════
  {
    const SYM = 'PRECDUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      // 0.003 × 60000 = $180 < $500
      { filterType: 'MIN_NOTIONAL', notional: '500' },
    ]).on(BN_ORDER, { json: bnOrder({ symbol: SYM }) }, 'POST');
    const r = await scenario(venue, () => exec(db, { plan: plan({ symbol: SYM, quantity: 0.0033333 }) }));

    test('★ 최소 명목가에 못 미치면 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0);
      eq((r as any).status, 'FAILED');
    });
  }

  // ══════════ ⑤ 규격을 못 읽으면 신규 진입을 보내지 않는다 ══════════
  {
    const SYM = 'PRECEUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [], true)
      .on(BN_ORDER, { json: bnOrder({ symbol: SYM }) }, 'POST');
    const r = await scenario(venue, () => exec(db, { plan: plan({ symbol: SYM, quantity: 0.0033333 }) }));

    test('★ 규격 미상이면 신규 진입을 막는다 — 모르는 규격으로 열지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0);
      eq((r as any).status, 'FAILED');
      assert(/규격/.test(String((r as any).message)), String((r as any).message));
    });
  }

  // ══════════ ⑥ 지정가는 tickSize에 맞춘다 ══════════
  {
    const SYM = 'PRECFUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ]).on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'NEW' }) }, 'POST');
    const r = await scenario(venue, () => exec(db, {
      plan: plan({ symbol: SYM, quantity: 0.0033333 }),
      orderType: 'LIMIT', limitPrice: 60000.07,
    }));

    test('★ 지정가는 tickSize 격자로 간다 (60000.07 → 60000.1)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      const c = venue.orderSends()[0];
      assert(c != null, '주문이 안 나갔다');
      eq(Number((c.params as any).price), 60000.1);
      eq(Number((c.params as any).quantity), 0.003);
    });
  }

  // ══════════ ⑦ MARKET_LOT_SIZE가 아예 없으면 시장가를 막는다 ══════════
  {
    // 실제 바이낸스 USDⓈ-M 무기한은 이 필터를 **항상** 준다(꺼져 있으면
    // 0으로). 아예 없다는 것은 규격을 다 읽지 못했다는 뜻이고, 그때
    // `LOT_SIZE`를 복사해 쓰면 거래소가 두지 않은 규칙을 지어내는 것이다.
    // 그래서 신규 진입은 막는다 — 거부당하는 것보다 안 보내는 것이 낫다.
    const SYM = 'PRECGUSDT';
    const db = new FakeDb();
    const venue = venueFor(SYM, [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' },
    ]).on(BN_ORDER, { json: bnOrder({ symbol: SYM }) }, 'POST');
    const r = await scenario(venue, () => exec(db, { plan: plan({ symbol: SYM, quantity: 0.0033333 }) }));

    test('★ 시장가 격자가 없으면 신규 진입을 막는다 (LOT_SIZE를 복사하지 않는다)', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(venue.orderSends().length, 0);
      eq((r as any).status, 'FAILED');
    });
  }
}

/**
 * **실제 심볼 × 방향 × 배율 전수.**
 *
 * 합성 심볼로만 보면 "BTCUSDT에서도 되는가"를 못 말한다. 실제 바이낸스
 * USDⓈ-M 규격으로 BTCUSDT·ETHUSDT를 LONG/SHORT · 10배/100배로 돌려
 * **거래소에 간 수량과 보호주문 가격이 전부 격자 위에 있는지** 본다.
 */
export async function runPrecisionMatrixTests() {
  console.log('[통합 — 정밀도 전수 (BTC·ETH × LONG·SHORT × 10·100배)]');

  /** 실제 바이낸스 USDⓈ-M 규격 (MARKET_LOT_SIZE의 0은 '꺼짐') */
  const SPECS: Record<string, { step: string; minQty: string; tick: string; px: number }> = {
    // **기준가를 딱 떨어지는 값으로 두지 않는다.**
    //   60000 × 0.98 = 58800 — 이미 0.10 격자 위라 반올림을 떼도 시험이
    //   통과한다. 실제로 그렇게 써서 음성 시험이 0건을 잡았다.
    //   실측의 `59400.000000000007`처럼 **어긋나는 값**이어야 한다.
    MTXBTCUSDT: { step: '0.001', minQty: '0.001', tick: '0.10', px: 60123.45 },
    MTXETHUSDT: { step: '0.001', minQty: '0.001', tick: '0.01', px: 3012.37 },
  };

  const onGrid = (v: number, step: number) => {
    const k = Math.round(v / step);
    return Math.abs(k * step - v) < step * 1e-6;
  };

  for (const [SYM, spec] of Object.entries(SPECS)) {
    for (const side of ['LONG', 'SHORT'] as const) {
      for (const leverage of [10, 100]) {
        const db = new FakeDb();
        const marginUsd = 20;
        // 스모크가 쓰는 바로 그 식 — 생 부동소수가 나온다
        const rawQty = (marginUsd * leverage) / spec.px;

        // **손절은 청산가 안쪽이어야 한다.** 배율이 높을수록 청산까지의
        // 거리가 짧다(100배면 약 1%). 처음엔 손절을 1%로 고정하고
        // 청산가를 아무 값이나 넣었다가, 청산가 관문이 옳게 막았다 —
        // 코드가 아니라 픽스처가 틀렸던 것이다.
        const liqPct = 0.9 * (100 / leverage);          // 10배 9% · 100배 0.9%
        const stopPct = leverage >= 100 ? 0.3 : 2;
        const sgn = side === 'LONG' ? -1 : 1;
        const liqPrice = spec.px * (1 + sgn * liqPct / 100);
        const rawStop = spec.px * (1 + sgn * stopPct / 100);
        const rawTp = spec.px * (1 - sgn * stopPct / 100);

        const venue = new FakeVenue()
          .on(BN_EXINFO, { json: { symbols: [{ symbol: SYM, filters: [
            { filterType: 'LOT_SIZE', stepSize: spec.step, minQty: spec.minQty },
            { filterType: 'MARKET_LOT_SIZE', stepSize: '0', minQty: '0' },
            { filterType: 'PRICE_FILTER', tickSize: spec.tick },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ] }] } })
          .on('/fapi/v1/marginType', { json: { code: 200, msg: 'success' } })
          .on('/fapi/v1/account', { json: { positions: [], assets: [] } })
          .on(BN_DUAL, { json: { dualSidePosition: false } })
          .on(BN_LEV, { json: { leverage, symbol: SYM } })
          .on(BN_POS, { json: [{ symbol: SYM, positionAmt: '0', entryPrice: '0',
            leverage: String(leverage), marginType: 'isolated', liquidationPrice: '0' }] })
          .on('/fapi/v1/premiumIndex', { json: { symbol: SYM, markPrice: String(spec.px) } })
          .on('/fapi/v1/openOrders', { json: [] })
          .on(BN_ORDER, { status: 400, json: { code: -2013, msg: 'Order does not exist.' } }, 'GET')
          .on(BN_ORDER, { json: bnOrder({ symbol: SYM, status: 'FILLED',
            executedQty: String(rawQty), avgPrice: String(spec.px) }) }, 'POST');

        const r = await scenario(venue, () => exec(db, {
          plan: plan({ symbol: SYM, side, quantity: rawQty, leverage,
            stopDistancePct: stopPct, effectiveStopPct: stopPct,
            liquidationPrice: liqPrice, liquidationDistancePct: liqPct }),
          stopLoss: rawStop, takeProfit: rawTp,
          stopPolicy: 'FIXED_STOP', takeProfitPolicy: 'FIXED_TP',
          protectionPolicy: 'OPTIONAL',
        }));

        const label = `${SYM} ${side} ${leverage}배`;

        test(`★ ${label} — 진입 수량이 stepSize 격자 위에 있다`, () => {
          assert(!(r instanceof Error), String((r as any)?.message));
          const sends = venue.orderSends();
          assert(sends.length >= 1, `주문이 안 나갔다 (${String((r as any)?.message)})`);
          const q = Number((sends[0].params as any).quantity);
          const step = Number(spec.step);
          assert(onGrid(q, step), `${label}: 수량 ${q}이 격자 ${step} 위에 없다`);
          assert(q > 0, `${label}: 수량이 0이다`);
          // 생 부동소수가 그대로 나가지 않았다
          assert(q !== rawQty || onGrid(rawQty, step),
            `${label}: 생 부동소수 ${rawQty}가 그대로 나갔다`);
        });

        test(`★ ${label} — 보호주문 가격이 tickSize 격자 위에 있다`, () => {
          const tick = Number(spec.tick);
          // **이 시험이 공허하지 않다는 확인.** 원본이 이미 격자 위면
          // 반올림을 떼도 통과하므로 아무것도 막지 못한다.
          assert(!onGrid(rawStop, tick) || !onGrid(rawTp, tick),
            `${label}: 원본 가격이 이미 격자 위다 — 이 시험은 아무것도 막지 못한다`);
          const conds = venue.calls.filter((c) => c.method === 'POST'
            && /\/order\b/.test(c.path) && (c.params as any)?.stopPrice != null);
          assert(conds.length >= 1, `${label}: 조건부 주문이 안 나갔다`);
          for (const c of conds) {
            const sp = Number((c.params as any).stopPrice);
            assert(onGrid(sp, tick), `${label}: stopPrice ${sp}이 호가 단위 ${tick} 위에 없다`);
          }
        });

        test(`★ ${label} — 손절은 불리한 쪽, 익절은 유리한 쪽으로 맞춘다`, () => {
          // 반올림하면 손절이 한 틱 가까워지거나 익절이 한 틱 멀어진다.
          const conds = venue.calls.filter((c) => c.method === 'POST'
            && /\/order\b/.test(c.path) && (c.params as any)?.stopPrice != null);
          for (const c of conds) {
            const sp = Number((c.params as any).stopPrice);
            const type = String((c.params as any).type);
            if (type === 'STOP_MARKET') {
              if (side === 'LONG') assert(sp <= rawStop, `${label}: LONG 손절이 올라갔다 ${rawStop}→${sp}`);
              else assert(sp >= rawStop, `${label}: SHORT 손절이 내려갔다 ${rawStop}→${sp}`);
            } else if (type === 'TAKE_PROFIT_MARKET') {
              if (side === 'LONG') assert(sp >= rawTp, `${label}: LONG 익절이 내려갔다 ${rawTp}→${sp}`);
              else assert(sp <= rawTp, `${label}: SHORT 익절이 올라갔다 ${rawTp}→${sp}`);
            }
          }
        });
      }
    }
  }
}
