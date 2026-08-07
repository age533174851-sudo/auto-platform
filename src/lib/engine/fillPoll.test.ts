// src/lib/engine/fillPoll.test.ts
//
// 막으려는 것 — 실제로 화면에 뜬 문장에서 시작한다:
//
//   주문 접수 (Gate · 2079계약) · 부분 체결 0/2079 · 손절 부착
//
//  1. **체결 0에 손절을 거는 것.** 없는 포지션에는 걸 것이 없고,
//     요청 수량으로 걸면 실제보다 큰 보호 주문이 된다
//  2. 접수(HTTP 200 + 주문번호)를 체결로 치는 것
//  3. 못 읽은 체결량을 0으로, 또는 실패로 찍는 것 — 실패로 찍으면
//     재시도가 열리고 그 재시도가 그대로 중복 체결이 된다
//  4. 확정 전에 재주문을 열어 둬서 사용자가 한 번 더 눌러 포지션이
//     두 배가 되는 것
import { test, assert, eq } from '../../test/harness';
import {
  fillPhaseOf, shouldPoll, protectionQtyFor, fillLabel, shouldLockReorder,
  isTerminalStatus, FILL_POLL_DELAYS_MS,
} from './fillPoll';

export function runFillPollTests() {
  console.log('[체결 확인 — 0은 체결이 아니다]');

  test('접수됐지만 체결 0이면 아직이다 — 실패도 성공도 아니다', () => {
    // 화면에 뜬 그 상태다. Gate가 status를 open으로 주면서 체결 0을 준다.
    const v = fillPhaseOf({ filledQty: 0, requestedQty: 2079, status: 'open' });
    eq(v.phase, 'ACCEPTED');
    eq(v.settled, false, '더 물어봐야 한다');
    assert(v.reason.includes('아직'), v.reason);
  });

  test('체결 0에는 보호 주문을 걸지 않는다', () => {
    // 요청 수량으로 걸면 실제 포지션보다 큰 보호 주문이 되고,
    // 발동 시 거부되거나 반대 포지션이 열린다.
    const v = fillPhaseOf({ filledQty: 0, requestedQty: 2079, status: 'open' });
    eq(protectionQtyFor(v), null);
  });

  test('끝났다고 말했는데 0이면 그때는 확정 미체결이다', () => {
    for (const s of ['finished', 'cancelled', 'canceled', 'expired', 'rejected']) {
      const v = fillPhaseOf({ filledQty: 0, requestedQty: 2079, status: s });
      eq(v.phase, 'UNFILLED', s);
      eq(v.settled, true, s);
      eq(protectionQtyFor(v), null, s);
    }
    eq(isTerminalStatus('OPEN'), false);
    eq(isTerminalStatus(null), false);
  });

  console.log('[체결 확인 — 모르는 것은 실패가 아니다]');

  test('체결량을 못 읽으면 UNKNOWN이고 확정이 아니다', () => {
    // 실패로 찍으면 재시도가 열리고, 그 재시도가 그대로 중복 체결이 된다.
    const v = fillPhaseOf({ filledQty: null, requestedQty: 2079 });
    eq(v.phase, 'UNKNOWN');
    eq(v.settled, false);
    eq(v.filledQty, null, '0으로 눕히면 없다는 뜻이 된다');
    eq(protectionQtyFor(v), null);
    assert(v.reason.includes('없다는 뜻이 아닙니다'), v.reason);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(fillPhaseOf(null).phase, 'UNKNOWN');
    eq(fillPhaseOf({}).phase, 'UNKNOWN');
  });

  console.log('[체결 확인 — 붙은 만큼]');

  test('전량 체결', () => {
    const v = fillPhaseOf({ filledQty: 2079, requestedQty: 2079, status: 'finished' });
    eq(v.phase, 'FILLED');
    eq(v.settled, true);
    eq(v.remainingQty, 0);
    eq(protectionQtyFor(v), 2079);
  });

  test('부분 체결이면 붙은 만큼만 보호한다', () => {
    // 보호 주문 수량이 실제 포지션보다 커지면 안 된다.
    const v = fillPhaseOf({ filledQty: 800, requestedQty: 2079, status: 'open' });
    eq(v.phase, 'PARTIAL');
    eq(v.remainingQty, 1279);
    eq(protectionQtyFor(v), 800, '요청 수량이 아니다');
    eq(v.settled, false, '나머지가 더 붙을 수 있다');
  });

  test('부분 체결로 끝났으면 더 안 기다린다', () => {
    const v = fillPhaseOf({ filledQty: 800, requestedQty: 2079, status: 'finished' });
    eq(v.phase, 'PARTIAL');
    eq(v.settled, true);
    assert(v.reason.includes('나머지는 취소'), v.reason);
  });

  test('마지막 자리 차이는 전량으로 본다', () => {
    const v = fillPhaseOf({ filledQty: 0.2079, requestedQty: 0.20790000000000001 });
    eq(v.phase, 'FILLED');
  });

  test('요청보다 많이 붙어도 거래소 값을 쓴다', () => {
    // 요청 수량으로 깎으면 보호 주문이 실제 포지션보다 작아진다.
    const v = fillPhaseOf({ filledQty: 2100, requestedQty: 2079, status: 'finished' });
    eq(protectionQtyFor(v), 2100);
  });

  console.log('[체결 확인 — 몇 번 물어보는가]');

  test('확정되면 더 안 물어본다', () => {
    const done = fillPhaseOf({ filledQty: 2079, requestedQty: 2079, status: 'finished' });
    eq(shouldPoll(done, 0), false);
  });

  test('확정 전에는 정해진 횟수만큼 물어본다', () => {
    const pending = fillPhaseOf({ filledQty: 0, requestedQty: 2079, status: 'open' });
    eq(shouldPoll(pending, 0), true);
    eq(shouldPoll(pending, FILL_POLL_DELAYS_MS.length - 1), true);
    eq(shouldPoll(pending, FILL_POLL_DELAYS_MS.length), false, '무한히 두드리지 않는다');
  });

  test('간격은 짧게 시작해 늘어난다', () => {
    // 매번 4초를 기다리게 하면 쓸 수 없는 화면이 되고,
    // 250ms로만 스무 번 두드리면 레이트리밋을 쓴다.
    for (let i = 1; i < FILL_POLL_DELAYS_MS.length; i++) {
      assert(FILL_POLL_DELAYS_MS[i] > FILL_POLL_DELAYS_MS[i - 1], String(i));
    }
    assert(FILL_POLL_DELAYS_MS[0] <= 250, '첫 재조회는 빨라야 한다');
  });

  console.log('[체결 확인 — 확정 전에는 재주문을 잠근다]');

  test('확정 전에는 잠근다 — 한 번 더 누르면 포지션이 두 배가 된다', () => {
    eq(shouldLockReorder(fillPhaseOf({ filledQty: 0, requestedQty: 100, status: 'open' })), true);
    eq(shouldLockReorder(fillPhaseOf({ filledQty: null, requestedQty: 100 })), true);
    eq(shouldLockReorder(fillPhaseOf({ filledQty: 40, requestedQty: 100, status: 'open' })), true);
  });

  test('확정된 뒤에는 안 잠근다 — 일부러 더 사는 것을 막으면 안 된다', () => {
    eq(shouldLockReorder(fillPhaseOf({ filledQty: 100, requestedQty: 100, status: 'finished' })), false);
    eq(shouldLockReorder(fillPhaseOf({ filledQty: 0, requestedQty: 100, status: 'finished' })), false);
  });

  console.log('[체결 확인 — 문구]');

  test('접수와 체결을 한 문장에 섞지 않는다', () => {
    // "부분 체결 0/2079 · 손절 부착"이 나오던 자리다.
    eq(fillLabel(fillPhaseOf({ filledQty: 0, requestedQty: 2079, status: 'open' })), '접수됨 · 체결 확인 중');
    eq(fillLabel(fillPhaseOf({ filledQty: 2079, requestedQty: 2079 })), '체결 완료');
    eq(fillLabel(fillPhaseOf({ filledQty: 800, requestedQty: 2079, status: 'open' })), '부분 체결 · 진행 중');
    eq(fillLabel(fillPhaseOf({ filledQty: 0, requestedQty: 1, status: 'finished' })), '체결되지 않음');
    eq(fillLabel(fillPhaseOf({})), '결과 확인 중');
  });
}
