// Offline Gate STOP reattach regression: real reconcilePendingOrders + FakeVenue/FakeDb.
// Never touches an exchange account or production database.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb } from './venueHarness';
import { reconcilePendingOrders } from '../../lib/engine/orderExecutor';

const PRICE = '/api/v4/futures/usdt/price_orders';
const CONTRACT = 'BTC_USDT';
const stop = (over: Record<string, any> = {}) => ({
  id: '9901', contract: CONTRACT, order_type: 'close-long-order',
  initial: { contract: CONTRACT, size: 0, auto_size: 'close_long', reduce_only: true },
  trigger: { rule: 2, price: '58920.9' }, ...over,
});
const row = () => ({
  id: 'ord-1', client_order_id: 'COID-R1', symbol: 'BTCUSDT',
  exchange: 'gate', mode: 'TESTNET', side: 'BUY', quantity: 1,
  status: 'ACKED', filled_qty: 0, avg_price: null,
  sent_at: new Date(Date.now() - 600_000).toISOString(),
  created_at: new Date(Date.now() - 600_000).toISOString(),
  pos_qty_before: 0, resolve_attempts: 0, user_id: 'u1', connection_id: 'c1',
  stop_policy: 'FIXED_SL', stop_loss: 58920.9, sl_order_id: null, reduce_only: false,
});
function venueWith(
  priceReply: { status?: number; json?: any; throws?: string },
  positionReply: { status?: number; json?: any; throws?: string } = { json: { contract: CONTRACT, size: 1 } },
) {
  const position = { contract: CONTRACT, size: 1 };
  return new FakeVenue()
    .on('/api/v4/futures/usdt/positions/' + CONTRACT, positionReply, 'GET')
    .on('/api/v4/futures/usdt/positions', { json: [position] }, 'GET')
    .on('/api/v4/futures/usdt/orders', { json: (i: number) => i % 2 === 0 ? [] : [{
      id: '7001', contract: CONTRACT, status: 'finished', finish_as: 'filled',
      text: 't-COID-R1', size: 1, left: 0, fill_price: '60000',
    }] }, 'GET')
    .on('/api/v4/futures/usdt/contracts/' + CONTRACT, { json: {
      name: CONTRACT, quanto_multiplier: '0.001', order_price_round: '0.1',
      order_size_min: 1, order_size_max: 100000, leverage_max: 100,
    } }, 'GET')
    .on(PRICE, priceReply, 'GET')
    .on(PRICE, { json: { id: '8801' } }, 'POST');
}
async function run(v: FakeVenue, db = new FakeDb().seed('live_orders', [row()])) {
  const restore = v.install();
  try {
    const result = await reconcilePendingOrders(db as any, {
      exchange: 'gate', apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
      testnet: true, userId: 'u1', connectionId: 'c1',
    });
    return { result, db };
  } finally { restore(); }
}
export async function runGateStopReattachTests() {
  console.log('[통합 — Gate 손절 중복 부착 방지 / Issue #491]');

  {
    const v = venueWith({ json: [stop()] });
    const { result, db } = await run(v);
    test('★★ 기존 Gate STOP이 있으면 추가 price_orders POST 0건', () => {
      eq(result.resolved, 1);
      eq(v.countOf(PRICE, 'POST'), 0, '이미 걸린 손절을 또 보냈다');
    });
    test('★★ 기존 STOP ID를 장부에 연결한다', () => {
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '9901');
    });
  }

  {
    const v = venueWith({ json: { label: 'OK' } }); // malformed HTTP 200
    const { result, db } = await run(v);
    test('★★ Gate 조건부 목록을 못 읽으면 손절을 새로 보내지 않는다', () => {
      eq(v.countOf(PRICE, 'POST'), 0, '비배열 200을 빈 목록으로 읽었다');
      assert(result.details.some(x => x.includes('미확인')), '조회 실패 사유가 없다');
    });
    test('★★ 조회 미확인은 장부와 집계에 attention으로 남는다', () => {
      assert(result.needsAttention >= 1, 'attention 집계가 없다');
      eq(db.row('live_orders', { id: 'ord-1' })?.needs_attention, true);
    });
  }

  {
    const v = venueWith({ json: [] });
    const { db } = await run(v);
    test('★★ 정말 STOP이 없을 때만 Gate 복구 POST 정확히 1건', () => {
      eq(v.countOf(PRICE, 'POST'), 1);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '8801');
    });
  }

  {
    const v = venueWith({ json: [stop({ id: '9912', trigger: { rule: 1, price: '61000' } })] });
    const { db } = await run(v);
    test('★★ Gate TAKE_PROFIT은 STOP으로 잘못 연결하지 않는다', () => {
      eq(v.countOf(PRICE, 'POST'), 1);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '8801');
    });
  }

  {
    const v = venueWith({ json: [stop({ trigger: { rule: 9, price: '58920.9' } })] });
    const { result } = await run(v);
    test('★★ 모호한 같은 계약 조건부 주문이 있으면 추가 POST 0건', () => {
      eq(v.countOf(PRICE, 'POST'), 0);
      assert(result.details.some(x => x.includes('미확인')), '모호한 주문이 조용히 무시됐다');
    });
  }

  {
    // 첫 100건은 다른 계약, 101번째에 진짜 STOP이 있다.
    let v: FakeVenue;
    const other = Array.from({ length: 100 }, (_, i) => stop({
      id: String(1000 + i), contract: 'ETH_USDT',
      initial: { contract: 'ETH_USDT', size: 0, auto_size: 'close_long', reduce_only: true },
    }));
    v = venueWith({ json: () => {
      const last = v.calls[v.calls.length - 1];
      return Number(last?.params?.offset ?? 0) === 0 ? other : [stop()];
    } });
    const { db } = await run(v);
    test('★★ 101번째 Gate STOP도 조회하고 재전송하지 않는다', () => {
      eq(v.countOf(PRICE, 'GET'), 2, '첫 100건만 읽었다');
      eq(v.countOf(PRICE, 'POST'), 0);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '9901');
    });
  }

  {
    // POST가 이미 성공했지만 DB 쓰기 실패. 다음 회차는 거래소 STOP을 발견한다.
    const db = new FakeDb({ failUpdatesOn: 'live_orders' }).seed('live_orders', [row()]);
    const v = venueWith({ json: (i: number) => i === 0 ? [] : [stop({ id: '8801' })] });
    const first = await run(v, db);
    const second = await run(v, db);
    test('★★ Gate 손절 전송 후 DB 기록 실패는 경고로 남는다', () => {
      eq(v.countOf(PRICE, 'POST'), 1, '첫 회차에서 정확히 1건이어야 한다');
      assert(first.result.details.some(x => x.includes('장부 기록 실패')), 'DB 기록 실패가 조용히 사라졌다');
      assert(first.result.needsAttention >= 1, 'DB 실패 attention 누락');
    });
    test('★★ DB 기록 실패 후 재시작해도 같은 Gate STOP을 또 보내지 않는다', () => {
      eq(v.countOf(PRICE, 'POST'), 1, '두 번째 대조가 중복 POST했다');
      assert(second.result.needsAttention >= 1, '기존 STOP 연결 실패 attention 누락');
    });
  }

  {
    const db = new FakeDb().seed('live_orders', [{ ...row(), stop_policy: 'NO_FIXED_SL' }]);
    const v = venueWith({ json: [] });
    await run(v, db);
    test('★★ NO_FIXED_SL은 Gate 손절 조회·재부착 자체를 하지 않는다', () => {
      eq(v.countOf(PRICE, 'GET'), 0);
      eq(v.countOf(PRICE, 'POST'), 0);
    });
  }

  // #498: 계약별 포지션 조회 실패와 정상 flat(0)은 서로 다른 사실이다.
  // Gate 조회 실패/수량 불량은 손절이 필요할 수 있으므로 반드시 attention으로 남긴다.
  for (const [label, positionReply] of [
    ['HTTP 500', { status: 500, json: { message: 'unavailable' } }],
    ['null 응답', { json: null }],
    ['NaN 수량', { json: { contract: CONTRACT, size: 'NaN' } }],
    ['Infinity 수량', { json: { contract: CONTRACT, size: 'Infinity' } }],
    ['빈 문자열 수량', { json: { contract: CONTRACT, size: '' } }],
    ['공백 수량', { json: { contract: CONTRACT, size: ' ' } }],
    ['수량 필드 누락', { json: { contract: CONTRACT } }],
  ] as Array<[string, { status?: number; json?: any }]>) {
    const v = venueWith({ json: [] }, positionReply);
    const { result, db } = await run(v);
    test(`★★ Gate 포지션 ${label}은 손절 복구 실패를 조용히 무시하지 않는다`, () => {
      eq(v.countOf(PRICE, 'POST'), 0, '불확실한 포지션에 손절을 보내면 안 된다');
      eq(v.countOf(PRICE, 'GET'), 0, '포지션 판정 전에 조건부 주문을 조회했다');
      assert(result.needsAttention >= 1, '포지션 미확인 attention 집계가 없다');
      eq(db.row('live_orders', { id: 'ord-1' })?.needs_attention, true);
      assert(result.details.some(x => x.includes('포지션') && x.includes('미확인')),
        '포지션 조회/수량 미확인 경고가 없다');
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, null);
    });
  }

  {
    const v = venueWith({ json: [] }, { json: { contract: CONTRACT, size: '0' } });
    const { result, db } = await run(v);
    test('★★ Gate 포지션 수량 정상 0은 손절 복구하지 않는다', () => {
      eq(v.countOf(PRICE, 'POST'), 0);
      eq(v.countOf(PRICE, 'GET'), 0);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, null);
      eq(result.needsAttention, 0);
    });
  }
  // #498 후속: Gate 응답의 계약 근거가 없거나 서로 모순되면
  // 다른 계약의 STOP을 이 포지션의 보호주문으로 연결할 수 없다.
  {
    const v = venueWith({ json: [stop({
      contract: null,
      initial: { size: 0, auto_size: 'close_long', reduce_only: true },
    })] });
    const { result, db } = await run(v);
    test('★★ Gate STOP 계약 근거 누락은 기존 ID 연결 금지·POST 0·attention', () => {
      eq(v.countOf(PRICE, 'POST'), 0, '계약 불명의 STOP을 보고 새 손절을 보내면 안 된다');
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, null,
        '계약을 모르는 STOP ID를 내 포지션에 연결했다');
      assert(result.needsAttention >= 1, '계약 불명 attention 누락');
      assert(result.details.some(x => x.includes('계약') && x.includes('미확인')),
        '계약 불명 경고 누락');
    });
  }

  {
    const v = venueWith({ json: [stop({
      contract: 'ETH_USDT',
      initial: { contract: CONTRACT, size: 0, auto_size: 'close_long', reduce_only: true },
    })] });
    const { result, db } = await run(v);
    test('★★ Gate STOP 상위/initial 계약 불일치는 ID 연결 금지·POST 0·attention', () => {
      eq(v.countOf(PRICE, 'POST'), 0);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, null,
        '서로 모순되는 계약의 STOP ID를 연결했다');
      assert(result.needsAttention >= 1, '계약 불일치 attention 누락');
      assert(result.details.some(x => x.includes('계약') && x.includes('불일치')),
        '계약 불일치 경고 누락');
    });
  }

  {
    const v = venueWith({ json: [stop({
      initial: { size: 0, auto_size: 'close_long', reduce_only: true },
    })] });
    const { result, db } = await run(v);
    test('★★ Gate STOP 상위 contract만 유효한 정상 응답은 기존 ID 연결 유지', () => {
      eq(v.countOf(PRICE, 'POST'), 0);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '9901');
      eq(result.needsAttention, 0);
    });
  }

}
