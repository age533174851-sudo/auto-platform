// src/test/integration/gateStopReattachDbAckIntegration.test.ts
//
// **UPDATE가 0행이어도 "적었다"로 지나가는 자리.**
//
// Gate STOP 복구는 세 곳에 장부를 쓴다 — 경고(`needs_attention`),
// 기존 STOP ID 연결, 신규 STOP ID 기록. 세 곳 모두
// `sb.from('live_orders').update(...).eq('id', …)`의 `error`만 본다.
//
// Supabase는 **조건에 맞는 줄이 없으면 `error: null`로 0행을 갱신한다.**
// 그러면 아무것도 적히지 않았는데 성공 메시지가 나간다. 그 다음 회차는
// 장부가 비어 있는 것을 보고 **같은 STOP을 또 건다.**
//
// 같은 파일의 `updateOrderRow`는 이미 `.select('id')`로 **정확히 1행**을
// 확인하고 `{ok, reason}`을 돌려준다. 이 세 곳이 그 계약을 쓰지 않는 것이
// 이 시험이 보는 구멍이다 — 판단이 두 벌이면 언젠가 한쪽만 고쳐진다.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb } from './venueHarness';
import { reconcilePendingOrders } from '../../lib/engine/orderExecutor';

const PRICE = '/api/v4/futures/usdt/price_orders';
const CONTRACT = 'BTC_USDT';

const existingStop = (over: Record<string, any> = {}) => ({
  id: '9901', contract: CONTRACT, order_type: 'close-long-order',
  initial: { contract: CONTRACT, size: 0, auto_size: 'close_long', reduce_only: true },
  trigger: { rule: 2, price: '58920.9' }, ...over,
});

const row = (over: Record<string, any> = {}) => ({
  id: 'ord-1', client_order_id: 'COID-R1', symbol: 'BTCUSDT',
  exchange: 'gate', mode: 'TESTNET', side: 'BUY', quantity: 1,
  status: 'ACKED', filled_qty: 0, avg_price: null,
  sent_at: new Date(Date.now() - 600_000).toISOString(),
  created_at: new Date(Date.now() - 600_000).toISOString(),
  pos_qty_before: 0, resolve_attempts: 0, user_id: 'u1', connection_id: 'c1',
  stop_policy: 'FIXED_SL', stop_loss: 58920.9, sl_order_id: null, reduce_only: false,
  ...over,
});

/** 포지션·체결·사양은 정상이고 조건부 주문 목록만 시나리오별로 바꾼다 */
function venue(priceGet: any) {
  return new FakeVenue()
    .on(`/api/v4/futures/usdt/positions/${CONTRACT}`, { json: { contract: CONTRACT, size: 1 } }, 'GET')
    .on('/api/v4/futures/usdt/positions', { json: [{ contract: CONTRACT, size: 1 }] }, 'GET')
    .on('/api/v4/futures/usdt/orders', { json: (i: number) => i % 2 === 0 ? [] : [{
      id: '7001', contract: CONTRACT, status: 'finished', finish_as: 'filled',
      text: 't-COID-R1', size: 1, left: 0, fill_price: '60000',
    }] }, 'GET')
    .on(`/api/v4/futures/usdt/contracts/${CONTRACT}`, { json: {
      name: CONTRACT, quanto_multiplier: '0.001', order_price_round: '0.1',
      order_size_min: 1, order_size_max: 100000, leverage_max: 100,
    } }, 'GET')
    .on(PRICE, priceGet, 'GET')
    .on(PRICE, { json: { id: '8801' } }, 'POST');
}

async function run(v: FakeVenue, db: FakeDb) {
  const restore = v.install();
  try {
    const result = await reconcilePendingOrders(db as any, {
      exchange: 'gate', apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
      testnet: true, userId: 'u1', connectionId: 'c1',
    } as any);
    return { result: result as any, db };
  } finally { restore(); }
}

const hasKey = (k: string) => (p: Record<string, any>) =>
  Object.prototype.hasOwnProperty.call(p, k);

