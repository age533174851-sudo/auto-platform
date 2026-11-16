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

  console.log('[상태 대조 — 못 읽은 수량은 일치가 아니다]');

  // 실제 입력 모양: `binanceFutures.getFuturesPositions`는 읽을 수 없는
  // positionAmt를 **버리지 않고 amount: NaN으로 남긴다** ("있다·모른다").
  // `reconcileCheck`는 그것을 `qty: Math.abs(Number(p.amount))` = NaN으로,
  // 방향은 'FLAT'을 'LONG'으로 접어 넘긴다.
  // 그런데 `NaN > 허용오차`는 false다 — 비교가 조용히 "일치"가 된다.
  test('거래소 수량이 NaN이면 "일치합니다"가 아니다 — 신규 주문을 막는다', () => {
    const v = reconcileState({
      appPositions: [pos({ qty: 0.5 })],
      exchangePositions: [pos({ qty: NaN })],
    });
    eq(v.ok, false, '못 읽은 거래소 수량을 일치로 통과시켰다: ' + v.summary);
    eq(v.blockNewOrders, true, '노출을 모르는데 신규 주문을 열어 뒀다');
    const m = v.mismatches.find(x => x.code === 'POSITION_QTY_UNKNOWN');
    assert(!!m, '코드 누락: ' + JSON.stringify(v.mismatches));
    eq(m!.severity, 'critical');
    eq(m!.exchange, null, 'NaN을 값처럼 싣지 않는다');
    eq(m!.app, 0.5);
  });

  test('앱 수량이 깨져도 같다 (Infinity·NaN)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = reconcileState({
        appPositions: [pos({ qty: bad })],
        exchangePositions: [pos({ qty: 0.5 })],
      });
      eq(v.blockNewOrders, true, `앱 수량 ${bad}를 통과시켰다`);
      assert(v.mismatches.some(x => x.code === 'POSITION_QTY_UNKNOWN'), `코드 누락 (${bad})`);
    }
  });

  test('수량을 모르면 방향도 비교하지 않는다 — 접힌 방향으로 지어낸 불일치를 만들지 않는다', () => {
    // reconcileCheck는 'FLAT'(수량 모름)을 'LONG'으로 접는다. 그 방향과
    // 앱의 SHORT를 비교해 "방향 불일치"를 적으면 관측이 아닌 것을 적는다.
    const v = reconcileState({
      appPositions: [pos({ side: 'SHORT', qty: 0.5 })],
      exchangePositions: [pos({ side: 'LONG', qty: NaN })],
    });
    assert(!v.mismatches.some(x => x.code === 'POSITION_SIDE_DIFFERS'),
      '수량을 모르는 행의 방향을 사실로 비교했다');
    assert(!v.mismatches.some(x => x.code === 'POSITION_QTY_DIFFERS'),
      '모르는 수량을 "다르다"로 적었다 — 복구 규칙이 그 값을 자동으로 들여온다');
    eq(v.blockNewOrders, true);
  });

  test('수량을 몰라도 확인된 다른 사실(마진 모드·손절 소실)은 그대로 잡는다', () => {
    const v = reconcileState({
      appPositions: [pos({ qty: 0.5, marginType: 'isolated' })],
      exchangePositions: [pos({ qty: NaN, marginType: 'cross', hasProtectiveStop: false })],
    });
    assert(v.mismatches.some(x => x.code === 'MARGIN_TYPE_DIFFERS'), '마진 모드 불일치를 놓쳤다');
    assert(v.mismatches.some(x => x.code === 'PROTECTIVE_ORDER_MISSING'), '손절 소실을 놓쳤다');
  });

  test('정상 수량(0.5 vs 0.5)은 여전히 일치다 — 새 분기가 오탐을 만들지 않는다', () => {
    const v = reconcileState({ appPositions: [pos({ qty: 0.5 })], exchangePositions: [pos({ qty: 0.5 })] });
    eq(v.ok, true, v.summary);
    assert(!v.mismatches.some(x => x.code === 'POSITION_QTY_UNKNOWN'), '정상 수량을 모름으로 적었다');
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
