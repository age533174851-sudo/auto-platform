// src/lib/runtime/workerPlan.test.ts
//
// 막으려는 것:
//  1. **두 Worker가 같은 job을 동시에 도는 것.** Fly가 Machine을 옮기면
//     잠깐 둘이 살아 있을 수 있고, 그때 같은 주문이 두 번 나간다
//  2. 늦게 깨어난 Worker가 옛 번호표로 주문을 내는 것 — 임대 만료만으로는
//     못 막는다
//  3. 죽어 있던 동안의 틱을 몰아서 처리하는 것
//  4. 종료 신호를 받고도 새 주문을 내는 것 — 그 주문의 결과를 아무도
//     확인하지 못한 채 프로세스가 사라진다
//  5. Worker의 로컬 상태로 복구하는 것 — 같은 상황에서 두 번 다른
//     결과가 나오는 시스템은 검증할 수 없다
import { test, assert, eq } from '../../test/harness';
import {
  nextStep, recoveryPlan, shutdownPlan, workerIdFrom,
  HEARTBEAT_EVERY_MS, LEASE_TTL_MS, HOST_INDEPENDENT_NOTE,
  type StepInput,
} from './workerPlan';

const NOW = 1_700_000_000_000;
const ME = 'fly-machine-abc';

/** 정상적으로 내 임대를 들고 도는 상태 */
const MINE: StepInput = {
  jobId: 'job-1', desiredState: 'RUNNING',
  leaseOwner: ME, leaseExpiresAtMs: NOW + 20_000,
  myWorkerId: ME, myFencingToken: 7, currentFencingToken: 7,
  lastTickAtMs: NOW - 20_000, intervalSec: 10, nowMs: NOW,
};

