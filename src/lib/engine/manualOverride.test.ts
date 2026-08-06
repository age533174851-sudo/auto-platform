// src/lib/engine/manualOverride.test.ts
//
// 막으려는 것:
//  1. 사용자가 손으로 닫았는데 자동매매가 곧바로 다시 여는 것
//     — 닫으면 열리고 또 닫으면 또 열린다. 수수료는 사용자가 낸다
//  2. 미체결 주문을 못 읽었을 때 '없음'으로 읽어 손절 체결로 오인하는 것
//     — 그러면 곧바로 다시 연다
//  3. 포지션 조회 실패를 '없음'으로 읽어 이미 있는 포지션 위에 또 여는 것
//  4. 한 번 손으로 닫았다고 영구히 잠가, 사용자가 안전장치를 통째로 끄게 만드는 것
import { test, assert, eq } from '../../test/harness';
import { classifyClose, suppressGate, SUPPRESS_MIN } from './manualOverride';

const T0 = Date.UTC(2026, 0, 1, 12, 0);

export function runManualOverrideTests() {
  console.log('[수동 청산 — 무엇으로 닫혔는가]');

  test('보호 주문이 남아 있는데 포지션이 없으면 손으로 닫은 것이다', () => {
    // 손절로 닫혔다면 그 주문은 체결돼서 주문장에 없다.
    // 남아 있는데 포지션이 없다는 것은 다른 손이 닫았다는 뜻이다.
    const r = classifyClose({
      hasPosition: false, stopOrderId: 'S1', openOrderIds: ['S1'],
    });
    eq(r.cause, 'MANUAL');
    eq(r.shouldSuppress, true);
  });

  test('보호 주문이 사라졌으면 그것으로 닫힌 것이다', () => {
    eq(classifyClose({ hasPosition: false, stopOrderId: 'S1', openOrderIds: [] }).cause, 'STOP');
    eq(classifyClose({ hasPosition: false, takeProfitOrderId: 'T1', openOrderIds: [] }).cause,
       'TAKE_PROFIT');
  });

  test('손절과 익절이 둘 다 사라지면 원인은 모르지만 막지는 않는다', () => {
    // 둘 다 걸려 있었고 둘 다 사라졌다면 그중 하나가 체결된 것이다.
    // 정상 종료이고 원인만 모른다.
    const r = classifyClose({
      hasPosition: false, stopOrderId: 'S1', takeProfitOrderId: 'T1', openOrderIds: [],
    });
    eq(r.cause, 'UNKNOWN');
    eq(r.shouldSuppress, false, '정상 종료까지 막으면 자동매매가 못 돈다');
  });

  test('강제청산과 엔진 청산은 따로 본다', () => {
    eq(classifyClose({ hasPosition: false, liquidated: true }).cause, 'LIQUIDATION');
    eq(classifyClose({ hasPosition: false, engineClosed: true }).cause, 'ENGINE');
    eq(classifyClose({ hasPosition: false, engineClosed: true }).shouldSuppress, false,
       '자기가 닫은 것까지 막으면 안 된다');
  });

  console.log('[수동 청산 — 못 읽은 것을 없음으로 읽지 않는다]');

  test('미체결을 못 읽으면 손절 체결로 오인하지 않는다', () => {
    // null을 빈 배열로 접으면 "보호 주문이 사라졌다" → 손절 체결 →
    // 곧바로 다시 연다. 이 저장소에서 가장 자주 반복된 실수의 모양이다.
    const r = classifyClose({ hasPosition: false, stopOrderId: 'S1', openOrderIds: null });
    eq(r.cause, 'UNKNOWN');
    eq(r.shouldSuppress, true, '모르면 막는 쪽으로 기운다');
    assert(r.reason.includes('읽지 못해'), r.reason);
  });

  test('포지션을 못 읽으면 닫혔다고 단정하지 않는다', () => {
    const r = classifyClose({ hasPosition: null, stopOrderId: 'S1', openOrderIds: [] });
    eq(r.cause, 'UNKNOWN');
    eq(r.shouldSuppress, true, '모르는 채로 열면 이미 있는 포지션 위에 또 연다');
  });

  test('아직 포지션이 있으면 닫힌 것이 아니다', () => {
    const r = classifyClose({ hasPosition: true, stopOrderId: 'S1', openOrderIds: ['S1'] });
    eq(r.cause, 'UNKNOWN');
    eq(r.shouldSuppress, false);
    assert(r.reason.includes('아직 있습니다'), r.reason);
  });

  test('보호 주문을 건 적이 없으면 가릴 근거가 없다', () => {
    const r = classifyClose({ hasPosition: false, openOrderIds: [] });
    eq(r.cause, 'UNKNOWN');
    eq(r.shouldSuppress, true);
  });

  console.log('[수동 청산 — 쿨다운]');

  test('기록이 없으면 통과다', () => {
    eq(suppressGate(null, T0).allowed, true, '한 번도 안 닫힌 종목까지 막으면 시작을 못 한다');
    eq(suppressGate(undefined, T0).allowed, true);
  });

  test('손으로 닫은 직후에는 안 연다', () => {
    const r = suppressGate({ atMs: T0, cause: 'MANUAL' }, T0 + 60_000);
    eq(r.allowed, false);
    assert(r.reason.includes('손으로 닫았습니다'), r.reason);
    assert(r.waitMin > 0);
  });

  test('쿨다운이 지나면 다시 연다 — 영구히 막지 않는다', () => {
    // 영구히 막으면 사용자가 다시 켜는 방법을 찾다가 결국 안전장치를
    // 통째로 끈다.
    const after = T0 + SUPPRESS_MIN.MANUAL * 60_000;
    eq(suppressGate({ atMs: T0, cause: 'MANUAL' }, after).allowed, true);
  });

  test('강제청산은 수동보다 오래 잠근다', () => {
    assert(SUPPRESS_MIN.LIQUIDATION > SUPPRESS_MIN.MANUAL,
      '시장이 전략과 안 맞는 국면이라는 신호다');
  });

  test('원인을 못 가린 경우는 짧게 잠근다', () => {
    // 조회 한 번 실패로 하루를 잠그면 그건 그것대로 사고다.
    assert(SUPPRESS_MIN.UNKNOWN > 0);
    assert(SUPPRESS_MIN.UNKNOWN < SUPPRESS_MIN.MANUAL);
  });

  test('정상 종료는 쿨다운이 없다', () => {
    for (const c of ['STOP', 'TAKE_PROFIT', 'ENGINE'] as const) {
      eq(SUPPRESS_MIN[c], 0, c);
      eq(suppressGate({ atMs: T0, cause: c }, T0 + 1000).allowed, true, c);
    }
  });

  test('쿨다운 길이를 호출부가 바꿀 수 있다', () => {
    const r = suppressGate({ atMs: T0, cause: 'MANUAL' }, T0 + 60_000, { MANUAL: 1 });
    eq(r.allowed, true, '1분 쿨다운이면 1분 뒤엔 통과');
  });

  test('시각이 이상하면 통과시키지 않는다', () => {
    eq(suppressGate({ atMs: NaN, cause: 'MANUAL' }, T0).allowed, false);
    eq(suppressGate({ atMs: T0 + 60_000, cause: 'MANUAL' }, T0).allowed, false, '미래 기록');
  });

  test('남은 시간을 분으로 알려준다', () => {
    const r = suppressGate({ atMs: T0, cause: 'MANUAL' }, T0 + 30 * 60_000);
    eq(r.waitMin, SUPPRESS_MIN.MANUAL - 30);
  });
}
