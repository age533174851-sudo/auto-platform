import { test, eq } from '../../test/harness';
import { classifyExitRestart as decide } from './exitRestartReconcile';
import { reconcileExitRestartReadOnly } from './exitRestartEvidence';

export function runExitRestartReconcileTests() {
  console.log('\n🔒 #325 재시작 청산 대조 (가짜 거래소)');
  test('응답 유실 + 주문 미확인 + 포지션 잔존: 재전송 0', () => {
    const r = decide({ intent: 'UNKNOWN', position: { ok: true, found: true },
      order: { ok: true, state: 'NOT_FOUND' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayResend, false); eq(r.mayMarkClosed, false);
  });
  test('부분 체결 + 잔여 포지션: 재전송·종료 기록 모두 차단', () => {
    const r = decide({ intent: 'ACCEPTED', position: { ok: true, found: true },
      order: { ok: true, state: 'PARTIAL' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayResend, false); eq(r.mayMarkClosed, false);
  });
  test('포지션 조회 실패는 종료 증거가 아니다', () => {
    const r = decide({ intent: 'SENT', position: { ok: false, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'READ_FAILED'); eq(r.mayMarkClosed, false);
  });
  test('주문 조회 실패 + 포지션 0: 종료를 아직 확정하지 않는다', () => {
    const r = decide({ intent: 'UNKNOWN', position: { ok: true, found: false },
      order: { ok: false, state: 'UNKNOWN' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('체결 확인 + 포지션 0: 종료 기록만 허용, 재전송 불허', () => {
    const r = decide({ intent: 'FILLED', position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'FLAT_VERIFIED'); eq(r.mayMarkClosed, true); eq(r.mayResend, false);
  });
  test('재시작 후 주문이 취소됐어도 포지션이 남으면 새 주문을 자동 발행하지 않는다', () => {
    const r = decide({ intent: 'ACCEPTED', position: { ok: true, found: true },
      order: { ok: true, state: 'CANCELLED' } });
    eq(r.code, 'POSITION_OPEN'); eq(r.mayResend, false);
  });
  test('거부된 주문 + 포지션 0은 이 청산의 성공 증거가 아니다', () => {
    const r = decide({ intent: 'REJECTED', position: { ok: true, found: false },
      order: { ok: true, state: 'REJECTED' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('취소된 주문 + 포지션 0도 이 청산의 성공 증거가 아니다', () => {
    const r = decide({ intent: 'ACCEPTED', position: { ok: true, found: false },
      order: { ok: true, state: 'CANCELLED' } });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('영속 의도가 NONE이면 타인의 체결로 종료 처리하지 않는다', () => {
    const r = decide({ intent: 'NONE', position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'NO_INTENT'); eq(r.mayMarkClosed, false);
  });
  test('재시작 2회: 같은 영속 주문 ID로만 조회하고 신규 전송은 없다', async () => {
    const calls: string[] = [];
    const durable = { clientOrderId: 'exit-abc', state: 'UNKNOWN' as const };
    const reads = {
      loadIntent: async () => { calls.push('load'); return durable; },
      readPosition: async () => { calls.push('position'); return { ok: true, found: true }; },
      readOrder: async (id: string) => { calls.push('order:' + id);
        return { ok: true, state: 'NOT_FOUND' as const }; },
    };
    const a = await reconcileExitRestartReadOnly(reads);
    const b = await reconcileExitRestartReadOnly(reads);
    eq(a.mayResend, false); eq(b.mayResend, false);
    eq(a.needsReconcile, true); eq(b.needsReconcile, true);
    eq(calls.join(','), 'load,position,order:exit-abc,load,position,order:exit-abc');
  });
  test('영속 주문 ID가 없으면 거래소를 조회하지 않고 차단', async () => {
    let queried = 0;
    const r = await reconcileExitRestartReadOnly({
      loadIntent: async () => ({ clientOrderId: null, state: 'SENT' }),
      readPosition: async () => { queried++; return { ok: true, found: false }; },
      readOrder: async () => { queried++; return { ok: true, state: 'FILLED' }; },
    });
    eq(queried, 0); eq(r.code, 'READ_FAILED'); eq(r.mayMarkClosed, false);
  });
  test('재시작 대조에서 주문 조회 예외는 종료가 아니다', async () => {
    const r = await reconcileExitRestartReadOnly({
      loadIntent: async () => ({ clientOrderId: 'exit-abc', state: 'UNKNOWN' }),
      readPosition: async () => ({ ok: true, found: false }),
      readOrder: async () => { throw new Error('timeout'); },
    });
    eq(r.code, 'ORDER_UNRESOLVED'); eq(r.mayMarkClosed, false);
  });
  test('영속 의도 기록을 못 읽으면 차단한다', () => {
    const r = decide({ intent: undefined, position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'READ_FAILED'); eq(r.mayMarkClosed, false);
  });
}
