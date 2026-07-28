// src/lib/engine/orderLifecycle.test.ts
//
// 가장 중요한 것은 "UNKNOWN에서는 절대 재전송하지 않는다"이다.
// 거래소에 들어갔을 수도 있는 주문을 다시 보내면 중복 체결이 된다.
import { test, assert, eq } from '../../test/harness';
import {
  canTransition, applyTransition, canRetry, needsReconcile,
  isTerminal, fromExchangeStatus, progressIndex, type OrderState,
} from './orderLifecycle';

export function runOrderLifecycleTests() {
  console.log('[주문 생명주기 — UNKNOWN 처리]');

  test('UNKNOWN에서는 재전송하지 않는다', () => {
    eq(canRetry('UNKNOWN'), false, 'UNKNOWN 재전송을 허용했다 — 중복 체결로 이어진다');
  });

  test('UNKNOWN은 조회로 확정이 필요한 상태다', () => {
    eq(needsReconcile('UNKNOWN'), true);
    eq(needsReconcile('SENT'), true, '응답 대기 중인 SENT도 확정이 필요하다');
  });

  test('UNKNOWN은 조회 결과로 어느 쪽이든 확정될 수 있다', () => {
    for (const to of ['ACKED','FILLED','REJECTED','CANCELED','FAILED'] as OrderState[]) {
      assert(canTransition('UNKNOWN', to), `UNKNOWN → ${to}가 막혔다`);
    }
  });

  test('전송 전 실패(FAILED)만 재시도할 수 있다', () => {
    eq(canRetry('FAILED'), true, 'FAILED는 거래소에 안 들어간 것이 확실하므로 재시도 가능');
    eq(canRetry('ACKED'), false);
    eq(canRetry('FILLED'), false);
  });

  console.log('[주문 생명주기 — 뒤집힘 방지]');

  test('종료 상태는 되돌릴 수 없다', () => {
    const r = applyTransition('FAILED', 'FILLED');
    eq(r.ok, false, '실패로 확정된 주문이 체결로 바뀌었다');
    eq(r.state, 'FAILED', '거부됐는데 상태가 변했다');
    assert(!!r.reason, '이유가 없다');
  });

  test('건너뛰는 전이는 거부한다', () => {
    eq(applyTransition('DRAFT', 'FILLED').ok, false, '작성 중에서 바로 체결로 갔다');
    eq(applyTransition('APPROVED', 'ACKED').ok, false, '전송 없이 접수됐다');
  });

  test('같은 상태 재기록은 허용한다 (멱등)', () => {
    const r = applyTransition('ACKED', 'ACKED');
    eq(r.ok, true, '같은 상태를 다시 적는 것을 막으면 재조회마다 오류가 난다');
  });

  test('부분 체결은 여러 번 올 수 있다', () => {
    assert(canTransition('PARTIAL', 'PARTIAL'), '부분 체결이 연속으로 오면 갱신돼야 한다');
    assert(canTransition('PARTIAL', 'FILLED'), '부분 → 전체 체결이 막혔다');
  });

  console.log('[주문 생명주기 — 정상 경로]');

  test('정상 경로가 순서대로 이어진다', () => {
    const path: OrderState[] = ['DRAFT','PENDING','APPROVED','SENT','ACKED','PARTIAL','FILLED','PROTECTED','CLOSED'];
    for (let i = 0; i < path.length - 1; i++) {
      assert(canTransition(path[i], path[i+1]), `${path[i]} → ${path[i+1]}가 막혔다`);
    }
  });

  test('진행률 인덱스가 정상 경로에서만 나온다', () => {
    assert(progressIndex('SENT') > progressIndex('APPROVED'), '순서가 뒤바뀌었다');
    eq(progressIndex('UNKNOWN'), -1, '분기 상태가 정상 경로로 잡혔다');
    eq(progressIndex('FAILED'), -1);
  });

  test('종료 상태 판별', () => {
    for (const s of ['CLOSED','REJECTED','FAILED','CANCELED'] as OrderState[]) {
      eq(isTerminal(s), true, `${s}가 종료 상태로 잡히지 않았다`);
    }
    eq(isTerminal('UNKNOWN'), false, 'UNKNOWN은 확정 전이므로 종료가 아니다');
  });

  console.log('[주문 생명주기 — 거래소 응답 매핑]');

  test('Binance 상태를 내부 상태로 옮긴다', () => {
    eq(fromExchangeStatus('NEW'), 'ACKED');
    eq(fromExchangeStatus('PARTIALLY_FILLED'), 'PARTIAL');
    eq(fromExchangeStatus('FILLED'), 'FILLED');
    eq(fromExchangeStatus('EXPIRED'), 'CANCELED');
    eq(fromExchangeStatus('REJECTED'), 'REJECTED');
  });

  test('모르는 상태는 null — 임의로 추측하지 않는다', () => {
    eq(fromExchangeStatus('SOMETHING_NEW'), null, '모르는 값을 임의 상태로 매핑했다');
    eq(fromExchangeStatus(null), null);
    eq(fromExchangeStatus(''), null);
  });
}