export function runWorkerPlanTests() {
  console.log('[Worker — 종료 중에는 새 일을 받지 않는다]');

  test('종료 신호를 받으면 틱을 시작하지 않는다', () => {
    // SIGTERM 뒤에 주문을 내면 그 주문의 결과를 아무도 확인하지 못한 채
    // 프로세스가 사라진다. 그 주문은 UNKNOWN으로 남는다.
    const s = nextStep({ ...MINE, shuttingDown: true });
    eq(s.action, 'DRAIN');
    eq(s.tickKey, null);
  });

  test('종료가 다른 모든 조건보다 먼저다', () => {
    // 돌 시각이고 임대도 내 것이어도 종료가 이긴다.
    const s = nextStep({ ...MINE, lastTickAtMs: NOW - 999_999, shuttingDown: true });
    eq(s.action, 'DRAIN');
  });

  console.log('[Worker — 남의 임대로 돌지 않는다]');

  test('남이 들고 있으면 기다린다', () => {
    const s = nextStep({ ...MINE, leaseOwner: 'other-machine', leaseExpiresAtMs: NOW + 20_000 });
    eq(s.action, 'IDLE');
    eq(s.tickKey, null);
  });

  test('만료된 임대는 가져온다', () => {
    const s = nextStep({ ...MINE, leaseOwner: 'other-machine', leaseExpiresAtMs: NOW - 1 });
    eq(s.action, 'ACQUIRE_LEASE');
  });

  test('내 id가 없으면 아무것도 안 한다', () => {
    // id를 지어내면 재시작마다 달라져서 같은 Machine인지 구분할 수 없다.
    eq(nextStep({ ...MINE, myWorkerId: '' }).action, 'IDLE');
    eq(nextStep({ ...MINE, myWorkerId: null }).action, 'IDLE');
  });

  console.log('[Worker — 번호표가 임대를 한 번 더 막는다]');

  test('옛 번호표를 들고 있으면 임대를 놓는다', () => {
    // Fly가 Machine을 옮기는 동안 잠깐 둘이 살아 있으면, 늦게 깨어난
    // 쪽이 옛 번호표로 주문을 낸다. 임대 만료만으로는 못 막는다.
    const s = nextStep({ ...MINE, myFencingToken: 6, currentFencingToken: 7 });
    eq(s.action, 'RELEASE');
    assert(s.reason.includes('번호표'), s.reason);
  });

  test('번호표를 못 읽으면 통과시키지 않는다', () => {
    eq(nextStep({ ...MINE, myFencingToken: null }).action, 'RELEASE');
    eq(nextStep({ ...MINE, currentFencingToken: null }).action, 'RELEASE');
  });

  console.log('[Worker — 시각이 됐을 때만 돈다]');

  test('아직 시각이 안 됐으면 심장박동만 갱신한다', () => {
    const s = nextStep({ ...MINE, lastTickAtMs: NOW - 3_000, intervalSec: 10 });
    eq(s.action, 'HEARTBEAT');
    eq(s.tickKey, null);
    assert(s.reason.includes('남았습니다'), s.reason);
  });

  test('시각이 되면 돌고 열쇠를 만든다', () => {
    const s = nextStep(MINE);
    eq(s.action, 'RUN_TICK');
    assert(typeof s.tickKey === 'string' && s.tickKey.length > 0, String(s.tickKey));
  });

  test('같은 주기 안에서는 같은 열쇠다', () => {
    // 재시도해도 같은 열쇠여야 UNIQUE가 두 번째를 거절한다.
    const a = nextStep({ ...MINE, nowMs: NOW });
    const b = nextStep({ ...MINE, nowMs: NOW + 1 });
    eq(a.tickKey, b.tickKey);
  });

  test('첫 틱은 바로 돈다', () => {
    const s = nextStep({ ...MINE, lastTickAtMs: null });
    eq(s.action, 'RUN_TICK');
    assert(s.reason.includes('첫 틱'), s.reason);
  });

  test('주기를 모르면 틱을 돌리지 않는다', () => {
    eq(nextStep({ ...MINE, intervalSec: null }).action, 'HEARTBEAT');
    eq(nextStep({ ...MINE, intervalSec: 0 }).action, 'HEARTBEAT');
  });

  console.log('[Worker — 놓친 틱을 몰아서 돌지 않는다]');

  test('3분 죽어 있었어도 틱은 한 번만 돈다', () => {
    // 10초짜리 틱 18개를 지어내면 일어나지 않은 거래 18건을 만든다.
    const s = nextStep({ ...MINE, lastTickAtMs: NOW - 180_000, intervalSec: 10 });
    eq(s.action, 'RUN_TICK');
    eq(s.recordGap, true, '빈 구간으로 남긴다');
    assert(s.missedTicks! > 10, String(s.missedTicks));
    assert(s.reason.includes('없던 거래'), s.reason);
  });

  test('빈 구간이 없으면 GAP을 남기지 않는다', () => {
    const s = nextStep({ ...MINE, lastTickAtMs: NOW - 11_000, intervalSec: 10 });
    eq(s.recordGap, false);
  });

  console.log('[Worker — 사용자가 끄면 놓는다]');

  test('원하는 상태가 RUNNING이 아니면 임대를 놓는다', () => {
    for (const st of ['STOPPED', 'PAUSED', '', 'UNKNOWN']) {
      eq(nextStep({ ...MINE, desiredState: st }).action, 'RELEASE', st);
    }
  });

  console.log('[Worker — 재시작은 DB에서 복구한다]');

  test('DB에서 RUNNING job을 다시 찾아 이어받는다', () => {
    const p = recoveryPlan([
      { id: 'a', desiredState: 'RUNNING', leaseOwner: ME, leaseExpiresAtMs: NOW + 10_000 },
      { id: 'b', desiredState: 'RUNNING', leaseOwner: 'other', leaseExpiresAtMs: NOW - 1 },
      { id: 'c', desiredState: 'RUNNING', leaseOwner: 'other', leaseExpiresAtMs: NOW + 10_000 },
      { id: 'd', desiredState: 'STOPPED', leaseOwner: null, leaseExpiresAtMs: null },
    ], ME, NOW);
    assert(p.reclaim.includes('a'), '내 것');
    assert(p.reclaim.includes('b'), '만료된 것');
    assert(p.skip.includes('c'), '남이 살아 있는 것');
    assert(p.skip.includes('d'), '꺼진 것');
  });

  test('로컬 상태로 복구하지 않는다', () => {
    // Fly는 Machine을 다른 호스트로 옮긴다. 디스크가 같이 안 갈 수도
    // 있고, 갔더라도 그 사이 다른 Worker가 일을 진행했을 수 있다.
    eq(recoveryPlan([], ME, NOW).useLocalState, false);
    assert(recoveryPlan([{ id: 'a', desiredState: 'RUNNING' }], ME, NOW).note.includes('로컬 상태는 쓰지 않습니다'),
      '이유가 적혀야 한다');
  });

  test('내 id를 모르면 아무것도 이어받지 않는다', () => {
    eq(recoveryPlan([{ id: 'a', desiredState: 'RUNNING' }], '', NOW).reclaim.length, 0);
  });

  console.log('[Worker — 종료할 때 임대를 놓는다]');

  test('진행 중인 것을 마치고 임대를 놓는다', () => {
    const p = shutdownPlan(2);
    eq(p.acceptNewWork, false);
    eq(p.waitForInflight, true);
    eq(p.releaseLeases, true);
    assert(p.note.includes('UNKNOWN'), p.note);
  });

  test('진행 중인 것이 없으면 바로 놓고 나간다', () => {
    const p = shutdownPlan(0);
    eq(p.waitForInflight, false);
    eq(p.releaseLeases, true);
  });

  test('임대를 놓는 것이 배포 중단 시간을 줄인다', () => {
    // 안 놓으면 다음 Worker가 만료(30초)를 기다려야 하고, 배포할 때마다
    // 30초씩 멈추는 셈이다.
    eq(shutdownPlan(0).releaseLeases, true);
    assert(shutdownPlan(0).graceMs < LEASE_TTL_MS, '유예가 임대 만료보다 짧아야 한다');
  });

  console.log('[Worker — 호스트를 모른다]');

  test('심장박동이 임대 만료보다 넉넉히 짧다', () => {
    // 같으면 네트워크가 한 번 느려질 때마다 멀쩡한 Worker가 쫓겨난다.
    assert(HEARTBEAT_EVERY_MS * 2 <= LEASE_TTL_MS,
      `${HEARTBEAT_EVERY_MS} vs ${LEASE_TTL_MS}`);
  });

  test('호스트가 준 id를 그대로 쓴다', () => {
    eq(workerIdFrom({ FLY_MACHINE_ID: 'fly-1' }), 'fly-1');
    eq(workerIdFrom({ RAILWAY_REPLICA_ID: 'rw-1' }), 'rw-1');
    eq(workerIdFrom({ HOSTNAME: 'host-1' }), 'host-1');
    // Fly가 있으면 Fly가 먼저다.
    eq(workerIdFrom({ FLY_MACHINE_ID: 'fly-1', HOSTNAME: 'h' }), 'fly-1');
  });

  test('id를 못 받으면 지어내지 않는다', () => {
    // id가 없으면 임대를 못 잡고, 그건 아무것도 안 도는 것이라 안전하다.
    eq(workerIdFrom({}), null);
    eq(workerIdFrom(null), null);
    eq(workerIdFrom({ FLY_MACHINE_ID: '   ' }), null);
  });

  test('왜 호스트를 모르게 두는지 적혀 있다', () => {
    assert(HOST_INDEPENDENT_NOTE.includes('처음부터 다시 증명'), HOST_INDEPENDENT_NOTE);
  });
}
