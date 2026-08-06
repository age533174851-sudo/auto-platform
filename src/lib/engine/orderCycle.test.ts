// src/lib/engine/orderCycle.test.ts
//
// 막으려는 것 — 전부 **사이클이 끊긴 채로 조용히 지나가는** 상태다:
//  1. 포지션은 열렸는데 보호 주문이 없다. 크기 자체가 손절 거리로
//     역산된 값이라, 손절이 없으면 그 크기를 정당화할 근거가 사라진다
//  2. 포지션은 없는데 보호 주문이 살아 있다 — **다음 진입을 그 손절이 친다**
//  3. 절반을 닫았는데 손절은 아직 전량을 덮고 있다(또는 그 반대).
//     발동하는 순간에야 "왜 이만큼만 닫혔지"가 된다
//  4. 못 읽은 것을 '없음'으로 읽어, 조회 한 번 실패로 멀쩡한 포지션을 닫는 것
//  5. 결과를 모르는 주문 위에 또 들어가는 것
import { test, assert, eq } from '../../test/harness';
import { cycleState, canOpenNew, cycleSummary } from './orderCycle';
import type { StopCheck } from './stopVerify';

const attached = (id = 'S1'): StopCheck =>
  ({ status: 'attached', reason: '손절 확인', orderId: id, foundStopPrice: 63000 });
const missing = (): StopCheck =>
  ({ status: 'missing', reason: '주문장에 없습니다', orderId: null, foundStopPrice: null });
const unknown = (): StopCheck =>
  ({ status: 'unknown', reason: '미체결 목록을 읽지 못했습니다', orderId: null, foundStopPrice: null });

