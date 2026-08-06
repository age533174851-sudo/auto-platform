// src/lib/markets/orderView.test.ts
//
// 막으려는 사고:
//  1. 숏을 닫는 손절(BUY)이 '신규 롱 주문'처럼 읽혀, 사용자가 자기
//     포지션의 유일한 보호 장치를 취소하는 것 — 이 화면에서 가장 비싼 오독
//  2. 보호 주문이 일반 미체결과 섞여 [전체 취소]에 조용히 딸려 나가는 것
//  3. 발동 부등호를 반대로 적어 발동 시점을 거꾸로 계산하게 하는 것
//  4. reduceOnly 필드가 없는 것을 '신규 주문'으로 단정하는 것
//  5. **90% 체결된 주문이 아무것도 안 된 주문과 똑같이 보이는 것.**
//     그 상태로 [취소]를 누르면 사용자는 "아무 일도 없었다"고 생각하는데,
//     취소된 것은 남은 10%뿐이고 이미 체결된 90%는 포지션으로 남는다
import { test, assert, eq } from '../../test/harness';
import { describeOrder, splitOrders, protectionOf, closesSideOf, purposeOf, fmtNum } from './orderView';

export function runOrderViewTests() {
  console.log('[미체결 카드 — 용도 판정]');

  test('숏의 손절은 BUY지만 신규 롱이 아니다', () => {
    // 화면에 실제로 이렇게 떠 있었다:
    //   BTCUSDT | STOP_MARKET | BUY | — | Stop 65,352.50
    // `BUY`만 보고 "롱 예약이 걸려 있네"라고 읽으면 손절을 지운다.
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'STOP_MARKET',
      stopPrice: 65352.5, closePosition: true, reduceOnly: true,
      workingType: 'MARK_PRICE', orderId: '123',
    });
    eq(v.purpose, 'STOP');
    eq(v.protection, 'PROTECTIVE');
    eq(v.purposeLabel, '숏 손절');
    eq(v.sideLabel, '숏 포지션 종료용 매수');
    eq(v.kindLabel, '조건부 시장가');
    eq(v.qtyLabel, '전량 종료');
    eq(v.triggerLabel, '마크가 ≥ 65,352.5');
  });

  test('롱의 손절은 아래로 내려갈 때 발동한다', () => {
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET',
      stopPrice: 60000, reduceOnly: true, workingType: 'MARK_PRICE',
    });
    eq(v.purposeLabel, '롱 손절');
    eq(v.sideLabel, '롱 포지션 종료용 매도');
    eq(v.triggerLabel, '마크가 ≤ 60,000');
  });

  test('익절은 손절과 부등호가 반대다', () => {
    const long = describeOrder({
      side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: 70000,
      reduceOnly: true, workingType: 'MARK_PRICE',
    });
    eq(long.purposeLabel, '롱 익절');
    eq(long.triggerLabel, '마크가 ≥ 70,000');

    const short = describeOrder({
      side: 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: 60000,
      reduceOnly: true, workingType: 'MARK_PRICE',
    });
    eq(short.purposeLabel, '숏 익절');
    eq(short.triggerLabel, '마크가 ≤ 60,000');
  });

  test('발동 기준을 모르면 지어내지 않는다', () => {
    // '체결가'라고 적어 놓으면 사용자가 그 기준으로 발동 시점을 계산한다.
    const v = describeOrder({ side: 'BUY', type: 'STOP_MARKET', stopPrice: 100, reduceOnly: true });
    eq(v.triggerBasisLabel, null);
    eq(v.triggerLabel, '기준가 ≥ 100');
  });

  test('신규 지정가 주문은 방향을 그대로 말한다', () => {
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: 60000,
      origQty: 0.5, reduceOnly: false, closePosition: false,
    });
    eq(v.protection, 'NEW');
    eq(v.purposeLabel, '신규 롱 지정가 주문');
    eq(v.sideLabel, '신규 매수(롱)');
    eq(v.execLabel, '지정가 60,000');
    eq(v.qtyLabel, '0.5');
    eq(v.triggerLabel, null, '조건부가 아니면 트리거 줄이 없다');
  });

  console.log('[미체결 카드 — 보호/일반 분리]');

  test('조건부 주문은 reduceOnly가 없어도 보호 주문이다', () => {
    // Gate의 price_orders는 reduceOnly를 안 실어 보낸다. 그걸 '신규'로
    // 분류하면 손절이 일반 주문 칸에 앉고, 사용자는 정리 대상으로 본다.
    eq(protectionOf({ type: 'STOP_MARKET', side: 'BUY' }), 'PROTECTIVE');
    eq(protectionOf({ type: 'TAKE_PROFIT_MARKET', side: 'SELL' }), 'PROTECTIVE');
  });

  test('reduceOnly 필드가 없는 지정가는 판단 불가다', () => {
    // 없는 것과 false는 다르다. 같게 보면 거래소가 그 필드를 안 주는
    // 순간 모든 보호 주문이 신규 칸으로 내려간다.
    eq(protectionOf({ type: 'LIMIT', side: 'BUY' }), 'UNKNOWN');
    eq(protectionOf({ type: 'LIMIT', side: 'BUY', reduceOnly: false }), 'NEW');
  });

  test('판단 불가는 보호로도 신규로도 세지 않는다', () => {
    const s = splitOrders([
      { symbol: 'BTCUSDT', type: 'STOP_MARKET', side: 'BUY', stopPrice: 65352.5, closePosition: true },
      { symbol: 'BTCUSDT', type: 'LIMIT', side: 'BUY', price: 60000, reduceOnly: false },
      { symbol: 'BTCUSDT', type: 'LIMIT', side: 'SELL', price: 70000 },
    ]);
    eq(s.protective.length, 1);
    eq(s.normal.length, 1);
    eq(s.unknown.length, 1);
    eq(s.total, 3);
  });

  test('못 읽은 목록은 빈 목록과 다르다', () => {
    // null이 [] 로 접히면 조회 실패가 '미체결 없음'으로 그려진다.
    eq(splitOrders(null).total, 0);
    eq(splitOrders(undefined).total, 0);
    // 화면은 orders == null 자체를 보고 '조회 실패'를 그린다 — 여기서
    // 구분이 사라지지 않는 것만 확인한다.
    assert(Array.isArray(splitOrders(null).protective));
  });

  test('닫는 방향은 주문 방향의 반대 포지션이다', () => {
    eq(closesSideOf({ type: 'STOP_MARKET', side: 'BUY' }), 'SHORT');
    eq(closesSideOf({ type: 'STOP_MARKET', side: 'SELL' }), 'LONG');
    eq(closesSideOf({ type: 'LIMIT', side: 'BUY', reduceOnly: false }), null,
      '신규 주문은 닫는 방향이 없다');
  });

  console.log('[미체결 카드 — 숫자 표기]');

  test('작은 소수를 0으로 만들지 않는다', () => {
    eq(fmtNum(0.0001), '0.0001');
    eq(fmtNum(65352.5), '65,352.5');
    eq(fmtNum(1234567), '1,234,567');
    eq(fmtNum(null), '—', '없는 값은 0이 아니다');
  });

  test('부동소수 찌꺼기를 그대로 내보내지 않는다', () => {
    // 화면에 0.9760000000000001이 그대로 떴던 적이 있다.
    eq(fmtNum(0.976 + 0.0000000000000001), '0.976');
  });

  test('수량 0은 수량 미상과 다르게 다뤄야 한다', () => {
    eq(describeOrder({ type: 'LIMIT', side: 'BUY', reduceOnly: false }).qtyLabel, '수량 미상');
    eq(describeOrder({ type: 'LIMIT', side: 'BUY', reduceOnly: false, origQty: 2 }).qtyLabel, '2');
  });

  test('용도를 못 가리면 그렇다고 적는다', () => {
    eq(purposeOf({ type: 'SOMETHING_NEW' }), 'UNKNOWN');
    eq(describeOrder({ type: 'SOMETHING_NEW', side: 'BUY' }).purposeLabel, '용도 확인 불가');
  });

  console.log('[미체결 카드 — 부분 체결]');

  test('일부 체결된 주문을 활성으로 뭉개지 않는다', () => {
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
      origQty: 1, executedQty: 0.9, price: 64000, status: 'PARTIALLY_FILLED',
    });
    eq(v.statusLabel, '일부 체결 90%');
    eq(v.partiallyFilled, true);
    eq(v.filledQty, 0.9);
    eq(v.remainingQty, 0.1);
  });

  test('상태를 안 줘도 수량 차이로 안다', () => {
    // Gate는 상태를 'open'으로만 주고 체결분은 수량 차이로 알린다.
    const v = describeOrder({
      symbol: 'BTC_USDT', side: 'BUY', type: 'LIMIT',
      origQty: 4, executedQty: 1, price: 64000, status: 'open',
    });
    eq(v.partiallyFilled, true);
    eq(v.statusLabel, '일부 체결 25%');
  });

  test('남은 수량을 앞에 적는다 — 여기서 궁금한 것은 앞으로 나갈 양이다', () => {
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', origQty: 1, executedQty: 0.9, price: 6e4,
    });
    eq(v.qtyLabel, '0.1 남음 / 1');
  });

  test('한 개도 안 붙었으면 부분 체결이 아니다', () => {
    // executedQty: 0은 '아직 하나도 안 붙었다'이지 '일부 체결'이 아니다.
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', origQty: 1, executedQty: 0, price: 6e4,
    });
    eq(v.partiallyFilled, false);
    eq(v.statusLabel, '활성');
    eq(v.qtyLabel, '1');
    eq(v.fillPct, 0, '0%는 모름이 아니다');
  });

  test('전량 체결도 부분 체결이 아니다', () => {
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', origQty: 1, executedQty: 1, price: 6e4,
    });
    eq(v.partiallyFilled, false);
  });

  test('체결 수량을 안 주면 모른다 — 0으로 치지 않는다', () => {
    const v = describeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', origQty: 1, price: 6e4 });
    eq(v.filledQty, null);
    eq(v.fillPct, null);
    eq(v.partiallyFilled, false, '모르는 것을 부분 체결로 단정하지 않는다');
    eq(v.qtyLabel, '1');
  });

  test('마지막 자리 차이로 일부 체결이 뜨지 않는다', () => {
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT',
      origQty: 0.976, executedQty: 0.9760000000000001, price: 6e4,
    });
    eq(v.partiallyFilled, false, '매번 뜨는 경고는 아무도 안 읽는다');
  });

  test('우리 장부의 칸 이름도 읽는다', () => {
    const v = describeOrder({
      symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', origQty: 2, filled_qty: 0.5, price: 6e4,
    });
    eq(v.filledQty, 0.5);
    eq(v.partiallyFilled, true);
  });
}
