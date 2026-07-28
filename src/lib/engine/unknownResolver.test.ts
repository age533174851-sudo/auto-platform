// src/lib/engine/unknownResolver.test.ts
//
// 여기서 가장 중요한 것은 "확정하지 않는" 경우들이다.
// FAILED로 잘못 확정하면 재시도가 열리고, 그 재시도가 중복 체결이 된다.
import { test, assert, eq } from '../../test/harness';
import {
  resolveUnknown, nextQueryDelayMs, shouldEscalate,
  REFLECT_GRACE_MS, MAX_RESOLVE_ATTEMPTS,
} from './unknownResolver';

const AFTER = REFLECT_GRACE_MS + 1000;

export function runUnknownResolverTests() {
  console.log('[UNKNOWN 확정 — 확정하면 안 되는 경우]');

  test('거래소에 못 닿으면 아무것도 확정하지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: false, order: null, error: 'ETIMEDOUT' },
    });
    eq(r.resolved, false, '조회 실패를 확정으로 처리했다');
    eq(r.state, 'UNKNOWN');
    eq(r.action, 'RETRY_QUERY');
  });

  test('반영 대기 시간 안에는 없어도 실패로 보지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: REFLECT_GRACE_MS - 1,
      query: { ok: true, order: null },
    });
    eq(r.state, 'UNKNOWN', '거래소가 아직 반영 안 했을 수 있다');
    eq(r.action, 'RETRY_QUERY');
  });

  test('멱등 키 없이 보낸 주문은 자동 확정하지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: null, elapsedMs: AFTER,
      query: { ok: true, order: null },
    });
    eq(r.resolved, false, '식별 수단이 없는데 실패로 확정했다');
    eq(r.action, 'ESCALATE');
  });

  test('포지션을 못 읽으면 교차 확인 없이 확정하지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyNow: null, qtyBefore: 0 },
    });
    eq(r.state, 'UNKNOWN');
    eq(r.action, 'RETRY_QUERY');
  });

  test('주문은 없는데 포지션이 변했으면 모순이므로 사람에게 넘긴다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyNow: 0.5, qtyBefore: 0 },
    });
    eq(r.resolved, false, '모순 상황을 자동 확정했다 — 재시도가 열리면 중복이다');
    eq(r.action, 'ESCALATE');
    assert(r.reason.includes('포지션'), '이유에 근거가 없다');
  });

  test('모르는 거래소 상태는 추측하지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: { status: 'SOMETHING_NEW' } },
    });
    eq(r.state, 'UNKNOWN');
    eq(r.action, 'ESCALATE');
  });

  console.log('[UNKNOWN 확정 — 확정해도 되는 경우]');

  test('주문이 조회되면 그 상태로 확정한다', () => {
    const cases: [string, string][] = [
      ['NEW', 'ACKED'], ['PARTIALLY_FILLED', 'PARTIAL'],
      ['FILLED', 'FILLED'], ['CANCELED', 'CANCELED'], ['REJECTED', 'REJECTED'],
    ];
    for (const [raw, expect] of cases) {
      const r = resolveUnknown({
        clientOrderId: 'x1', elapsedMs: AFTER,
        query: { ok: true, order: { status: raw, orderId: 1 } },
      });
      eq(r.state, expect, `${raw} 매핑이 틀렸다`);
      eq(r.resolved, true);
    }
  });

  test('멱등 키 + 반영시간 경과 + 포지션 불변이면 미전송으로 확정한다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyNow: 0, qtyBefore: 0 },
    });
    eq(r.state, 'FAILED', '세 조건이 모두 맞으면 미전송으로 볼 수 있다');
    eq(r.resolved, true);
    eq(r.action, 'NONE');
  });

  test('조회 시점에 포지션이 원래 있던 그대로면 변한 것이 아니다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyNow: 1.2, qtyBefore: 1.2 },
    });
    eq(r.state, 'FAILED', '기존 포지션이 있는 상태를 변화로 오인했다');
  });

  console.log('[UNKNOWN 확정 — 재조회 정책]');

  test('재조회 간격이 늘어나되 상한이 있다', () => {
    assert(nextQueryDelayMs(1) > nextQueryDelayMs(0), '간격이 늘지 않는다');
    eq(nextQueryDelayMs(20), 30_000, '상한이 없으면 확인이 무한정 늘어진다');
  });

  test('일정 횟수 넘으면 자동 조회를 멈추고 사람에게 넘긴다', () => {
    eq(shouldEscalate(MAX_RESOLVE_ATTEMPTS - 1), false);
    eq(shouldEscalate(MAX_RESOLVE_ATTEMPTS), true);
  });
}
