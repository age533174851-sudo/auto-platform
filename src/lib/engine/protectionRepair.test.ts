// src/lib/engine/protectionRepair.test.ts
//
// 막으려는 것:
//  1. **고치는 동안 보호가 비는 것.** 취소를 먼저 하면 그 몇 초가 맨몸이다
//  2. 못 읽은 값 위에서 계획을 만들어, 멀쩡한 손절을 취소하는 것
//  3. 손절 가격을 지어내서 다시 거는 것 — 없는 것보다 나쁘다
//  4. 보호 주문이 어긋났다고 **포지션을 건드리는 것**
import { test, assert, eq } from '../../test/harness';
import { repairPlan, closeSideOf, repairSummary, protectionFactsOf } from './protectionRepair';

export function runProtectionRepairTests() {
  console.log('[보호 주문 복구 — 모르는 위에서 만들지 않는다]');

  test('포지션을 못 읽으면 아무것도 안 한다', () => {
    // 0으로 눕히면 '남은 보호 취소'가 되고, 조회가 흔들릴 때마다
    // 멀쩡한 포지션의 유일한 손절을 지운다.
    const p = repairPlan({ positionQty: null, protectionQty: 1, protectionOrderId: 'x' });
    eq(p.kind, 'WAIT');
    eq(p.steps.length, 0);
    eq(p.safeToAutomate, false);
  });

  test('보호 수량을 못 읽으면 안 고친다', () => {
    const p = repairPlan({
      positionQty: 1, protectionQty: null, protectionOrderId: 'x', stopPrice: 60000,
    });
    eq(p.kind, 'WAIT');
    eq(p.uncoveredQty, null, '모르는 것을 0으로 적으면 안전해 보인다');
  });

  test('손절 가격을 모르면 지어내지 않는다', () => {
    const p = repairPlan({
      positionQty: 1, protectionQty: 0.4, protectionOrderId: 'x', stopPrice: null,
    });
    eq(p.kind, 'MANUAL');
    eq(p.steps.length, 0);
    assert(p.urgent, '0.6이 맨몸인데 안 급할 리 없다');
  });

  test('취소할 주문을 지목 못 하면 새로 걸지 않는다', () => {
    // 걸기만 하면 보호가 둘이 된 채로 남는다.
    const p = repairPlan({
      positionQty: 1, protectionQty: 0.4, protectionOrderId: null, stopPrice: 60000,
    });
    eq(p.kind, 'MANUAL');
  });

  console.log('[보호 주문 복구 — 순서가 안전을 정한다]');

  test('reduceOnly가 확인되면 걸고 나서 취소한다', () => {
    // 그 사이는 '보호가 둘'이다. 둘 다 reduceOnly면 먼저 발동한 쪽이
    // 닫고 나머지는 닫을 것이 없어 무시된다.
    const p = repairPlan({
      positionQty: 1, protectionQty: 0.4, protectionOrderId: 'old',
      protectionReduceOnly: true, stopPrice: 60000, positionSide: 'LONG',
    });
    eq(p.kind, 'RESIZE');
    eq(p.steps.map(s => s.op).join('>'), 'PLACE>CANCEL');
    eq(p.momentaryGap, false, '보호가 비는 순간이 없다');
    eq(p.steps[0].qty, 1);
    eq(p.steps[0].side, 'SELL', '롱을 닫는 것은 매도다');
    eq(p.steps[0].reduceOnly, true);
    eq(p.steps[1].orderId, 'old');
  });

  test('reduceOnly를 모르면 취소를 먼저 하고, 그 틈을 밝힌다', () => {
    // 둘 다 살아 있는데 reduceOnly가 없으면, 발동 시 하나는 닫고 하나는
    // **반대 포지션을 연다.** 그때는 비는 쪽이 덜 나쁘다.
    const p = repairPlan({
      positionQty: 1, protectionQty: 0.4, protectionOrderId: 'old',
      protectionReduceOnly: null, stopPrice: 60000, positionSide: 'SHORT',
    });
    eq(p.steps.map(s => s.op).join('>'), 'CANCEL>PLACE');
    eq(p.momentaryGap, true, '조용히 비우지 않는다');
    eq(p.steps[1].side, 'BUY', '숏을 닫는 것은 매수다');
  });

  test('어떤 계획에도 포지션을 닫는 단계가 없다', () => {
    // 어긋난 것은 보호 주문이지 포지션이 아니다.
    const cases = [
      { positionQty: 1, protectionQty: 0.4, protectionOrderId: 'o', stopPrice: 6e4 },
      { positionQty: 1, protectionQty: 2, protectionOrderId: 'o', stopPrice: 6e4, protectionReduceOnly: true },
      { positionQty: 1, protectionQty: 0, stopPrice: 6e4 },
      { positionQty: 0, protectionOrderId: 'o' },
    ];
    for (const c of cases) {
      for (const s of repairPlan(c as any).steps) {
        assert(s.op === 'PLACE' || s.op === 'CANCEL', `${s.op}는 이 파일이 만들 단계가 아니다`);
        if (s.op === 'PLACE') assert(s.reduceOnly === true, '새 보호에는 반드시 reduceOnly');
      }
    }
  });

  console.log('[보호 주문 복구 — 무엇이 급한가]');

  test('덜 덮으면 급하다 — 그만큼이 맨몸이다', () => {
    const p = repairPlan({
      positionQty: 1, protectionQty: 0.4, protectionOrderId: 'o',
      protectionReduceOnly: true, stopPrice: 6e4,
    });
    eq(p.uncoveredQty, 0.6);
    eq(p.urgent, true);
  });

  test('더 덮는데 reduceOnly면 급하지 않다 — 초과분은 무시된다', () => {
    const p = repairPlan({
      positionQty: 1, protectionQty: 2, protectionOrderId: 'o',
      protectionReduceOnly: true, stopPrice: 6e4,
    });
    eq(p.kind, 'RESIZE');
    eq(p.uncoveredQty, 0);
    eq(p.urgent, false);
    assert(p.reason.includes('무시'), p.reason);
  });

  test('더 덮는데 reduceOnly를 모르면 급하다 — 반대 포지션이 열린다', () => {
    const p = repairPlan({
      positionQty: 1, protectionQty: 2, protectionOrderId: 'o', stopPrice: 6e4,
    });
    eq(p.urgent, true);
    assert(p.reason.includes('반대 포지션'), p.reason);
  });

  console.log('[보호 주문 복구 — 맞는 것은 건드리지 않는다]');

  test('전량 종료형은 언제나 맞다', () => {
    // closePosition/auto_size는 발동 시점의 남은 전부를 닫는다.
    // 부분청산을 몇 번 하든 다시 걸 일이 없다.
    const p = repairPlan({
      positionQty: 0.37, protectionClosesAll: true, protectionQty: null, stopPrice: 6e4,
    });
    eq(p.kind, 'NONE');
    eq(p.uncoveredQty, 0);
    eq(repairSummary(p), '', '할 일 없음을 띄우면 진짜 경고가 묻힌다');
  });

  test('마지막 자리 차이로 매번 다시 걸지 않는다', () => {
    const p = repairPlan({
      positionQty: 0.976, protectionQty: 0.9760000000000001,
      protectionOrderId: 'o', stopPrice: 6e4,
    });
    eq(p.kind, 'NONE');
  });

  console.log('[보호 주문 복구 — 포지션이 없을 때]');

  test('포지션이 없는데 보호가 남으면 취소한다', () => {
    const p = repairPlan({ positionQty: 0, protectionOrderId: 'orphan' });
    eq(p.kind, 'CANCEL');
    eq(p.urgent, true, '두면 다음 진입이 이 손절에 걸린다');
    eq(p.steps.length, 1);
    eq(p.steps[0].orderId, 'orphan');
  });

  test('포지션도 보호도 없으면 조용하다', () => {
    const p = repairPlan({ positionQty: 0 });
    eq(p.kind, 'NONE');
    eq(repairSummary(p), '');
  });

  console.log('[보호 주문 복구 — 보호가 아예 없을 때]');

  test('보호가 없으면 건다', () => {
    const p = repairPlan({ positionQty: 1, protectionQty: 0, stopPrice: 6e4, positionSide: 'LONG' });
    eq(p.kind, 'ATTACH');
    eq(p.urgent, true);
    eq(p.steps.length, 1);
    eq(p.steps[0].op, 'PLACE');
    eq(p.steps[0].qty, 1);
  });

  test('방향을 모르면 방향을 비운 채로 만든다 — 지어내지 않는다', () => {
    const p = repairPlan({ positionQty: 1, protectionQty: 0, stopPrice: 6e4 });
    eq(p.steps[0].side, null);
    eq(closeSideOf(null), null);
    eq(closeSideOf('LONG'), 'SELL');
    eq(closeSideOf('SHORT'), 'BUY');
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(repairPlan(null).kind, 'WAIT');
    eq(repairPlan({}).kind, 'WAIT');
  });

  console.log('[보호 주문 복구 — 거래소 주문을 읽는다]');

  test('reduceOnly 칸이 없으면 모름이다 — false가 아니다', () => {
    // Gate의 price_orders는 이 칸을 안 준다. '아니오'로 읽으면 멀쩡한
    // 보호 주문이 전부 위험 분류로 내려가고, 복구 순서가 매번 취소
    // 먼저로 기운다.
    eq(protectionFactsOf({ orderId: 1, origQty: 1, stopPrice: 6e4 }).protectionReduceOnly, null);
    eq(protectionFactsOf({ reduceOnly: false }).protectionReduceOnly, false);
    eq(protectionFactsOf({ reduceOnly: true }).protectionReduceOnly, true);
  });

  test('전량 종료형은 수량 대신 closesAll로 읽는다', () => {
    const f = protectionFactsOf({ orderId: 7, closePosition: true, origQty: 0, stopPrice: 6e4 });
    eq(f.protectionClosesAll, true);
    eq(f.protectionQty, null, '0으로 읽으면 보호가 없는 것으로 판정된다');
    eq(f.protectionReduceOnly, true, 'closePosition은 reduceOnly보다 강하다');
    eq(repairPlan({ positionQty: 3, ...f }).kind, 'NONE');
  });

  test('Gate의 발동가와 수량 칸도 읽는다', () => {
    const f = protectionFactsOf({ orderId: 'g1', size: -12, triggerPrice: 58000 });
    eq(f.protectionQty, 12, '숏은 음수로 온다 — 절대값으로 본다');
    eq(f.stopPrice, 58000);
    eq(f.protectionOrderId, 'g1');
  });

  test('주문이 없으면 전부 비어 있다', () => {
    const f = protectionFactsOf(null);
    eq(f.protectionOrderId, null);
    eq(f.protectionQty, null);
    eq(f.stopPrice, null);
  });
}
