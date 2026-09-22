// src/lib/markets/venueSpec.test.ts
//
// **주문이 거래소 격자를 벗어나지 못하게 하는 계약을 여기서 고정한다.**
//
// 이 파일이 막는 고장 중 가장 조용한 것은 **"맞춘 줄 알고 보내는 것"**이다.
// 격자를 못 읽었는데 기본값으로 반올림하면, 화면에도 로그에도 "맞췄다"고
// 남는다. 나중에 거래소가 거부해도 왜인지 알 수 없다.
import { test, eq, assert } from '../../test/harness';
import {
  normalizeForVenue, filtersOf, specUsable, unknownSpec, venueForPaperMarket,
  VENUES, VENUE_LABEL, SPEC_SOURCE_LABEL,
  type VenueSpec, type VenueId, type SpecSource,
} from './venueSpec';

const spec = (o: Partial<VenueSpec> = {}): VenueSpec => ({
  venue: 'BINANCE_SPOT', symbol: 'BTCUSDT', source: 'EXCHANGE',
  tickSize: 0.01, stepSize: 0.001, minQty: 0.001, maxQty: null,
  minNotional: 10, marketStepSize: 0.001, marketMinQty: 0.001,
  multiplier: null, fetchedAt: Date.now(), ...o,
});

export function runVenueSpecTests() {
  console.log('[거래소 격자 — 맞춘 척을 하지 않는다]');

  // ══════════ 격자를 실제로 적용한다 ══════════

  test('★ stepSize로 내린다 (반올림이 아니라 내림)', () => {
    const r = normalizeForVenue({
      spec: spec({ stepSize: 0.001, marketStepSize: 0.001 }),
      quantity: 0.0019, referencePrice: 100000,
    });
    assert(r.ok, `막혔습니다: ${r.reason}`);
    eq(r.quantity, 0.001);
    assert(r.changed, '바뀐 사실이 안 남았습니다');
    assert(r.applied, '적용했다고 안 적혔습니다');
  });

  test('★ stepSize를 무시하면 격자 밖 수량이 나간다 — 그럴 수 없다', () => {
    const r = normalizeForVenue({
      spec: spec({ stepSize: 0.1, marketStepSize: 0.1 }),
      quantity: 0.35, referencePrice: 100000,
    });
    assert(r.ok, `막혔습니다: ${r.reason}`);
    eq(r.quantity, 0.3);
  });

  test('★ minQty 미달은 막는다', () => {
    const r = normalizeForVenue({
      spec: spec({ stepSize: 0.001, minQty: 0.01, marketStepSize: 0.001, marketMinQty: 0.01 }),
      quantity: 0.005, referencePrice: 100000,
    });
    assert(!r.ok, '최소 수량 미달이 통과했습니다');
    eq(r.code, 'BELOW_MIN_QTY');
  });

  test('★ minNotional 미달은 막는다', () => {
    const r = normalizeForVenue({
      spec: spec({ minNotional: 10 }),
      quantity: 0.001, referencePrice: 100,   // 0.1 USDT
    });
    assert(!r.ok, '최소 명목가 미달이 통과했습니다');
    eq(r.code, 'BELOW_MIN_NOTIONAL');
  });

  test('★ venue가 최대 수량을 고시하면 그것도 본다', () => {
    const r = normalizeForVenue({
      spec: spec({ maxQty: 1 }), quantity: 5, referencePrice: 100000,
    });
    assert(!r.ok, '최대 수량 초과가 통과했습니다');
    eq(r.code, 'ABOVE_MAX_QTY');
  });

  test('★ 내렸더니 0이 되면 보내지 않는다', () => {
    const r = normalizeForVenue({
      spec: spec({ stepSize: 1, minQty: null, marketStepSize: 1, marketMinQty: null }),
      quantity: 0.4, referencePrice: 100000,
    });
    assert(!r.ok, '0 수량 주문이 통과했습니다');
    assert(r.quantity == null || r.quantity === 0, `수량이 남아 있습니다: ${r.quantity}`);
  });

  // ══════════ ★ 가격도 격자 위에 놓인다 ══════════
  //
  // 수량만 보다가 tickSize를 버리는 변경이 한 번 그대로 통과했다
  // (MUT-V1). 지정가는 가격이 틀리면 그 자체로 거부된다.

  test('★ 지정가 가격을 tickSize에 맞춘다', () => {
    const r = normalizeForVenue({
      spec: spec({ tickSize: 0.5 }), quantity: 1, price: 100.37, orderType: 'LIMIT',
    });
    assert(r.ok, `막혔습니다: ${r.reason}`);
    eq(r.price, 100.5);
  });

  test('★ tickSize를 버리면 격자 밖 가격이 나간다 — 값으로 막는다', () => {
    const on = normalizeForVenue({
      spec: spec({ tickSize: 10 }), quantity: 1, price: 103, orderType: 'LIMIT',
    });
    const off = normalizeForVenue({
      spec: spec({ tickSize: null }), quantity: 1, price: 103, orderType: 'LIMIT',
    });
    eq(on.price, 100, '가격이 tick에 맞지 않았습니다');
    eq(off.price, 103, 'tick이 없는데 가격이 바뀌었습니다');
    assert(on.price !== off.price, '★ tickSize가 가격에 아무 영향이 없습니다');
  });

  test('tickSize가 격자에 실려 간다', () => {
    const f = filtersOf(spec({ tickSize: 0.25 }));
    eq(f!.tickSize, 0.25);
  });

  // ══════════ ★ 절충 정책 — 못 읽으면 보내되 적는다 ══════════

  test('★ 격자를 못 읽으면 보내되 applied=false로 적는다', () => {
    const r = normalizeForVenue({
      spec: unknownSpec('BINANCE_SPOT', 'BTCUSDT'), quantity: 0.12345,
    });
    assert(r.ok, '못 읽었다고 막았습니다 — 절충 정책이 아닙니다');
    eq(r.quantity, 0.12345);
    assert(!r.applied, '★ 안 맞췄는데 맞췄다고 적혔습니다');
    eq(r.source, 'UNKNOWN');
    assert(/규격을 읽지 못/.test(r.reason), `사유가 그 사실을 말하지 않습니다: ${r.reason}`);
  });

  test('★ 못 읽었을 때 수량을 임의 기본값 격자로 바꾸지 않는다', () => {
    for (const q of [0.123456789, 7, 0.000001]) {
      const r = normalizeForVenue({ spec: unknownSpec('BINANCE_USDM', 'X'), quantity: q });
      eq(r.quantity, q, `${q}가 바뀌었습니다 — 없는 격자로 맞췄습니다`);
      assert(!r.changed, '바꾸지 않았는데 바꿨다고 적혔습니다');
    }
  });

  test('캐시에서 온 격자도 적용한다 (source만 다르다)', () => {
    const r = normalizeForVenue({
      spec: spec({ source: 'CACHED', stepSize: 0.1, marketStepSize: 0.1 }),
      quantity: 0.35, referencePrice: 100000,
    });
    assert(r.ok && r.applied, '캐시 격자가 적용되지 않았습니다');
    eq(r.quantity, 0.3);
    eq(r.source, 'CACHED');
  });

  // ══════════ ★ 격자를 섞지 않는다 ══════════

  test('★ 시장가 격자가 없으면 지정가 격자를 빌려 쓰지 않는다', () => {
    const f = filtersOf(spec({ marketStepSize: null, marketMinQty: null }));
    assert(f != null, '필터가 비었습니다');
    eq(f!.marketQty, null, '★ 시장가 격자를 지정가에서 복사했습니다');
    assert(f!.limitQty != null, '지정가 격자가 사라졌습니다');
  });

  test('★ 시장가 격자를 모르면 시장가 주문을 막는다', () => {
    const r = normalizeForVenue({
      spec: spec({ marketStepSize: null, marketMinQty: null }),
      quantity: 1, orderType: 'MARKET', referencePrice: 100000,
    });
    assert(!r.ok, '모르는 격자로 시장가가 나갔습니다');
    eq(r.code, 'QTY_FILTER_UNKNOWN');
  });

  test('★ venue가 값에 실려 다닌다 — 현물 격자를 선물에 쓸 수 없다', () => {
    const s = normalizeForVenue({ spec: spec({ venue: 'BINANCE_SPOT' }), quantity: 1, referencePrice: 100000 });
    const f = normalizeForVenue({ spec: spec({ venue: 'BINANCE_USDM' }), quantity: 1, referencePrice: 100000 });
    eq(s.venue, 'BINANCE_SPOT');
    eq(f.venue, 'BINANCE_USDM');
    assert(s.venue !== f.venue, '두 venue가 같게 나왔습니다');
  });

  test('★ USDT-M과 COIN-M은 다른 venue다', () => {
    assert(VENUES.includes('BINANCE_USDM') && VENUES.includes('BINANCE_COINM'),
      '두 선물 venue가 따로 있지 않습니다');
  });

  // ══════════ venue를 모르면 막는다 ══════════

  test('★ venue를 모르면 주문을 맞추지 못한다 — fallback이 없다', () => {
    for (const bad of [null, undefined]) {
      const r = normalizeForVenue({ spec: bad, quantity: 1 });
      assert(!r.ok, 'venue 없이 통과했습니다');
      eq(r.code, 'VENUE_UNKNOWN');
      assert(!r.applied, '맞췄다고 적혔습니다');
    }
  });

  test('수량이 숫자가 아니면 막는다', () => {
    for (const q of [0, -1, NaN]) {
      const r = normalizeForVenue({ spec: spec(), quantity: q as number });
      assert(!r.ok, `${q}가 통과했습니다`);
    }
  });

  // ══════════ ★ 모의는 어느 venue를 모사하는가 ══════════

  test('★ 모의 SPOT은 바이낸스 현물, USDM은 바이낸스 선물이다', () => {
    eq(venueForPaperMarket('SPOT'), 'BINANCE_SPOT');
    eq(venueForPaperMarket('USDM'), 'BINANCE_USDM');
  });

  test('★ 모르는 모의 시장은 null — 기본으로 현물을 쓰지 않는다', () => {
    for (const m of ['COINM', 'STOCK', '', null, undefined, 'spot']) {
      eq(venueForPaperMarket(m), null, `${JSON.stringify(m)}에 venue가 붙었습니다`);
    }
  });

  // ══════════ 모양 ══════════

  test('못 읽은 스펙은 모든 칸이 null이다 — 0이 아니다', () => {
    const u = unknownSpec('KIS_KR', '005930');
    assert(!specUsable(u), '못 읽은 스펙이 쓸 수 있다고 나왔습니다');
    for (const k of ['tickSize', 'stepSize', 'minQty', 'maxQty', 'minNotional',
                     'marketStepSize', 'marketMinQty', 'multiplier'] as const) {
      eq(u[k], null, `${k}가 null이 아닙니다`);
    }
    eq(filtersOf(u), null);
  });

  test('venue·출처 전부에 라벨이 있다', () => {
    for (const v of VENUES) assert(VENUE_LABEL[v]?.length > 0, `${v} 라벨 없음`);
    for (const s of ['EXCHANGE', 'KNOWN', 'CACHED', 'UNKNOWN'] as SpecSource[]) {
      assert(SPEC_SOURCE_LABEL[s]?.length > 0, `${s} 라벨 없음`);
    }
  });

  test('청산은 격자를 못 읽어도 나간다 (포지션에 갇히지 않는다)', () => {
    const r = normalizeForVenue({
      spec: unknownSpec('BINANCE_USDM', 'BTCUSDT'), quantity: 1, reduceOnly: true,
    });
    assert(r.ok, '청산이 막혔습니다');
  });
}
