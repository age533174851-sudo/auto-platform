// src/lib/exchanges/spotPrecision.test.ts
//
// **바이낸스 현물 실계좌 주문의 격자 정책을 값으로 고정한다 (Phase 4B-2A).**
//
// 이 파일이 막는 고장은 셋이다:
//
//   ① 시장가 주문을 **지정가 격자**로 깎는 것 — 거래소가 요구하지 않은
//      크기로 주문하게 된다. 4B-2A 이전의 현물 경로가 정확히 그랬다
//   ② 지정가 **가격을 안 맞추는 것** — PRICE_FILTER에 걸려 주문 자체가
//      거부되는데, 화면은 "주문 실패"라고만 말한다
//   ③ 매도를 진입과 같은 정책으로 막는 것 — 못 사는 것은 불편이고
//      **못 파는 것은 사고다**
//
// 실행부(`placeSpotOrder`)는 DB와 거래소를 탄다. 그래서 여기서는 그 함수가
// 부르는 **정본 함수들에 같은 입력을 넣어** 정책을 고정하고, 실행부가 실제로
// 그 정본을 그 자리에서 부르는지는 `scripts/check-spot-precision.mjs`가 본다.
// 값과 배선을 각각 다른 것이 지킨다.
import { test, eq, assert } from '../../test/harness';
import { normalizeForVenue, type VenueSpec } from '../markets/venueSpec';
import { roundSpotQty } from './binance';

/** 바이낸스 현물이 실제로 주는 모양. 네 필터가 각각 따로 있다 */
const spot = (o: Partial<VenueSpec> = {}): VenueSpec => ({
  venue: 'BINANCE_SPOT', symbol: 'BTCUSDT', source: 'EXCHANGE',
  tickSize: 0.01, stepSize: 0.00001, minQty: 0.00001, maxQty: null,
  minNotional: 5, marketStepSize: 0.00001, marketMinQty: 0.00001,
  multiplier: null, fetchedAt: Date.now(), ...o,
});

const unknown = (): VenueSpec => ({
  venue: 'BINANCE_SPOT', symbol: 'BTCUSDT', source: 'UNKNOWN',
  tickSize: null, stepSize: null, minQty: null, maxQty: null, minNotional: null,
  marketStepSize: null, marketMinQty: null, multiplier: null, fetchedAt: null,
});

