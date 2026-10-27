// src/test/integration/stopReattachIdempotencyIntegration.test.ts
//
// **손절을 두 번 거는 길.**
//
// 대조(`attachStopIfMissing`)는 장부의 `sl_order_id`가 비어 있으면 손절을
// 다시 건다. 그런데 손절을 보낸 **뒤** `sl_order_id`를 적는 쓰기가
// 실패하면, 장부는 그대로 비어 있다. 다음 대조 회차(또는 재시작)는 같은
// 줄을 보고 **또 건다.**
//
// 결과는 한 포지션에 보호주문 둘이다. 하나가 발동해 포지션을 닫으면
// 나머지 하나가 **남는다** — 그 주문은 reduce-only가 아닌 경로를 타면
// 반대 방향 포지션을 새로 연다. 이 저장소가 청산 경로에서 이미 적어 둔
// 바로 그 사고다.
//
// 두 구멍이 겹쳐 있다
// ───────────────────
//   ① 보내기 전에 **거래소에 이미 손절이 있는지 보지 않는다.**
//      진입 경로는 `verifyStopAttached`로 확인하는데, 복구 경로에는
//      그 확인이 없다.
//   ② 보낸 뒤 `sl_order_id` 쓰기 결과를 **보지 않는다**
//      (`updateOrderRow`가 이제 결과를 돌려주는데도 버린다).
//
// ①이 없으면 ②가 그대로 중복 주문이 된다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
import { reconcilePendingOrders } from '../../lib/engine/orderExecutor';

const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_OPEN = '/fapi/v1/openOrders';
const BN_EXINFO = '/fapi/v1/exchangeInfo';

const SYM = 'STOPDUPUSDT';
const STOP_PX = 58920.9;

const pendingRow = (over: Record<string, any> = {}) => ({
  id: 'ord-1', client_order_id: 'COID-SD1', symbol: SYM,
  exchange: 'binance', mode: 'TESTNET', side: 'BUY', quantity: 0.01,
  status: 'ACKED', filled_qty: 0, avg_price: null,
  stop_policy: 'FIXED_SL', stop_loss: STOP_PX, sl_order_id: null, reduce_only: false,
  sent_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  pos_qty_before: 0, resolve_attempts: 0, user_id: 'u1', connection_id: 'c1',
  ...over,
});

/** 이미 걸려 있는 손절 한 건 */
const existingStop = (over: Record<string, any> = {}) => ({
  orderId: 7777, symbol: SYM, side: 'SELL', type: 'STOP_MARKET',
  stopPrice: String(STOP_PX), status: 'NEW', reduceOnly: true, closePosition: false,
  ...over,
});

/** 포지션은 열려 있고 진입은 체결로 확인되는 바탕 */
function baseVenue(openOrders: any): FakeVenue {
  const v = new FakeVenue()
    .on(BN_POS, { json: [{ symbol: SYM, positionAmt: '0.003', entryPrice: '60000',
      leverage: '100', marginType: 'isolated', liquidationPrice: '57000' }] })
    .on(BN_EXINFO, { json: { symbols: [{ symbol: SYM, filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' },
      { filterType: 'PRICE_FILTER', tickSize: '0.1' },
    ] }] } })
    .on(BN_ORDER, { json: { orderId: 6001, symbol: SYM, status: 'FILLED',
      executedQty: '0.003', origQty: '0.010', avgPrice: '60000' } }, 'GET');
  // 미체결 목록. `null`을 주면 조회 실패(배열이 아님)를 흉내 낸다.
  v.on(BN_OPEN, openOrders === 'fail'
    ? { status: 503, json: { code: -1001, msg: 'Internal error' } }
    : { json: openOrders }, 'GET');
  // 복구 손절 전송은 성공한다 — 막히는 쪽이 아니라 **보내는지**를 센다.
  v.on(BN_ORDER, { json: { orderId: 9501, symbol: SYM, status: 'NEW' } }, 'POST');
  return v;
}

async function reconcile(db: FakeDb) {
  return reconcilePendingOrders(db as any, {
    exchange: 'binance', apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
    testnet: true, userId: 'u1', connectionId: 'c1',
  } as any);
}

