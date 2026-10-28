// src/test/integration/stopReattachMatrixIntegration.test.ts
//
// **두 거래소에 같은 질문을 같은 순서로 던진다.**
//
// 손절 복구는 Binance와 Gate 두 갈래가 각자 구현되어 있고, 통합마다
// 한쪽만 고쳐지는 일이 반복됐다(문자열 반환 ↔ 구조화 attention이 두 번
// 갈렸다). 그래서 **같은 여섯 상황**을 양쪽에 나란히 걸어 둔다:
//
//   ① 기존 손절 발견      ② 조회 실패      ③ 장부 0행 UPDATE
//   ④ 재시작(장부 비어 있음)  ⑤ 모호한 STOP   ⑥ 비보호 STOP
//
// 기존 파일(`stopReattachIdempotency…`·`gateStopReattach…`)이 이미 보는
// 것은 **다시 적지 않는다.** 여기 있는 것은 그 둘에서 비어 있던 칸이다:
// Binance의 0행 UPDATE·재시작·모호한 STOP, Gate의 모호한 STOP.
import { test, eq, assert } from '../harness';
import { FakeVenue, FakeDb, withCryptoEnv } from './venueHarness';
import { reconcilePendingOrders } from '../../lib/engine/orderExecutor';

// ── Binance ──
const BN_ORDER = '/fapi/v1/order';
const BN_POS = '/fapi/v2/positionRisk';
const BN_OPEN = '/fapi/v1/openOrders';
const BN_EXINFO = '/fapi/v1/exchangeInfo';
const SYM = 'STOPMTXUSDT';
const STOP_PX = 58920.9;

const bnRow = (over: Record<string, any> = {}) => ({
  id: 'ord-1', client_order_id: 'COID-MTX', symbol: SYM,
  exchange: 'binance', mode: 'TESTNET', side: 'BUY', quantity: 0.01,
  status: 'ACKED', filled_qty: 0, avg_price: null,
  stop_policy: 'FIXED_SL', stop_loss: STOP_PX, sl_order_id: null, reduce_only: false,
  sent_at: new Date(Date.now() - 600_000).toISOString(),
  created_at: new Date(Date.now() - 600_000).toISOString(),
  pos_qty_before: 0, resolve_attempts: 0, user_id: 'u1', connection_id: 'c1',
  ...over,
});

const bnStop = (over: Record<string, any> = {}) => ({
  orderId: 7777, symbol: SYM, side: 'SELL', type: 'STOP_MARKET',
  stopPrice: String(STOP_PX), status: 'NEW', reduceOnly: true, closePosition: false,
  ...over,
});

function bnVenue(openOrders: any): FakeVenue {
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
  v.on(BN_OPEN, { json: openOrders }, 'GET');
  v.on(BN_ORDER, { json: { orderId: 9501, symbol: SYM, status: 'NEW' } }, 'POST');
  return v;
}

// ── Gate ──
const PRICE = '/api/v4/futures/usdt/price_orders';
const CONTRACT = 'BTC_USDT';

const gtRow = (over: Record<string, any> = {}) => ({
  id: 'ord-1', client_order_id: 'COID-MTXG', symbol: 'BTCUSDT',
  exchange: 'gate', mode: 'TESTNET', side: 'BUY', quantity: 1,
  status: 'ACKED', filled_qty: 0, avg_price: null,
  stop_policy: 'FIXED_SL', stop_loss: 58920.9, sl_order_id: null, reduce_only: false,
  sent_at: new Date(Date.now() - 600_000).toISOString(),
  created_at: new Date(Date.now() - 600_000).toISOString(),
  pos_qty_before: 0, resolve_attempts: 0, user_id: 'u1', connection_id: 'c1',
  ...over,
});

const gtStop = (over: Record<string, any> = {}) => ({
  id: '9901', contract: CONTRACT, order_type: 'close-long-order',
  initial: { contract: CONTRACT, size: 0, auto_size: 'close_long', reduce_only: true },
  trigger: { rule: 2, price: '58920.9' }, ...over,
});

