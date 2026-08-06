// src/lib/engine/orderIntent.test.ts
//
// 막으려는 것:
//  1. **청산하려다 반대 포지션을 여는 것.** 롱 보유 + [청산] + 매도는
//     롱이 줄지만, 롱 보유 + [신규] + 매도는 숏이 새로 열린다. 화면에서는
//     둘 다 '매도 주문'으로 보인다 — 이 저장소에서 가장 조용한 사고다
//  2. 주문 유형만 바꾸고 이전 값이 남아 전송되는 것 (지정가 → 시장가인데
//     price가 남거나, 조건부 → 일반인데 stopPrice가 남는 것)
//  3. 보유 수량을 못 읽었는데 0으로 눕혀, 청산 주문이 신규로 나가는 것
//  4. 포지션 모드를 추측해서 주문을 만드는 것
//  5. 버린 값을 조용히 버려, "지정가를 넣었는데 시장가로 나갔다"를
//     설명할 수 없게 되는 것
import { test, assert, eq } from '../../test/harness';
import {
  buildOrderPayload, orderKindOf, fieldsToClearOnKindChange,
  ALLOWED_FIELDS, REQUIRED_FIELDS,
} from './orderIntent';

const base = { symbol: 'BTCUSDT', positionMode: 'ONE_WAY' as const };

