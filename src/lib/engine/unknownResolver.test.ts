// src/lib/engine/unknownResolver.test.ts
//
// 여기서 가장 중요한 것은 "확정하지 않는" 경우들이다.
// FAILED로 잘못 확정하면 재시도가 열리고, 그 재시도가 중복 체결이 된다.
import { test, assert, eq } from '../../test/harness';
import {
  resolveUnknown, resolveAcked, nextQueryDelayMs, shouldEscalate,
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

  // ══ ACKED는 UNKNOWN과 규칙이 다르다 ══
  //
  // resolveUnknown의 마지막 규칙은 "주문이 안 보이고 포지션도 그대로면
  // 전송 안 됨(FAILED)"이다. **ACKED에 그 규칙을 쓰면 안 된다.**
  // 거래소가 이미 받았다고 확인해 준 주문이기 때문이다.
  const okQuery = { ok: true, order: null as any };

  test('ACKED인데 조회에 없으면 FAILED가 아니라 RECONCILED다', () => {
    const r = resolveAcked({ clientOrderId: 'c1', elapsedMs: 60_000, query: okQuery });
    eq(r.resolved, true);
    eq(r.state, 'RECONCILED', 'ACKED 주문을 전송 실패로 찍었다 — 장부가 거짓말을 하고 재시도가 열린다');
    assert(!/전송되지 않/.test(r.reason), r.reason);
  });

  test('같은 상황에서 UNKNOWN은 여전히 FAILED다 — 규칙을 섞지 않는다', () => {
    const r = resolveUnknown({ clientOrderId: 'c1', elapsedMs: 60_000, query: okQuery });
    eq(r.state, 'FAILED');
  });

  test('거래소에 못 닿으면 ACKED를 그대로 둔다', () => {
    const r = resolveAcked({ clientOrderId: 'c1', elapsedMs: 60_000,
      query: { ok: false, order: null, error: 'timeout' } });
    eq(r.resolved, false);
    eq(r.state, 'ACKED', '조회 실패를 확정으로 바꿨다');
    eq(r.action, 'RETRY_QUERY');
  });

  test('주문이 조회되면 거래소 상태를 그대로 따른다', () => {
    const r = resolveAcked({ clientOrderId: 'c1', elapsedMs: 60_000,
      query: { ok: true, order: { status: 'FILLED', executedQty: '1' } as any } });
    eq(r.resolved, true);
    eq(r.state, 'FILLED');
  });

  test('반영 대기 시간 안이면 확정하지 않는다', () => {
    const r = resolveAcked({ clientOrderId: 'c1', elapsedMs: 100, query: okQuery });
    eq(r.resolved, false);
    eq(r.action, 'RETRY_QUERY');
  });

  test('멱등 키가 없으면 사람에게 넘긴다 — 식별할 방법이 없다', () => {
    const r = resolveAcked({ clientOrderId: null, elapsedMs: 60_000, query: okQuery });
    eq(r.resolved, false);
    eq(r.action, 'ESCALATE');
  });

  // 체결인지 취소인지는 이 조회로 알 수 없다. 아는 척하면 손익이 틀어진다.
  test('체결·취소 어느 쪽이라고도 단정하지 않는다', () => {
    const r = resolveAcked({ clientOrderId: 'c1', elapsedMs: 60_000, query: okQuery });
    assert(r.reason.includes('거래 내역'), '확인할 곳을 안 알려줬다: ' + r.reason);
    assert(r.state !== 'FILLED' && r.state !== 'CANCELED', '단정했다: ' + r.state);
  });

  // ── 숫자가 아닌 입력은 '유예가 지났다'·'포지션이 그대로다'의 증거가 아니다 ──
  //
  // 호출부(`reconcilePendingOrders`)는 `Date.now() - new Date(sent_at).getTime()`
  // 과 `Number(pos_qty_before)`를 그대로 넘긴다. 시각 문자열이 깨졌거나 수량
  // 칸이 숫자가 아니면 NaN이 온다. 그런데 `NaN < 5000`은 false라 반영 유예를
  // **지난 것으로** 통과하고, `NaN / base > 0.001`도 false라 포지션이 **변하지
  // 않은 것으로** 통과한다. 둘이 겹치면 SENT/UNKNOWN 주문이 FAILED(전송 안 됨)로
  // 확정되고 — 재전송이 열린다. 이 파일 첫 줄의 경고 그대로다.
  console.log('[UNKNOWN 확정 — 숫자가 아닌 입력]');

  test('경과 시간이 NaN이면 반영 유예가 지난 것으로 보지 않는다 (UNKNOWN)', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: NaN,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: 0 },
    });
    eq(r.resolved, false, 'NaN 경과 시간으로 FAILED 확정했다: ' + r.reason);
    eq(r.state, 'UNKNOWN');
    eq(r.action, 'RETRY_QUERY');
  });

  test('경과 시간이 Infinity여도 확정 근거가 아니다 (UNKNOWN)', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: Infinity,
      query: { ok: true, order: null },
    });
    eq(r.resolved, false, 'Infinity 경과 시간으로 확정했다: ' + r.reason);
    eq(r.state, 'UNKNOWN');
  });

  test('지금 포지션 수량이 NaN이면 "포지션 그대로"로 보지 않는다 (UNKNOWN)', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: NaN },
    });
    eq(r.resolved, false, 'NaN 포지션을 변화 없음으로 읽고 FAILED 확정했다: ' + r.reason);
    eq(r.state, 'UNKNOWN');
    eq(r.action, 'RETRY_QUERY');
  });

  test('전송 전 수량(qtyBefore)이 NaN이면 교차 확인이 성립하지 않는다 (UNKNOWN)', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyBefore: NaN, qtyNow: 0.5 },
    });
    eq(r.resolved, false, 'NaN 기준값으로 FAILED 확정했다: ' + r.reason);
    eq(r.state, 'UNKNOWN');
  });

  test('정상 유한값(0 → 0, 유예 지남)은 여전히 FAILED로 확정한다 — 막기만 하지 않는다', () => {
    const r = resolveUnknown({
      clientOrderId: 'x1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: 0 },
    });
    eq(r.resolved, true);
    eq(r.state, 'FAILED');
  });

  test('ACKED도 경과 시간이 NaN이면 종료(RECONCILED)로 정리하지 않는다', () => {
    const r = resolveAcked({
      clientOrderId: 'c1', elapsedMs: NaN,
      query: { ok: true, order: null },
    });
    eq(r.resolved, false, 'NaN 경과 시간으로 RECONCILED 정리했다: ' + r.reason);
    eq(r.state, 'ACKED');
    eq(r.action, 'RETRY_QUERY');
  });

  test('ACKED 정리 사유가 NaN 포지션을 "포지션도 그대로"라고 적지 않는다', () => {
    const r = resolveAcked({
      clientOrderId: 'c1', elapsedMs: AFTER,
      query: { ok: true, order: null },
      position: { qtyBefore: 0, qtyNow: NaN },
    });
    assert(!r.reason.includes('포지션도 그대로'),
      '읽지 못한 포지션을 그대로라고 적었다: ' + r.reason);
  });
}