function gtVenue(priceGet: any): FakeVenue {
  return new FakeVenue()
    .on(`/api/v4/futures/usdt/positions/${CONTRACT}`, { json: { contract: CONTRACT, size: 1 } }, 'GET')
    .on('/api/v4/futures/usdt/positions', { json: [{ contract: CONTRACT, size: 1 }] }, 'GET')
    .on('/api/v4/futures/usdt/orders', { json: (i: number) => i % 2 === 0 ? [] : [{
      id: '7001', contract: CONTRACT, status: 'finished', finish_as: 'filled',
      text: 't-COID-MTXG', size: 1, left: 0, fill_price: '60000',
    }] }, 'GET')
    .on(`/api/v4/futures/usdt/contracts/${CONTRACT}`, { json: {
      name: CONTRACT, quanto_multiplier: '0.001', order_price_round: '0.1',
      order_size_min: 1, order_size_max: 100000, leverage_max: 100,
    } }, 'GET')
    .on(PRICE, priceGet, 'GET')
    .on(PRICE, { json: { id: '8801' } }, 'POST');
}

async function run(v: FakeVenue, db: FakeDb, exchange: 'binance' | 'gate') {
  const restore = v.install();
  const unenv = withCryptoEnv();
  try {
    const result: any = await reconcilePendingOrders(db as any, {
      exchange, apiKey: 'K'.repeat(64), apiSecret: 'S'.repeat(64),
      testnet: true, userId: 'u1', connectionId: 'c1',
    } as any);
    return result;
  } catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
  finally { restore(); unenv(); }
}

const bnStopSends = (v: FakeVenue) =>
  v.orderSends().filter((c) => String(c.params.type ?? '').includes('STOP'));

const hasKey = (k: string) => (p: Record<string, any>) =>
  Object.prototype.hasOwnProperty.call(p, k);