export function runOrderIntentTests() {
  console.log('[주문 구성 — 유형이 정한 필드만 나간다]');

  test('시장가에는 가격이 안 실린다', () => {
    // 지정가에서 시장가로 바꿔도 price가 상태에 남아 있다.
    const r = buildOrderPayload({ ...base, kind: 'MARKET', side: 'BUY', quantity: 1, price: 64000 });
    eq(r.ok, true, r.reason);
    eq(r.payload.price, undefined);
    assert(r.dropped.includes('price'), r.dropped.join(','));
  });

  test('일반 주문에는 트리거 가격이 안 실린다', () => {
    const r = buildOrderPayload({ ...base, kind: 'LIMIT', side: 'BUY', quantity: 1, price: 64000, stopPrice: 63000 });
    eq(r.ok, true, r.reason);
    eq(r.payload.stopPrice, undefined);
    assert(r.dropped.includes('stopPrice'), r.dropped.join(','));
  });

  test('버린 것을 조용히 버리지 않는다', () => {
    // "지정가를 넣었는데 시장가로 나갔다"를 설명할 수 있어야 한다.
    const r = buildOrderPayload({
      ...base, kind: 'MARKET', side: 'BUY', quantity: 1,
      price: 64000, stopPrice: 63000, callbackRate: 1,
    });
    eq(r.dropped.sort().join(','), 'callbackRate,price,stopPrice');
  });

  test('지정가에는 가격이 반드시 있어야 한다', () => {
    const r = buildOrderPayload({ ...base, kind: 'LIMIT', side: 'BUY', quantity: 1 });
    eq(r.ok, false);
    eq(r.blocked, 'MISSING_FIELD');
    assert(r.reason.includes('price'), r.reason);
  });

  test('모르는 유형은 보내지 않는다', () => {
    const r = buildOrderPayload({ ...base, kind: 'ICEBERG', side: 'BUY', quantity: 1 });
    eq(r.blocked, 'UNKNOWN_KIND');
    eq(orderKindOf('아무거나'), null);
    eq(orderKindOf('stop_market'), 'STOP_MARKET');
    eq(orderKindOf('STOP-MARKET'), 'STOP_MARKET');
  });

  test('전량 종료형 조건부는 수량이 없어도 된다', () => {
    const r = buildOrderPayload({
      ...base, kind: 'STOP_MARKET', side: 'SELL', stopPrice: 63000, closePosition: true,
    });
    eq(r.ok, true, r.reason);
    eq(r.payload.closePosition, true);
  });

  console.log('[주문 구성 — 청산이 신규가 되지 않는다]');

  test('롱을 BUY로 닫으려 하면 막는다', () => {
    // 이게 조용한 사고의 자리다. 닫히는 게 아니라 더 열린다.
    const r = buildOrderPayload({
      ...base, kind: 'MARKET', side: 'BUY', quantity: 0.5,
      reduceOnly: true, positionQty: 1,
    });
    eq(r.ok, false);
    eq(r.blocked, 'CLOSE_SIDE_WRONG');
    assert(r.reason.includes('더 여는 주문'), r.reason);
  });

  test('청산 방향을 서버가 확정한다', () => {
    // 화면이 방향을 안 보내도 포지션에서 정해진다.
    const long = buildOrderPayload({
      ...base, kind: 'MARKET', quantity: 0.5, reduceOnly: true, positionQty: 1,
    });
    eq(long.payload.side, 'SELL');
    const short = buildOrderPayload({
      ...base, kind: 'MARKET', quantity: 0.5, reduceOnly: true, positionQty: -1,
    });
    eq(short.payload.side, 'BUY');
  });

  test('청산이면 reduceOnly를 반드시 붙인다', () => {
    // 빠지면 청산이 반대 방향 신규 진입이 된다.
    const r = buildOrderPayload({
      ...base, kind: 'MARKET', side: 'SELL', quantity: 0.5, reduceOnly: true, positionQty: 1,
    });
    eq(r.payload.reduceOnly, true);
  });

  test('신규 주문에는 reduceOnly가 안 붙는다', () => {
    const r = buildOrderPayload({ ...base, kind: 'MARKET', side: 'SELL', quantity: 0.5 });
    eq(r.ok, true, r.reason);
    eq(r.payload.reduceOnly, undefined, '신규인데 reduceOnly가 붙으면 진입이 막힌다');
  });

  test('보유를 넘는 청산은 잘라 낸다 — 그리고 알린다', () => {
    const r = buildOrderPayload({
      ...base, kind: 'MARKET', quantity: 5, reduceOnly: true, positionQty: 1,
    });
    eq(r.ok, true, r.reason);
    eq(r.payload.quantity, 1);
    assert(r.adjusted.some(a => a.includes('보유 수량까지')), r.adjusted.join(','));
  });

  test('부동소수 꼬리는 안 자른다', () => {
    const r = buildOrderPayload({
      ...base, kind: 'MARKET', quantity: 0.9760000000000001,
      reduceOnly: true, positionQty: 0.976,
    });
    eq(r.adjusted.length, 0, '마지막 자리 차이로 경고가 뜨면 매번 뜬다');
  });

  console.log('[주문 구성 — 모르는 것 위에서 만들지 않는다]');

  test('보유 수량을 못 읽으면 청산 주문을 안 만든다', () => {
    // 0으로 눕히면 '포지션 없음'이 되고, 청산이 신규 진입으로 나간다.
    const r = buildOrderPayload({
      ...base, kind: 'MARKET', side: 'SELL', quantity: 1,
      reduceOnly: true, positionQty: null,
    });
    eq(r.blocked, 'POSITION_UNKNOWN');
    assert(r.reason.includes('신규 진입이 됩니다'), r.reason);
  });

  test('닫을 포지션이 없으면 그렇다고 말한다', () => {
    const r = buildOrderPayload({
      ...base, kind: 'MARKET', side: 'SELL', quantity: 1,
      reduceOnly: true, positionQty: 0,
    });
    eq(r.blocked, 'NOTHING_TO_CLOSE');
  });

  test('포지션 모드 검사는 켜야 돈다 — 기본은 안 막는다', () => {
    // 켜는 순간 모드 조회가 안 되는 계정의 신규 주문이 전부 멎는다.
    // 안전장치를 켜다가 기능을 죽이면 그 안전장치는 꺼진다.
    const input = { symbol: 'BTCUSDT', kind: 'MARKET', side: 'BUY' as const, quantity: 1 };
    eq(buildOrderPayload(input).ok, true, '기본은 통과');
    eq(buildOrderPayload(input, { requirePositionMode: true }).blocked, 'POSITION_MODE_UNKNOWN');
  });

  test('켜져 있어도 청산은 막지 않는다 — 방향이 이미 확정됐다', () => {
    const r = buildOrderPayload({
      symbol: 'BTCUSDT', kind: 'MARKET', quantity: 0.5,
      reduceOnly: true, positionQty: 1,
    }, { requirePositionMode: true });
    eq(r.ok, true, r.reason);
  });

  test('청산은 모드를 몰라도 만든다 — 방향이 이미 확정됐다', () => {
    const r = buildOrderPayload({
      symbol: 'BTCUSDT', kind: 'MARKET', quantity: 0.5,
      reduceOnly: true, positionQty: 1,
    });
    eq(r.ok, true, r.reason);
    eq(r.payload.side, 'SELL');
  });

  test('수량이 0이거나 없으면 막는다', () => {
    for (const q of [0, -1, null, undefined, 'abc']) {
      const r = buildOrderPayload({ ...base, kind: 'MARKET', side: 'BUY', quantity: q as any });
      eq(r.blocked, 'BAD_QUANTITY', String(q));
    }
  });

  console.log('[주문 구성 — 유형을 바꾸면 비울 것]');

  test('지정가에서 시장가로 가면 가격 칸을 비운다', () => {
    const c = fieldsToClearOnKindChange('LIMIT', 'MARKET');
    assert(c.includes('price'), c.join(','));
    assert(c.includes('timeInForce'), c.join(','));
  });

  test('조건부에서 일반으로 가면 트리거 칸을 비운다', () => {
    const c = fieldsToClearOnKindChange('STOP_LIMIT', 'LIMIT');
    assert(c.includes('stopPrice'), c.join(','));
    assert(!c.includes('price'), '지정가는 양쪽에 다 있다');
  });

  test('같은 유형이면 비울 것이 없다', () => {
    eq(fieldsToClearOnKindChange('MARKET', 'MARKET').length, 0);
  });

  test('모르는 유형으로 바꾸면 아무것도 안 비운다', () => {
    // 모르는 곳으로 가면서 지우면, 되돌릴 때 값이 사라져 있다.
    eq(fieldsToClearOnKindChange('LIMIT', '아무거나').length, 0);
  });

  console.log('[주문 구성 — 표의 일관성]');

  test('필수 필드는 모두 허용 필드 안에 있다', () => {
    // 필수인데 허용이 아니면 그 유형은 **영영 못 만든다.**
    for (const k of Object.keys(REQUIRED_FIELDS) as Array<keyof typeof REQUIRED_FIELDS>) {
      for (const f of REQUIRED_FIELDS[k]) {
        assert(ALLOWED_FIELDS[k].includes(f), `${k}의 필수 ${f}가 허용 목록에 없다`);
      }
    }
  });

  test('모든 유형이 심볼과 방향을 요구한다', () => {
    for (const k of Object.keys(REQUIRED_FIELDS) as Array<keyof typeof REQUIRED_FIELDS>) {
      assert(REQUIRED_FIELDS[k].includes('symbol'), k);
      assert(REQUIRED_FIELDS[k].includes('side'), k);
    }
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(buildOrderPayload(null).ok, false);
    eq(buildOrderPayload({} as any).blocked, 'UNKNOWN_KIND');
  });
}