export async function runGateStopReattachDbAckTests() {
  console.log('[통합 — Gate STOP 복구의 장부 ACK (0행을 성공으로 적지 않는다)]');

  // ══════════ (a) 기존 STOP 연결 UPDATE 0행 ══════════
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'zero-rows', onlyWhen: hasKey('sl_order_id') },
    }).seed('live_orders', [row()]);
    const v = venue({ json: [existingStop()] });
    const { result } = await run(v, db);

    test('★★ (a) 기존 STOP 연결이 0행이면 "연결했다"로 적지 않는다', () => {
      eq(v.countOf(PRICE, 'POST'), 0, '이미 걸린 손절을 또 보냈다');
      const r = db.row('live_orders', { id: 'ord-1' });
      eq(r?.sl_order_id ?? null, null, '0행 갱신인데 장부에 ID가 생겼다');
      assert(result.needsAttention >= 1,
        '장부에 못 이었는데 경고가 0건이다 — 다음 회차가 같은 STOP을 또 건다');
      assert(result.details?.some((d: string) => /장부 연결 실패|0행|기록/.test(d)),
        `사유가 결과에 없다: ${JSON.stringify(result.details)}`);
    });
  }

  // ══════════ (b) 신규 STOP 전송 후 UPDATE 0행 ══════════
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'zero-rows', onlyWhen: hasKey('sl_order_id') },
    }).seed('live_orders', [row()]);
    const v = venue({ json: [] });                 // 걸린 STOP 없음 → 새로 보낸다
    const { result } = await run(v, db);

    test('★★ (b) 신규 STOP은 나갔는데 기록이 0행이면 완료로 적지 않는다', () => {
      eq(v.countOf(PRICE, 'POST'), 1, '이 회차에서는 STOP이 한 번 나가야 한다');
      const r = db.row('live_orders', { id: 'ord-1' });
      eq(r?.sl_order_id ?? null, null, '0행 갱신인데 장부에 ID가 생겼다');
      assert(result.needsAttention >= 1,
        'STOP은 걸렸는데 장부에 못 적었다 — 경고 없이 넘기면 다음 회차가 또 건다');
      assert(!result.details?.some((d: string) => /손절 복구 완료/.test(d)),
        `기록하지 못했는데 "복구 완료"로 적었다: ${JSON.stringify(result.details)}`);
    });
  }

  // ══════════ (c) 경고(needs_attention) UPDATE 0행 ══════════
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'zero-rows', onlyWhen: hasKey('needs_attention') },
    }).seed('live_orders', [row()]);
    // 목록이 비배열(HTTP 200 malformed) → fail-closed 경고 경로
    const v = venue({ json: { label: 'OK' } });
    const { result } = await run(v, db);

    test('★★ (c) 경고 기록이 0행이어도 반환 집계에서는 사라지지 않는다', () => {
      eq(v.countOf(PRICE, 'POST'), 0, '목록을 못 읽었는데 STOP을 보냈다');
      assert(result.needsAttention >= 1, '경고 집계가 0이다');
      assert(result.details?.some((d: string) => /경고 장부 기록도|0행|기록하지/.test(d)),
        `경고를 못 적었다는 사실이 결과에 없다: ${JSON.stringify(result.details)}`);
    });
  }

  // ══════════ (d) 오류 반환 · 예외 ══════════
  for (const mode of ['error', 'throw'] as const) {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode, onlyWhen: hasKey('sl_order_id') },
    }).seed('live_orders', [row()]);
    const v = venue({ json: [existingStop()] });
    const { result } = await run(v, db);

    test(`★★ (d) 기존 STOP 연결이 ${mode}로 실패하면 경고로 남는다`, () => {
      eq(v.countOf(PRICE, 'POST'), 0, '연결에 실패했다고 STOP을 새로 보냈다');
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id ?? null, null);
      assert(result.needsAttention >= 1, `${mode}인데 경고가 0건이다`);
    });
  }

  // ══════════ (e) 정상 — 정확히 1행 ══════════
  {
    const db = new FakeDb().seed('live_orders', [row()]);
    const v = venue({ json: [] });
    const { result } = await run(v, db);

    test('(e) 정상 기록은 예전처럼 1건 전송하고 ID를 적고 경고가 없다', () => {
      eq(v.countOf(PRICE, 'POST'), 1);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '8801');
      eq(result.needsAttention, 0, `정상인데 경고가 ${result.needsAttention}건이다`);
      assert(result.details?.some((d: string) => /손절 복구 완료/.test(d)),
        `완료가 적히지 않았다: ${JSON.stringify(result.details)}`);
    });
  }

  // ══════════ (f) 재시작 — 장부가 비어 있어도 다시 보내지 않는다 ══════════
  //
  // 기록에 실패한 뒤 프로세스가 다시 뜨면 장부에는 `sl_order_id`가 없다.
  // 그 상태를 "손절이 없다"로 읽으면, 거래소에 이미 걸린 STOP 위에 하나
  // 더 건다. **장부가 아니라 거래소 목록이 증거다.**
  //
  // (첫 회차가 끝나면 그 줄은 FILLED로 확정되어 대조 대상에서 빠진다.
  //  그래서 "같은 DB로 두 번"이 아니라 **기록이 끝내 안 된 상태로 다시
  //  뜬 경우**를 그대로 만든다.)
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'zero-rows', onlyWhen: hasKey('sl_order_id') },
    }).seed('live_orders', [row()]);
    const v = venue({ json: [existingStop()] });
    const { result } = await run(v, db);

    test('★★ (f) 장부가 비어 있어도 거래소에 STOP이 있으면 전송 0건', () => {
      eq(v.countOf(PRICE, 'POST'), 0,
        '장부가 비었다고 또 보냈다 — 기록 실패가 중복 주문이 된다');
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id ?? null, null);
      assert(result.needsAttention >= 1, '기록 실패가 경고로 남지 않았다');
    });
  }
}