async function scenario<T>(venue: FakeVenue, body: () => Promise<T>): Promise<T | Error> {
  const restore = venue.install();
  const unenv = withCryptoEnv();
  try { return await body(); }
  catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

const stopSends = (v: FakeVenue) =>
  v.orderSends().filter((c) => String(c.params.type ?? '').includes('STOP'));

export async function runStopReattachIdempotencyTests() {
  console.log('[통합 — 손절을 두 번 걸지 않는다]');

  // ══════════ ① 거래소에 이미 손절이 있으면 다시 걸지 않는다 ══════════
  //
  // 장부의 `sl_order_id`가 비어 있는 이유는 둘이다 — 정말 안 걸었거나,
  // **걸었는데 적지 못했거나.** 장부만 보면 그 둘을 구분할 수 없다.
  // 거래소에 물어야 한다.
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue([existingStop()]);
    const r = await scenario(venue, () => reconcile(db));

    test('★★ 거래소에 같은 손절이 이미 있으면 새로 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 0,
        '이미 걸린 손절을 보고도 또 걸었다 — 한 포지션에 보호주문이 둘이 된다');
    });

    test('★★ 그때 장부의 sl_order_id는 거래소에서 찾은 주문으로 채워진다', () => {
      const row = db.row('live_orders', { id: 'ord-1' });
      assert(row, '장부 줄이 없다');
      eq(String(row.sl_order_id ?? ''), '7777',
        '거래소에 있는 손절을 장부에 잇지 않으면 다음 회차가 또 묻는다');
    });
  }

  // ══════════ ② 미체결 목록을 못 읽으면 "손절 없음"이 아니다 ══════════
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue('fail');
    const r = await scenario(venue, () => reconcile(db));

    test('★★ 미체결 조회 실패에서는 손절을 보내지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 0,
        '못 읽은 것을 "보호 없음"으로 읽고 손절을 보냈다 — 이미 걸려 있었다면 중복이다');
    });

    test('★★ 그 사실이 경고와 attention으로 남는다', () => {
      const row = db.row('live_orders', { id: 'ord-1' });
      eq(row?.needs_attention, true, '미확인인데 attention이 없다');
      assert((r as any).details?.some((d: string) => /손절/.test(d) && /미확인|확인/.test(d)),
        `미확인 사유가 결과에 없다: ${JSON.stringify((r as any).details)}`);
    });
  }

  // ══════════ ③ 손절은 나갔는데 sl_order_id를 못 적었다 ══════════
  //
  // 이 회차에서 주문은 **정상적으로 나간다.** 문제는 그 뒤다 — 적지
  // 못했는데 조용히 지나가면, 다음 회차가 같은 줄을 보고 또 건다.
  {
    const db = new FakeDb({
      updateFailure: {
        table: 'live_orders', mode: 'error',
        onlyWhen: (p) => Object.prototype.hasOwnProperty.call(p, 'sl_order_id'),
      },
    }).seed('live_orders', [pendingRow()]);
    const venue = baseVenue([]);            // 아직 걸린 손절 없음
    const r = await scenario(venue, () => reconcile(db));

    test('★★ sl_order_id 기록 실패를 조용히 넘기지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 1, '이 회차에서는 손절이 한 번 나가야 한다');
      const row = db.row('live_orders', { id: 'ord-1' });
      eq(row?.needs_attention, true,
        '손절은 걸렸는데 장부에 못 적었다 — 다음 회차가 또 건다');
      assert((r as any).details?.some((d: string) => /기록/.test(d)),
        `기록 실패가 결과에 없다: ${JSON.stringify((r as any).details)}`);
    });
  }

  // ══════════ ④ 회귀 — 정말 없으면 한 번 걸고 장부에 적는다 ══════════
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue([]);
    const r = await scenario(venue, () => reconcile(db));

    test('보호주문이 정말 없으면 한 번 걸고 sl_order_id를 적는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 1, `손절 전송이 ${stopSends(venue).length}건이다`);
      eq(String(db.row('live_orders', { id: 'ord-1' })?.sl_order_id ?? ''), '9501');
    });
  }

  // ══════════ ⑤ 회귀 — 다른 심볼·다른 방향의 손절은 내 것이 아니다 ══════════
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue([
      existingStop({ symbol: 'OTHERUSDT' }),
      existingStop({ side: 'BUY' }),
      { orderId: 1, symbol: SYM, side: 'SELL', type: 'LIMIT', price: '61000', status: 'NEW' },
    ]);
    const r = await scenario(venue, () => reconcile(db));

    test('★ 남의 심볼·반대 방향·일반 주문을 내 손절로 세지 않는다', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 1,
        '내 손절이 아닌 주문을 보호로 읽고 걸지 않았다 — 포지션이 무방비로 남는다');
    });
  }
  // ══════════ ⑥ 기존 STOP의 주문 ID를 못 읽으면 성공으로 기록하지 않는다 ══════════
  //
  // 조회에서 STOP 자체는 발견했지만 주문 번호가 없으면, 취소·관리 가능한
  // 보호주문으로 장부에 연결할 수 없다. 이때 새 주문을 보내면 중복이고,
  // 경고 없이 종료하면 다음 대조에서 추적할 근거가 사라진다.
  for (const [shape, orderId] of [['missing', null], ['blank', '']] as const) {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue([existingStop({ orderId })]);
    const r = await scenario(venue, () => reconcile(db));

    test(`★★ 기존 STOP 주문 ID ${shape}: 중복 손절 POST 0건`, () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 0, 'ID를 못 읽었다고 손절을 한 번 더 걸면 안 된다');
    });
    test(`★★ 기존 STOP 주문 ID ${shape}: 확인 불가 경고와 attention`, () => {
      const row = db.row('live_orders', { id: 'ord-1' });
      eq(row?.needs_attention, true, '주문 번호를 못 읽었는데 성공으로 보고했다');
      assert((r as any).details?.some((d: string) =>
        /손절/.test(d) && /번호|ID|미확인/.test(d)),
      `주문 번호 미확인 사유가 없다: ${JSON.stringify((r as any).details)}`);
    });
    test(`기존 STOP 주문 ID ${shape}: 장부에 가짜 번호를 적지 않는다`, () => {
      const row = db.row('live_orders', { id: 'ord-1' });
      assert(!row?.sl_order_id, '유효하지 않은 ID를 장부에 연결했다');
    });
  }

  // ══════════ ⑦ #494: STOP이라는 이름은 reduce-only 보증이 아니다 ══════════
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue([existingStop({ orderId: 8877, reduceOnly: false, closePosition: false })]);
    const r = await scenario(venue, () => reconcile(db));

    test('★★ 비보호 STOP이 이미 있으면 중복 STOP POST 0건', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 0, '위험한 STOP이 실재하므로 또 걸면 중복이다');
    });
    test('★★ 비보호 STOP은 장부에 연결하지 않고 attention으로 남긴다', () => {
      const row = db.row('live_orders', { id: 'ord-1' });
      eq(row?.needs_attention, true, '보호 기능 없는 STOP을 성공으로 기록했다');
      assert(!row?.sl_order_id, '비보호 STOP의 주문 ID를 보호 주문으로 연결했다');
      assert((r as any).details?.some((d: string) =>
        /손절/.test(d) && /미확인|보호|확인/.test(d)),
      `비보호 STOP의 위험 경고가 없다: ${JSON.stringify((r as any).details)}`);
    });
  }
  {
    const db = new FakeDb().seed('live_orders', [pendingRow()]);
    const venue = baseVenue([existingStop({ orderId: 8878, reduceOnly: false, closePosition: true })]);
    const r = await scenario(venue, () => reconcile(db));
    test('closePosition=true STOP은 기존 번호를 재연결하고 POST 0건', () => {
      assert(!(r instanceof Error), String((r as any)?.message));
      eq(stopSends(venue).length, 0);
      eq(String(db.row('live_orders', { id: 'ord-1' })?.sl_order_id ?? ''), '8878');
    });
  }

}
