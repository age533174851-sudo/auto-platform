// src/lib/engine/orderProgress.test.ts
//
// 막으려는 것:
//  1. **확정 전에 재주문이 열려 있는 것.** 사용자가 "안 됐네" 하고 한
//     번 더 누르는 사이에 앞 주문이 붙으면 포지션이 두 배가 된다 —
//     그건 사용자가 정한 크기가 아니다
//  2. 응답을 기다리는 사이가 열려 있는 것. 그 구간이 가장 위험하다
//  3. 실패했는데도 잠가서, 사유를 고치고 다시 시도할 수 없게 하는 것
//  4. settled를 안 주는 경로(바이낸스)에서 갑자기 주문이 막히는 것
import { test, assert, eq } from '../../test/harness';
import { progressOf, shouldRefresh, PROGRESS_STEPS } from './orderProgress';

export function runOrderProgressTests() {
  console.log('[주문 진행 — 모르는 동안 잠근다]');

  test('응답을 기다리는 사이에는 잠근다', () => {
    // 아무 반응 없는 화면을 보고 사용자는 다시 누른다.
    const v = progressOf({ sent: true, responded: false });
    eq(v.stage, 'SUBMITTING');
    eq(v.locked, true);
    assert(v.lockReason.includes('두 번 나갈 수'), v.lockReason);
  });

  test('접수됐는데 체결이 미확정이면 잠근다', () => {
    // 이번에 실제로 겪은 상태다 — 접수 0/2079.
    const v = progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'ACCEPTED', settled: false, filledQty: 0, requestedQty: 2079 },
    });
    eq(v.stage, 'ACCEPTED');
    eq(v.locked, true);
    assert(v.lockReason.includes('두 배'), v.lockReason);
  });

  test('부분 체결도 확정 전이면 잠근다', () => {
    const v = progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'PARTIAL', settled: false, filledQty: 800, requestedQty: 2079 },
    });
    eq(v.stage, 'PARTIAL');
    eq(v.locked, true);
    assert(v.label.includes('800/2079'), v.label);
  });

  test('확정되면 푼다 — 일부러 더 사는 것을 막으면 안 된다', () => {
    const v = progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'FILLED', settled: true, filledQty: 2079, requestedQty: 2079 },
    });
    eq(v.stage, 'FILLED');
    eq(v.locked, false);
    eq(v.lockReason, '');
  });

  test('실패는 잠그지 않는다 — 고쳐서 다시 시도할 수 있어야 한다', () => {
    const v = progressOf({ sent: true, responded: true, ok: false });
    eq(v.stage, 'FAILED');
    eq(v.locked, false);
  });

  test('확정 미체결도 잠그지 않는다', () => {
    const v = progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'UNFILLED', settled: true, filledQty: 0, requestedQty: 100 },
    });
    eq(v.stage, 'FAILED');
    eq(v.locked, false);
  });

  console.log('[주문 진행 — 안 주는 경로는 예전처럼]');

  test('settled를 안 주면 잠그지 않는다', () => {
    // 바이낸스 경로는 아직 이 값을 안 준다. 여기서 잠그면 지금까지
    // 되던 주문이 갑자기 한 번씩 막힌다.
    const v = progressOf({ sent: true, responded: true, ok: true });
    eq(v.stage, 'ACCEPTED');
    eq(v.locked, false);
  });

  test('서버 settled만 있어도 판단한다', () => {
    eq(progressOf({ sent: true, responded: true, ok: true, settled: false }).locked, true);
    eq(progressOf({ sent: true, responded: true, ok: true, settled: true }).locked, false);
  });

  console.log('[주문 진행 — 단계]');

  test('안 보냈으면 아무것도 안 그린다', () => {
    const v = progressOf({});
    eq(v.stage, 'IDLE');
    eq(v.label, '');
    eq(v.step, 0);
    eq(v.locked, false);
  });

  test('보호까지 확인되면 마지막 단계다', () => {
    const v = progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'FILLED', settled: true, filledQty: 1, requestedQty: 1 },
      protectedNow: true,
    });
    eq(v.stage, 'PROTECTED');
    eq(v.step, PROGRESS_STEPS.length);
  });

  test('체결됐는데 보호가 없으면 그렇게 적는다', () => {
    // '완료'로 적으면 사용자가 보호된 줄 알고 손을 뗀다.
    const v = progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'FILLED', settled: true, filledQty: 1, requestedQty: 1 },
      unprotected: true,
    });
    eq(v.stage, 'UNPROTECTED');
    assert(v.label.includes('보호되지 않은'), v.label);
    eq(v.locked, false, '잠그면 정리도 못 한다');
  });

  test('단계는 뒤로 가지 않는다', () => {
    const submitting = progressOf({ sent: true, responded: false });
    const accepted = progressOf({ sent: true, responded: true, ok: true, settled: false });
    const filled = progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'FILLED', settled: true, filledQty: 1, requestedQty: 1 },
    });
    assert(submitting.step <= accepted.step, `${submitting.step} > ${accepted.step}`);
    assert(accepted.step <= filled.step, `${accepted.step} > ${filled.step}`);
  });

  console.log('[주문 진행 — 언제 다시 읽는가]');

  test('체결이 확인되면 화면을 다시 읽는다', () => {
    // 하나만 읽으면 화면이 반쯤만 맞는다 — 포지션은 새 값인데
    // 잔고는 옛 값이면 사용자가 그 차이를 보고 계산을 다시 한다.
    eq(shouldRefresh(progressOf({
      sent: true, responded: true, ok: true,
      fill: { phase: 'FILLED', settled: true, filledQty: 1, requestedQty: 1 },
    })), true);
  });

  test('아직 모르는 동안에는 안 읽는다', () => {
    eq(shouldRefresh(progressOf({ sent: true, responded: false })), false);
    eq(shouldRefresh(progressOf({ sent: true, responded: true, ok: false })), false);
  });
}