export async function runStopReattachMatrixTests() {
  console.log('[통합 — 손절 복구 여섯 상황 × 두 거래소]');

  // ══════════ Binance ③ 장부 0행 UPDATE ══════════
  //
  // 기존 시험은 `mode: 'error'`만 봤다. **0행 갱신은 오류가 없어서**
  // 더 조용하다 — Gate 쪽은 #500에서 이미 이 칸을 메웠고, Binance 쪽은
  // 비어 있었다.
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'zero-rows', onlyWhen: hasKey('sl_order_id') },
    }).seed('live_orders', [bnRow()]);
    const v = bnVenue([]);                       // 걸린 손절 없음 → 새로 보낸다
    const r = await run(v, db, 'binance');

    test('★★ [Binance] 신규 STOP 기록이 0행이면 완료로 적지 않는다', () => {
      assert(!(r instanceof Error), String(r?.message));
      eq(bnStopSends(v).length, 1, '이 회차에서는 STOP이 한 번 나가야 한다');
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id ?? null, null,
        '0행 갱신인데 장부에 ID가 생겼다');
      assert(r.needsAttention >= 1, '기록 실패가 경고 없이 사라졌다');
      assert(!r.details?.some((d: string) => /손절 복구 완료/.test(d)),
        `기록하지 못했는데 "복구 완료"로 적었다: ${JSON.stringify(r.details)}`);
    });
  }

  // ══════════ Binance ④ 재시작 — 장부는 비었고 거래소에는 있다 ══════════
  {
    const db = new FakeDb({
      updateFailure: { table: 'live_orders', mode: 'zero-rows', onlyWhen: hasKey('sl_order_id') },
    }).seed('live_orders', [bnRow()]);
    const v = bnVenue([bnStop()]);
    const r = await run(v, db, 'binance');

    test('★★ [Binance] 장부가 비어 있어도 거래소에 STOP이 있으면 전송 0건', () => {
      assert(!(r instanceof Error), String(r?.message));
      eq(bnStopSends(v).length, 0,
        '장부가 비었다고 또 보냈다 — 기록 실패가 중복 주문이 된다');
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id ?? null, null);
      assert(r.needsAttention >= 1, '연결 실패가 경고로 남지 않았다');
    });
  }

  // ══════════ Binance ⑤ 모호한 STOP — 같은 발동가 보호주문 두 건 ══════════
  //
  // 한 건을 골라 장부에 이으면 나머지 하나는 **보이지 않는 보호주문**이
  // 된다. 하나가 발동해 포지션이 닫히면 남은 것이 반대 노출을 연다.
  // Gate 갈래는 이미 '복수 발견 — 자동 선택 금지'로 막는다.
  {
    const db = new FakeDb().seed('live_orders', [bnRow()]);
    const v = bnVenue([bnStop({ orderId: 7777 }), bnStop({ orderId: 8888 })]);
    const r = await run(v, db, 'binance');

    test('★★ [Binance] 같은 발동가 STOP이 둘이면 하나를 골라 잇지 않는다', () => {
      assert(!(r instanceof Error), String(r?.message));
      eq(bnStopSends(v).length, 0, '모호한 상태에서 STOP을 또 보냈다');
      const row = db.row('live_orders', { id: 'ord-1' });
      assert(!row?.sl_order_id,
        `두 건 중 하나(${row?.sl_order_id})를 보호주문으로 확정했다`
        + ' — 나머지 하나는 추적되지 않는 보호주문으로 남는다');
      eq(row?.needs_attention, true, '모호한데 attention이 없다');
    });
  }

  // ══════════ Binance ⑥ 비보호 STOP (회귀 — #495·#496) ══════════
  {
    const db = new FakeDb().seed('live_orders', [bnRow()]);
    const v = bnVenue([bnStop({ orderId: 8877, reduceOnly: false, closePosition: false })]);
    const r = await run(v, db, 'binance');

    test('[Binance] 비보호 STOP은 연결하지 않고 전송도 하지 않는다 (회귀)', () => {
      assert(!(r instanceof Error), String(r?.message));
      eq(bnStopSends(v).length, 0);
      const row = db.row('live_orders', { id: 'ord-1' });
      assert(!row?.sl_order_id);
      eq(row?.needs_attention, true);
    });
  }

  // ══════════ Gate ⑤ 모호한 STOP (회귀) ══════════
  {
    const db = new FakeDb().seed('live_orders', [gtRow()]);
    const v = gtVenue({ json: [gtStop({ id: '9901' }), gtStop({ id: '9902' })] });
    const r = await run(v, db, 'gate');

    test('[Gate] 같은 포지션 STOP이 둘이면 자동 선택하지 않는다 (회귀)', () => {
      assert(!(r instanceof Error), String(r?.message));
      eq(v.countOf(PRICE, 'POST'), 0, '모호한데 STOP을 또 보냈다');
      const row = db.row('live_orders', { id: 'ord-1' });
      assert(!row?.sl_order_id, `둘 중 하나(${row?.sl_order_id})를 골라 이었다`);
      assert(r.needsAttention >= 1, '모호한데 경고가 없다');
    });
  }

  // ══════════ Gate ① 기존 손절 발견 (회귀) ══════════
  {
    const db = new FakeDb().seed('live_orders', [gtRow()]);
    const v = gtVenue({ json: [gtStop()] });
    const r = await run(v, db, 'gate');

    test('[Gate] 기존 STOP 하나면 연결하고 전송 0건 (회귀)', () => {
      assert(!(r instanceof Error), String(r?.message));
      eq(v.countOf(PRICE, 'POST'), 0);
      eq(db.row('live_orders', { id: 'ord-1' })?.sl_order_id, '9901');
      eq(r.needsAttention, 0, `정상인데 경고가 ${r.needsAttention}건이다`);
    });
  }

  // ══════════ Gate ② 조회 실패 (회귀) ══════════
  {
    const db = new FakeDb().seed('live_orders', [gtRow()]);
    const v = gtVenue({ status: 503, json: { label: 'SERVICE_UNAVAILABLE' } });
    const r = await run(v, db, 'gate');

    test('[Gate] 조건부 주문 목록을 못 읽으면 전송 0건 + attention (회귀)', () => {
      assert(!(r instanceof Error), String(r?.message));
      eq(v.countOf(PRICE, 'POST'), 0, '못 읽었는데 STOP을 보냈다');
      assert(r.needsAttention >= 1);
      eq(db.row('live_orders', { id: 'ord-1' })?.needs_attention, true);
    });
  }
}
