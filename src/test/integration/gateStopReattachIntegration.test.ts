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
function venueWith(priceReply: { status?: number; json?: any; throws?: string }) {
  const position = { contract: CONTRACT, size: 1 };
  return new FakeVenue()
    .on('/api/v4/futures/usdt/positions/' + CONTRACT, { json: position }, 'GET')
    .on('/api/v4/futures/usdt/positions', { json: [position] }, 'GET')
    .on('/api/v4/futures/usdt/orders', { json: (i: number) => i === 0 ? [] : [{
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
}
