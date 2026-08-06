// src/lib/engine/mismatchRecovery.test.ts
//
// 막으려는 것:
//  1. **막힌 자리에서 푸는 방법이 없는 것.** 대조는 무엇이 다른지까지
//     말하고 끝났다 — 어떻게 없애는지는 아무 데도 없었다
//  2. "거래소가 기준"이 곧장 "앱 기록을 지운다"로 이어지는 것.
//     조회가 부분적으로 실패했을 수도 있고, 그때 지우면 열려 있는
//     포지션을 앱이 모르게 된다
//  3. 보호 없는 포지션이 잔고 차이 뒤에 묻히는 것
//  4. 새 불일치 코드가 생겼는데 규칙이 안 따라와, 조용히 자동 처리되는 것
import { test, assert, eq } from '../../test/harness';
import { recoveryPlan, recoveryStepOf, confirmLinesFor } from './mismatchRecovery';
import type { Mismatch } from './stateReconcile';

const mm = (code: any, severity: any = 'critical', extra: Partial<Mismatch> = {}): Mismatch =>
  ({ code, severity, symbol: 'BTCUSDT', detail: 'x', ...extra } as Mismatch);

export function runMismatchRecoveryTests() {
  console.log('[불일치 복구 — 지우는 것은 확인을 받는다]');

  test('앱에만 있는 포지션은 자동으로 안 지운다', () => {
    // 정말 닫힌 것일 수도 있지만, 조회가 그 심볼을 못 봤을 수도 있다.
    // 후자에서 지우면 열려 있는 포지션을 앱이 모르게 되고, 그 뒤로
    // 손절도 안 걸린다.
    const st = recoveryStepOf(mm('POSITION_MISSING_ON_EXCHANGE'))!;
    eq(st.action, 'CLEAR_STALE_RECORD');
    eq(st.safeToAutomate, false);
    eq(st.destructive, true);
    assert(st.why.includes('조회가 이 심볼을 못 봤을 수도'), st.why);
  });

  test('거래소에만 있는 포지션은 들여온다 — 더하는 쪽이라 자동이다', () => {
    const st = recoveryStepOf(mm('POSITION_MISSING_IN_APP'))!;
    eq(st.action, 'ADOPT_FROM_EXCHANGE');
    eq(st.safeToAutomate, true);
    eq(st.destructive, false);
  });

  test('방향이 다르면 사람이 본다', () => {
    // 방향을 잘못 잡으면 청산이 신규 진입이 된다.
    const st = recoveryStepOf(mm('POSITION_SIDE_DIFFERS'))!;
    eq(st.action, 'MANUAL_ONLY');
    eq(st.safeToAutomate, false);
  });

  test('지우는 작업의 확인 문구에 무엇이 지워지는지 적는다', () => {
    const st = recoveryStepOf(mm('POSITION_MISSING_ON_EXCHANGE', 'critical',
      { app: '0.5 LONG', exchange: '없음' }))!;
    const text = confirmLinesFor(st).join('\n');
    assert(text.includes('0.5 LONG'), text);
    assert(text.includes('되돌릴 수 없습니다'), text);
    // 앱 기록을 지우는 것이지 거래소를 건드리는 것이 아니라는 것도 적는다.
    assert(text.includes('거래소의 포지션과 체결 이력은 건드리지 않습니다'), text);
  });

  console.log('[불일치 복구 — 거래소가 기준이다]');

  test('모든 규칙이 거래소를 기준으로 삼는다', () => {
    const codes = [
      'POSITION_MISSING_ON_EXCHANGE', 'POSITION_MISSING_IN_APP', 'POSITION_QTY_DIFFERS',
      'LEVERAGE_DIFFERS', 'MARGIN_TYPE_DIFFERS', 'PROTECTIVE_ORDER_MISSING',
      'ORDER_MISSING_ON_EXCHANGE', 'ORDER_MISSING_IN_APP',
    ];
    for (const c of codes) {
      eq(recoveryStepOf(mm(c))!.authority, 'EXCHANGE', c);
    }
  });

  test('앱 값과 거래소 값을 나란히 준다', () => {
    const st = recoveryStepOf(mm('POSITION_QTY_DIFFERS', 'warn', { app: 0.5, exchange: 1 }))!;
    eq(st.appValue, '0.5');
    eq(st.exchangeValue, '1');
  });

  test('값이 없으면 지어내지 않는다', () => {
    const st = recoveryStepOf(mm('POSITION_QTY_DIFFERS', 'warn'))!;
    eq(st.appValue, '—');
    eq(st.exchangeValue, '—');
  });

  console.log('[불일치 복구 — 급한 것이 먼저다]');

  test('보호 없는 포지션이 맨 위로 온다', () => {
    // 잔고 차이 뒤에 묻히면 안 된다.
    const plan = recoveryPlan([
      mm('BALANCE_DIFFERS', 'info'),
      mm('ORDER_MISSING_ON_EXCHANGE', 'warn'),
      mm('PROTECTIVE_ORDER_MISSING', 'critical'),
      mm('POSITION_SIDE_DIFFERS', 'critical'),
    ]);
    eq(plan.steps[0].code, 'PROTECTIVE_ORDER_MISSING');
    eq(plan.steps[plan.steps.length - 1].code, 'BALANCE_DIFFERS');
  });

  test('critical만 신규 주문을 막는다', () => {
    eq(recoveryPlan([mm('BALANCE_DIFFERS', 'info')]).blocksNewOrders, false);
    eq(recoveryPlan([mm('ORDER_MISSING_ON_EXCHANGE', 'warn')]).blocksNewOrders, false);
    eq(recoveryPlan([mm('PROTECTIVE_ORDER_MISSING', 'critical')]).blocksNewOrders, true);
  });

  test('잔고 차이는 할 일이 없다', () => {
    const plan = recoveryPlan([mm('BALANCE_DIFFERS', 'info')]);
    eq(plan.autoSteps.length, 0);
    eq(plan.manualSteps.length, 0, '미실현 손익으로도 생기는 것을 할 일로 세면 안 된다');
    eq(plan.steps.length, 1, '그래도 목록에는 남긴다');
  });

  console.log('[불일치 복구 — 계획 요약]');

  test('사진의 상태를 계획으로 옮긴다', () => {
    // 상태 불일치 3건 + 미확정 주문
    const plan = recoveryPlan([
      mm('ORDER_MISSING_ON_EXCHANGE', 'warn'),
      mm('POSITION_QTY_DIFFERS', 'warn'),
      mm('PROTECTIVE_ORDER_MISSING', 'critical'),
    ]);
    eq(plan.steps.length, 3);
    eq(plan.autoSteps.length, 3);
    eq(plan.manualSteps.length, 0);
    eq(plan.blocksNewOrders, true);
    assert(plan.summary.includes('어긋난 곳 3건'), plan.summary);
    assert(plan.summary.includes('자동 복구 가능 3건'), plan.summary);
    assert(plan.summary.includes('신규 주문이 막혀'), plan.summary);
  });

  test('일치하면 그렇게 적는다', () => {
    const plan = recoveryPlan([]);
    eq(plan.summary, '앱과 거래소가 일치합니다');
    eq(plan.blocksNewOrders, false);
    eq(recoveryPlan(null).steps.length, 0);
  });

  test('사람 확인이 필요한 건수를 따로 센다', () => {
    const plan = recoveryPlan([
      mm('POSITION_MISSING_ON_EXCHANGE', 'critical'),
      mm('POSITION_SIDE_DIFFERS', 'critical'),
      mm('PROTECTIVE_ORDER_MISSING', 'critical'),
    ]);
    eq(plan.autoSteps.length, 1);
    eq(plan.manualSteps.length, 2);
    eq(plan.destructiveSteps.length, 1);
    assert(plan.summary.includes('사람 확인 필요 2건'), plan.summary);
  });

  console.log('[불일치 복구 — 모르는 코드]');

  test('규칙이 없는 코드는 사람에게 넘긴다', () => {
    // 새 코드가 생겼는데 여기가 안 따라오면, 그 항목이 조용히 자동
    // 처리되는 것보다 사람에게 넘어가는 편이 낫다.
    const st = recoveryStepOf(mm('아직_없는_코드' as any))!;
    eq(st.action, 'MANUAL_ONLY');
    eq(st.safeToAutomate, false);
    eq(st.authority, 'UNKNOWN');
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(recoveryStepOf(null), null);
    eq(recoveryStepOf(undefined), null);
    eq(recoveryPlan(undefined).steps.length, 0);
  });
}
