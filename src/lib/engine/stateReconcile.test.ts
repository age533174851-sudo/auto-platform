// src/lib/engine/stateReconcile.test.ts
//
// 이 대조가 틀리면 나머지 판단이 전부 틀린 전제 위에서 돈다.
// 특히 "일치하는데 불일치로 잡는" 오탐은 신규 주문을 부당하게 막으므로
// 허용 오차 경계를 명확히 고정한다.
import { test, assert, eq } from '../../test/harness';
import { reconcileState, type PositionView } from './stateReconcile';

const pos = (over: Partial<PositionView> = {}): PositionView => ({
  symbol: 'BTCUSDT', side: 'LONG', qty: 0.5,
  leverage: 10, marginType: 'isolated', hasProtectiveStop: true,
  ...over,
});

export function runStateReconcileTests() {
  console.log('[상태 대조 — 일치]');

  test('양쪽이 같으면 불일치 없음', () => {
    const v = reconcileState({ appPositions: [pos()], exchangePositions: [pos()] });
    eq(v.ok, true, v.summary);
    eq(v.blockNewOrders, false);
  });

  test('허용 오차 안의 수량 차이는 잡지 않는다', () => {
    // 0.5% 기본 허용. 0.5 vs 0.5015 = 0.3% 차이
    const v = reconcileState({ appPositions: [pos({ qty: 0.5 })], exchangePositions: [pos({ qty: 0.5015 })] });
    eq(v.ok, true, '부분체결·반올림 수준 차이를 불일치로 잡았다: ' + v.summary);
  });

  test('심볼 표기가 달라도 같은 종목으로 본다', () => {
    const v = reconcileState({
      appPositions: [pos({ symbol: 'BTC/USDT' })],
      exchangePositions: [pos({ symbol: 'BTCUSDT' })],
    });
    eq(v.ok, true, "'BTC/USDT'와 'BTCUSDT'를 다른 종목으로 봤다");
  });

  console.log('[상태 대조 — 심각한 불일치는 주문을 막는다]');

  test('앱엔 있는데 거래소엔 없으면 차단', () => {
    const v = reconcileState({ appPositions: [pos()], exchangePositions: [] });
    eq(v.blockNewOrders, true);
    assert(v.mismatches.some(x => x.code === 'POSITION_MISSING_ON_EXCHANGE'), '코드 누락');
  });

  test('거래소엔 있는데 앱이 모르면 차단', () => {
    const v = reconcileState({ appPositions: [], exchangePositions: [pos()] });
    eq(v.blockNewOrders, true);
    assert(v.mismatches.some(x => x.code === 'POSITION_MISSING_IN_APP'), '코드 누락');
  });

  test('마진 모드가 다르면 차단 — 격리 전제가 깨진다', () => {
    const v = reconcileState({
      appPositions: [pos({ marginType: 'isolated' })],
      exchangePositions: [pos({ marginType: 'cross' })],
    });
    eq(v.blockNewOrders, true);
    assert(v.mismatches.some(x => x.code === 'MARGIN_TYPE_DIFFERS'), '코드 누락');
  });

  test('방향이 다르면 차단', () => {
    const v = reconcileState({
      appPositions: [pos({ side: 'LONG' })],
      exchangePositions: [pos({ side: 'SHORT' })],
    });
    eq(v.blockNewOrders, true);
  });

  test('손절이 사라졌으면 차단', () => {
    const v = reconcileState({
      appPositions: [pos()],
      exchangePositions: [pos({ hasProtectiveStop: false })],
    });
    eq(v.blockNewOrders, true);
    assert(v.mismatches.some(x => x.code === 'PROTECTIVE_ORDER_MISSING'), '코드 누락');
  });

  console.log('[상태 대조 — 경고는 막지 않는다]');

  test('수량 차이는 경고일 뿐 주문을 막지 않는다', () => {
    const v = reconcileState({ appPositions: [pos({ qty: 0.5 })], exchangePositions: [pos({ qty: 0.4 })] });
    eq(v.ok, false);
    eq(v.blockNewOrders, false, '수량 차이만으로 신규 주문을 막았다');
    assert(v.mismatches.some(x => x.code === 'POSITION_QTY_DIFFERS'), '코드 누락');
  });

  test('레버리지 차이도 경고', () => {
    const v = reconcileState({
      appPositions: [pos({ leverage: 10 })],
      exchangePositions: [pos({ leverage: 20 })],
    });
    eq(v.blockNewOrders, false);
    assert(v.mismatches.some(x => x.code === 'LEVERAGE_DIFFERS'), '코드 누락');
  });

  test('잔고 차이는 정보 수준', () => {
    const v = reconcileState({
      appPositions: [], exchangePositions: [],
      appBalance: 1000, exchangeBalance: 1050,
    });
    eq(v.blockNewOrders, false);
    assert(v.mismatches.some(x => x.code === 'BALANCE_DIFFERS'), '코드 누락');
  });

  console.log('[상태 대조 — 미체결 주문]');

  test('양쪽 주문 목록이 다르면 각각 잡아낸다', () => {
    const v = reconcileState({
      appPositions: [], exchangePositions: [],
      appOpenOrders: [{ clientOrderId: 'A1', symbol: 'BTCUSDT' }],
      exchangeOpenOrders: [{ clientOrderId: 'B2', symbol: 'BTCUSDT' }],
    });
    assert(v.mismatches.some(x => x.code === 'ORDER_MISSING_ON_EXCHANGE'), 'A1 누락 미감지');
    assert(v.mismatches.some(x => x.code === 'ORDER_MISSING_IN_APP'), 'B2 누락 미감지');
  });

  test('주문 목록을 안 넘기면 주문 대조를 건너뛴다', () => {
    const v = reconcileState({ appPositions: [pos()], exchangePositions: [pos()] });
    assert(!v.mismatches.some(x => String(x.code).startsWith('ORDER_')), '넘기지 않은 항목을 검사했다');
  });
}