export function runSpotPrecisionTests() {
  console.log('[현물 격자 — 시장가와 지정가는 다른 자로 잰다]');

  // ══════════ ① 주문유형별 격자 ══════════

  test('★ 시장가는 MARKET_LOT_SIZE로, 지정가는 LOT_SIZE로 깎는다', () => {
    // 두 격자가 다른 종목. 이 차이가 안 보이면 한쪽 자로 둘을 재고 있는 것이다.
    const s = spot({ stepSize: 0.001, minQty: 0.001, marketStepSize: 0.1, marketMinQty: 0.1 });

    const mkt = normalizeForVenue({
      spec: s, quantity: 0.35, orderType: 'MARKET', referencePrice: 100000,
    });
    const lim = normalizeForVenue({
      spec: s, quantity: 0.35, price: 100000, orderType: 'LIMIT',
    });

    assert(mkt.ok && lim.ok, `막혔습니다: ${mkt.reason} / ${lim.reason}`);
    eq(mkt.quantity, 0.3, '시장가가 지정가 격자로 깎였습니다');
    eq(lim.quantity, 0.35, '지정가가 시장가 격자로 깎였습니다');
    assert(mkt.quantity !== lim.quantity, '★ 두 주문유형이 같은 격자를 쓰고 있습니다');
  });

  test('★ 시장가 격자를 모르면 신규 매수를 보내지 않는다 (지정가 격자를 빌리지 않는다)', () => {
    const s = spot({ marketStepSize: null, marketMinQty: null });
    const buy = normalizeForVenue({
      spec: s, quantity: 1, orderType: 'MARKET', referencePrice: 100000, reduceOnly: false,
    });
    assert(!buy.ok, '모르는 격자로 신규 매수가 나갔습니다');
    eq(buy.code, 'QTY_FILTER_UNKNOWN');
  });

  test('★ 같은 상황에서 매도(청산)는 나간다 — 못 파는 것은 사고다', () => {
    const s = spot({ marketStepSize: null, marketMinQty: null });
    const sell = normalizeForVenue({
      spec: s, quantity: 1, orderType: 'MARKET', referencePrice: 100000, reduceOnly: true,
    });
    assert(sell.ok, `매도가 막혔습니다: ${sell.reason}`);
    assert(!sell.applied, '안 맞췄는데 맞췄다고 적혔습니다');
  });

  // ══════════ ② 지정가 가격 ══════════

  test('★ 지정가 가격을 tickSize에 맞춘다 — 안 맞추면 거래소가 통째로 거부한다', () => {
    const on = normalizeForVenue({
      spec: spot({ tickSize: 0.1 }), quantity: 1, price: 63093.05, orderType: 'LIMIT',
    });
    const off = normalizeForVenue({
      spec: spot({ tickSize: null }), quantity: 1, price: 63093.05, orderType: 'LIMIT',
    });
    eq(on.price, 63093.1, '가격이 호가 단위에 맞지 않았습니다');
    eq(off.price, 63093.05, 'tick이 없는데 가격이 바뀌었습니다');
    assert(on.price !== off.price, '★ tickSize가 가격에 아무 영향이 없습니다');
    assert(on.changed, '가격이 바뀐 사실이 안 남았습니다');
  });

  test('화면이 만드는 분할 지정가(균등 보간)가 격자 위로 올라온다', () => {
    // planSplit이 `fromPrice + step*i`로 만드는 값은 격자 위에 있을 이유가 없다.
    const raw = 60000 + ((61000 - 60000) / 2) * 1;   // 60500 — 여기서는 맞지만
    const odd = raw + 0.037;                          // 보간 결과는 대개 이렇다
    const r = normalizeForVenue({
      spec: spot({ tickSize: 0.01 }), quantity: 1, price: odd, orderType: 'LIMIT',
    });
    eq(r.price, 60500.04);
  });

  // ══════════ ③ 최소 명목가 ══════════

  test('★ 지정가는 그 가격으로 최소 명목가를 본다 — 기준가를 따로 읽지 않는다', () => {
    const r = normalizeForVenue({
      spec: spot({ minNotional: 10 }), quantity: 0.0001, price: 50, orderType: 'LIMIT',
    });
    assert(!r.ok, '최소 명목가 미달이 통과했습니다');
    eq(r.code, 'BELOW_MIN_NOTIONAL');
  });

  test('★ 시장가 매수는 서버가 읽은 기준가로 본다 — 없으면 지어내지 않고 막는다', () => {
    const noRef = normalizeForVenue({
      spec: spot({ minNotional: 10 }), quantity: 1, orderType: 'MARKET', referencePrice: null,
    });
    assert(!noRef.ok, '기준가 없이 최소 명목가를 통과했습니다');
    eq(noRef.code, 'REFERENCE_PRICE_UNKNOWN');

    const withRef = normalizeForVenue({
      spec: spot({ minNotional: 10 }), quantity: 1, orderType: 'MARKET', referencePrice: 100,
    });
    assert(withRef.ok, `기준가가 있는데 막혔습니다: ${withRef.reason}`);
  });

  test('★ 매도에는 최소 명목가를 적용하지 않는다 — 먼지 잔량을 가두지 않는다', () => {
    const r = normalizeForVenue({
      spec: spot({ minNotional: 10, stepSize: 0.00001, minQty: 0.00001,
                   marketStepSize: 0.00001, marketMinQty: 0.00001 }),
      quantity: 0.00002, orderType: 'MARKET', referencePrice: 100, reduceOnly: true,
    });
    assert(r.ok, `보유 잔량 매도가 막혔습니다: ${r.reason}`);
    eq(r.quantity, 0.00002);
  });

  // ══════════ 절충 정책 — 규격을 못 읽었을 때 ══════════

  test('★ 규격을 못 읽어도 매수는 나간다 (지금 나가던 주문을 새로 막지 않는다)', () => {
    const r = normalizeForVenue({ spec: unknown(), quantity: 0.0123456, orderType: 'MARKET' });
    assert(r.ok, '규격 조회 실패로 매수가 막혔습니다 — 절충 정책이 아닙니다');
    eq(r.quantity, 0.0123456, '없는 격자로 수량을 바꿨습니다');
    assert(!r.applied, '★ 안 맞췄는데 맞췄다고 적혔습니다');
    eq(r.source, 'UNKNOWN');
  });

  test('수량은 언제나 내림이다 — 요청보다 큰 주문이 나가지 않는다', () => {
    for (const [q, step, want] of [
      [0.0019, 0.001, 0.001], [0.999999, 0.1, 0.9], [7.7, 1, 7],
    ] as const) {
      const r = normalizeForVenue({
        spec: spot({ stepSize: step, minQty: null, marketStepSize: step, marketMinQty: null }),
        quantity: q, orderType: 'MARKET', referencePrice: 1_000_000,
      });
      assert(r.ok, `막혔습니다: ${r.reason}`);
      eq(r.quantity, want, `${q}가 ${r.quantity}로 나갔습니다`);
      assert((r.quantity as number) <= q, '★ 요청보다 큰 수량이 나갑니다');
    }
  });

  // ══════════ roundSpotQty — 우연히 맞던 자리 ══════════

  test('★ stepSize가 null이면 수량을 건드리지 않는다', () => {
    eq(roundSpotQty(0.12345, null), 0.12345);
    eq(roundSpotQty(0.12345, undefined), 0.12345);
  });

  test('★ stepSize가 NaN이면 NaN 수량을 만들지 않는다', () => {
    // 옛 판정은 `NaN <= 0`이 거짓이라 NaN을 통과시켰고, 그러면 수량이
    // NaN인 주문이 만들어진다.
    const r = roundSpotQty(0.12345, NaN);
    assert(Number.isFinite(r), `수량이 ${r}가 됐습니다`);
    eq(r, 0.12345);
  });

  test('stepSize가 있으면 내림한다', () => {
    eq(roundSpotQty(0.0019, 0.001), 0.001);
    eq(roundSpotQty(0.12345, 0), 0.12345);
  });
}