export function runOrderCycleTests() {
  console.log('[주문 사이클 — 모름을 먼저 걸러낸다]');

  test('결과를 모르는 주문 위에서는 다음 단계를 논하지 않는다', () => {
    for (const st of ['UNKNOWN', 'SENT']) {
      const v = cycleState({ orderStatus: st, positionQty: 0, stop: missing() });
      eq(v.broken, 'ORDER_UNKNOWN', st);
      eq(v.urgent, true, st);
      eq(canOpenNew(v).allowed, false, st);
    }
  });

  test('포지션을 못 읽은 것은 포지션이 없는 것이 아니다', () => {
    // 0으로 읽으면 '없다'가 되고, 그러면 남은 보호 주문을 고아로 판정해
    // 지운다 — 실제로는 포지션이 있는데 보호만 사라진다.
    const v = cycleState({ orderStatus: 'FILLED', positionQty: null, stop: attached() });
    eq(v.broken, 'POSITION_UNKNOWN');
    assert(v.reason.includes('모르는 것'), v.reason);
    eq(canOpenNew(v).allowed, false);
  });

  test('0과 null을 다르게 읽는다', () => {
    eq(cycleState({ orderStatus: 'FILLED', positionQty: 0, stop: missing() }).stage, 'CLOSED');
    eq(cycleState({ orderStatus: 'FILLED', positionQty: null, stop: missing() }).broken, 'POSITION_UNKNOWN');
  });

  console.log('[주문 사이클 — 보호 없는 포지션]');

  test('포지션이 있는데 손절이 없으면 급한 일이다', () => {
    const v = cycleState({ orderStatus: 'FILLED', positionQty: 0.5, stop: missing() });
    eq(v.broken, 'POSITION_UNPROTECTED');
    eq(v.urgent, true);
    assert(v.action.includes('손절이 있다는 전제'), v.action);
    eq(canOpenNew(v).allowed, false, '보호 없는 포지션 위에 더 얹으면 안 된다');
  });

  test('걸었다고 기록됐는데 주문장에 없으면 그렇게 적는다', () => {
    // 이건 "안 걸었다"와 다른 사고다 — 거래소가 접수 뒤 취소한 것이다.
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: 0.5, stop: missing(), recordedStopId: 'S1',
    });
    assert(v.reason.includes('기록돼 있지만'), v.reason);
  });

  test('보호를 확인 못 한 것은 보호가 없는 것이 아니다', () => {
    // 조회 실패로 멀쩡한 포지션을 닫으면 그것대로 사고다.
    const v = cycleState({ orderStatus: 'FILLED', positionQty: 0.5, stop: unknown() });
    eq(v.broken, 'PROTECTION_UNVERIFIED');
    eq(v.urgent, false, '모른다고 즉시 청산하면 안 된다');
    assert(v.action.includes('보호된 것으로도 안 된 것으로도'), v.action);
  });

  test('보호 판정 자체가 없으면 확인 안 된 것이다', () => {
    const v = cycleState({ orderStatus: 'FILLED', positionQty: 0.5 });
    eq(v.broken, 'PROTECTION_UNVERIFIED');
  });

  console.log('[주문 사이클 — 고아 보호 주문]');

  test('포지션이 없는데 손절이 살아 있으면 다음 진입이 걸린다', () => {
    const v = cycleState({ orderStatus: 'FILLED', positionQty: 0, stop: attached() });
    eq(v.broken, 'ORPHAN_PROTECTION');
    eq(v.urgent, true);
    assert(v.action.includes('취소'), v.action);
    eq(canOpenNew(v).allowed, false);
  });

  test('정리된 사이클은 통과다', () => {
    const v = cycleState({ orderStatus: 'FILLED', positionQty: 0, stop: missing() });
    eq(v.stage, 'CLOSED');
    eq(v.ok, true);
    eq(canOpenNew(v).allowed, true);
  });

  test('포지션은 정리됐는데 남은 주문을 확인 못 했으면 통과가 아니다', () => {
    const v = cycleState({ orderStatus: 'FILLED', positionQty: 0, stop: unknown() });
    eq(v.ok, false);
    eq(v.broken, 'PROTECTION_UNVERIFIED');
    eq(v.urgent, false);
  });

  console.log('[주문 사이클 — 부분청산 뒤 수량]');

  test('절반 닫았는데 손절이 전량을 덮고 있으면 잡는다', () => {
    // 발동 시 없는 수량을 닫으려다 거부되거나 반대 포지션이 열린다.
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: 0.5, intendedQty: 1,
      stop: attached(), protectionQty: 1,
    });
    eq(v.broken, 'PROTECTION_QTY_MISMATCH');
    eq(v.urgent, true);
    assert(v.action.includes('포지션보다 큽니다'), v.action);
  });

  test('손절이 포지션보다 적으면 나머지가 보호되지 않는다', () => {
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: 1, stop: attached(), protectionQty: 0.5,
    });
    eq(v.broken, 'PROTECTION_QTY_MISMATCH');
    assert(v.action.includes('보호되지 않은 수량'), v.action);
  });

  test('전량 종료형은 수량을 비교하지 않는다', () => {
    // closePosition / auto_size는 '언제나 남은 전부'라 부분청산 뒤에도
    // 자동으로 맞는다. 여기서 불일치로 잡으면 정상 동작이 매번 경고가 된다.
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: 0.5, intendedQty: 1,
      stop: attached(), protectionQty: null, protectionClosesAll: true,
    });
    eq(v.ok, true);
    eq(v.stage, 'PARTIALLY_CLOSED');
    assert(v.reason.includes('일부 정리됨'), v.reason);
  });

  test('수량을 모르면 불일치로 단정하지 않는다', () => {
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: 0.5, stop: attached(), protectionQty: null,
    });
    eq(v.ok, true, '모르는 것을 불일치로 읽으면 매번 막힌다');
  });

  test('자릿수 오차는 불일치가 아니다', () => {
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: 0.9748, stop: attached(), protectionQty: 0.97480000001,
    });
    eq(v.ok, true, '거래소마다 자릿수가 다르다');
  });

  console.log('[주문 사이클 — 정상 경로]');

  test('포지션과 보호가 모두 확인되면 PROTECTED다', () => {
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: 1, intendedQty: 1,
      stop: attached(), protectionClosesAll: true,
    });
    eq(v.stage, 'PROTECTED');
    eq(v.ok, true);
    eq(v.broken, null);
    eq(canOpenNew(v).allowed, true);
  });

  test('숏(음수 수량)도 같게 본다', () => {
    const v = cycleState({
      orderStatus: 'FILLED', positionQty: -0.9748, stop: attached(), protectionClosesAll: true,
    });
    eq(v.stage, 'PROTECTED');
    eq(v.ok, true);
  });

  test('요약 문구는 급한 것과 아닌 것을 다르게 적는다', () => {
    const urgent = cycleState({ orderStatus: 'FILLED', positionQty: 1, stop: missing() });
    const mild = cycleState({ orderStatus: 'FILLED', positionQty: 1, stop: unknown() });
    assert(cycleSummary(urgent).startsWith('🛑'), cycleSummary(urgent));
    assert(cycleSummary(mild).startsWith('⚠'), cycleSummary(mild));
    const ok = cycleState({ orderStatus: 'FILLED', positionQty: 0, stop: missing() });
    assert(!cycleSummary(ok).startsWith('🛑') && !cycleSummary(ok).startsWith('⚠'), cycleSummary(ok));
  });

  test('빈 입력에도 터지지 않는다', () => {
    const v = cycleState(null);
    eq(v.broken, 'POSITION_UNKNOWN', '아무것도 모르면 모른다고 해야 한다');
    assert(canOpenNew(v).allowed === false);
  });
}
