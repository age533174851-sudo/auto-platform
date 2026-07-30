// src/lib/jobs/executorHealth.test.ts
//
// 이 테스트가 막는 것: **실행자가 없는데 주문을 받아 놓는 것.**
//
// 큐에 넣고 `ok: true`를 돌려주면 화면은 "주문됨"으로 그리고 사용자는 손을
// 뗀다. 실제로는 아무 일도 일어나지 않았다. 성공처럼 보이는 실패가 이 앱에서
// 가장 위험하다.

import { test, eq, assert } from '../../test/harness';
import {
  judgeExecutor, isOrderExpired, orderExpiryIso,
  DEGRADED_AFTER_MS, STOPPED_AFTER_MS, ORDER_TTL_MS,
} from './executorHealth';

const NOW = 1_800_000_000_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

export function runExecutorHealthTests() {
  console.log('[주문 실행자 — 살아 있는가]');

  test('최근 하트비트면 정상이고 큐에 넣을 수 있다', () => {
    const v = judgeExecutor({ worker_id: 'w1', last_seen: iso(3_000), status: 'running' }, NOW);
    eq(v.status, 'running');
    eq(v.canQueue, true);
    eq(v.ageSec, 3);
    eq(v.workerId, 'w1');
  });

  test('25초를 넘기면 지연 — 막지는 않는다', () => {
    const v = judgeExecutor({ last_seen: iso(DEGRADED_AFTER_MS + 1_000) }, NOW);
    eq(v.status, 'degraded');
    eq(v.canQueue, true, '느린 것과 죽은 것은 다르다');
    assert(v.reason.includes('지연'), `지연을 알려야 한다: ${v.reason}`);
  });

  test('60초를 넘기면 중단 — 막는다', () => {
    const v = judgeExecutor({ last_seen: iso(STOPPED_AFTER_MS + 1_000) }, NOW);
    eq(v.status, 'stopped');
    eq(v.canQueue, false);
    assert(v.reason.includes('실행되지 않습니다'),
      `큐에 넣어도 소용없다는 것을 말해야 한다: ${v.reason}`);
  });

  test('스스로 중단을 보고하면 나이와 무관하게 중단이다', () => {
    const v = judgeExecutor({ last_seen: iso(1_000), status: 'stopped' }, NOW);
    eq(v.status, 'stopped');
    eq(v.canQueue, false);
  });

  test('degraded를 스스로 보고하면 지연으로 본다', () => {
    const v = judgeExecutor({ last_seen: iso(1_000), status: 'degraded' }, NOW);
    eq(v.status, 'degraded');
    eq(v.canQueue, true);
  });

  test('하트비트 행이 없으면 absent — 막는다', () => {
    const v = judgeExecutor(null, NOW);
    eq(v.status, 'absent');
    eq(v.canQueue, false);
    eq(v.ageSec, null);
  });

  test('조회 실패는 absent와 다른 상태다 — 대응이 다르다', () => {
    const v = judgeExecutor(null, NOW, true);
    eq(v.status, 'unknown');
    eq(v.canQueue, false);
    assert(v.reason.includes('확인하지 못한'),
      `확인 못 한 것을 정상으로 보지 않는다고 말해야 한다: ${v.reason}`);
  });

  test('하트비트 시각이 깨져 있으면 unknown — 막는다', () => {
    for (const bad of ['', 'not-a-date', null, undefined]) {
      const v = judgeExecutor({ last_seen: bad as any }, NOW);
      eq(v.canQueue, false, `last_seen=${String(bad)}에서 통과했다`);
    }
  });

  test('경계값: 정확히 25초·60초는 아직 넘지 않은 것이다', () => {
    eq(judgeExecutor({ last_seen: iso(DEGRADED_AFTER_MS) }, NOW).status, 'running');
    eq(judgeExecutor({ last_seen: iso(STOPPED_AFTER_MS) }, NOW).status, 'degraded');
  });

  test('미래 시각 하트비트도 정상으로 본다 — 시계 차이는 여기서 판단하지 않는다', () => {
    // 시계 오차는 preTradeChecklist의 CLOCK_SKEW가 본다. 여기서 또 막으면
    // 같은 문제로 두 곳에서 다른 메시지가 나온다.
    const v = judgeExecutor({ last_seen: new Date(NOW + 5_000).toISOString() }, NOW);
    eq(v.status, 'running');
  });

  test('막을 때는 항상 이유가 있다', () => {
    for (const v of [
      judgeExecutor(null, NOW),
      judgeExecutor(null, NOW, true),
      judgeExecutor({ last_seen: iso(999_999) }, NOW),
      judgeExecutor({ last_seen: 'x' }, NOW),
    ]) {
      eq(v.canQueue, false);
      assert(v.reason.length > 0, `${v.status}에 이유가 없다`);
    }
  });

  console.log('[적재된 주문 — 만료]');

  test('만료 전이면 실행한다', () => {
    const exp = orderExpiryIso(NOW);
    eq(isOrderExpired(exp, NOW + 1_000).expired, false);
  });

  test('만료 후면 실행하지 않는다 — 그때 시세가 아니다', () => {
    const exp = orderExpiryIso(NOW);
    const v = isOrderExpired(exp, NOW + ORDER_TTL_MS + 1_000);
    eq(v.expired, true);
    assert(v.reason.includes('시세'), `이유를 적어야 한다: ${v.reason}`);
  });

  test('만료 시각이 없으면 만료로 본다 — 언제 만든 것인지 알 수 없다', () => {
    // 이 기능 이전에 큐에 쌓인 주문이 여기 해당한다. 실행하는 쪽이 더 위험하다.
    eq(isOrderExpired(null, NOW).expired, true);
    eq(isOrderExpired(undefined, NOW).expired, true);
    eq(isOrderExpired('', NOW).expired, true);
  });

  test('만료 시각이 깨져 있으면 만료로 본다', () => {
    eq(isOrderExpired('언젠가', NOW).expired, true);
  });

  test('TTL은 2분 — 수동 주문은 화면을 보며 누른 것이다', () => {
    eq(ORDER_TTL_MS, 120_000);
    const exp = orderExpiryIso(NOW);
    eq(isOrderExpired(exp, NOW + 119_000).expired, false);
    eq(isOrderExpired(exp, NOW + 121_000).expired, true);
  });

  test('TTL을 바꿔 새길 수 있다', () => {
    const exp = orderExpiryIso(NOW, 10_000);
    eq(isOrderExpired(exp, NOW + 9_000).expired, false);
    eq(isOrderExpired(exp, NOW + 11_000).expired, true);
  });
}
