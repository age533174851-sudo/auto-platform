import { test, eq } from '../../test/harness';
import { classifyExitRestart as decide } from './exitRestartReconcile';

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
  test('영속 의도 기록을 못 읽으면 차단한다', () => {
    const r = decide({ intent: undefined, position: { ok: true, found: false },
      order: { ok: true, state: 'FILLED' } });
    eq(r.code, 'READ_FAILED'); eq(r.mayMarkClosed, false);
  });
}
