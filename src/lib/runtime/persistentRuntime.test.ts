// src/lib/runtime/persistentRuntime.test.ts
//
// 막으려는 것:
//  1. **enabled=true를 '실행 중'이라고 적는 것.** Worker가 죽어 있으면
//     그건 '설정이 켜져 있다'일 뿐이고, 사용자는 자동매매가 자기 돈을
//     지키고 있다고 믿는다
//  2. 못 읽은 상태를 '정지'로 읽는 것. 그 순간 [시작]을 누르면 두 번
//     시작하는 셈이 된다
//  3. 두 Worker가 같은 실행기를 잡아 같은 주문을 두 번 내는 것
//  4. 벽시계로 tick 열쇠를 만들어 재시도가 중복을 뚫는 것
//  5. 브라우저 타이머를 '상시 실행'이라고 부르는 것
import { test, assert, eq } from '../../test/harness';
import {
  runtimeHealth, leaseCheck, tickKey, canCallAlwaysOn,
  HEARTBEAT_STALE_MS, TICK_LATE_FACTOR, DURABILITY_NOTE,
} from './persistentRuntime';

const NOW = 1_700_000_000_000;
const iso = (t: number) => new Date(t).toISOString();

export function runPersistentRuntimeTests() {
  console.log('[상시 실행 — enabled는 running이 아니다]');

  test('셋이 다 맞아야 실행 중이다', () => {
    const h = runtimeHealth({
      enabled: true, intervalSec: 10,
      workerHeartbeatAt: iso(NOW - 2000),
      lastTickAt: iso(NOW - 5000),
    }, NOW);
    eq(h.status, 'RUNNING');
    eq(h.actuallyRunning, true);
    eq(h.heartbeatAgeMs, 2000);
    eq(h.tickAgeMs, 5000);
    eq(h.nextTickInMs, 5000);
  });

  test('Worker가 죽었으면 실행 중이라고 안 한다', () => {
    // DB에 enabled=true라고 실제로 돌고 있다고 거짓말하면 안 된다.
    const h = runtimeHealth({
      enabled: true, intervalSec: 10,
      workerHeartbeatAt: iso(NOW - HEARTBEAT_STALE_MS - 1),
      lastTickAt: iso(NOW - 1000),
    }, NOW);
    eq(h.status, 'DEGRADED');
    eq(h.actuallyRunning, false);
    assert(h.reason.includes('보장되지 않습니다'), h.reason);
    assert(h.label.includes('실행 설정 ON'), h.label);
  });

  test('심장박동을 아예 못 읽어도 실행 중이 아니다', () => {
    const h = runtimeHealth({ enabled: true, intervalSec: 10, lastTickAt: iso(NOW - 1000) }, NOW);
    eq(h.status, 'DEGRADED');
    assert(h.reason.includes('알 수 없습니다'), h.reason);
  });

  test('심장박동은 있는데 한참 안 돌았으면 STALE이다', () => {
    const h = runtimeHealth({
      enabled: true, intervalSec: 10,
      workerHeartbeatAt: iso(NOW - 1000),
      lastTickAt: iso(NOW - 10_000 * TICK_LATE_FACTOR - 1),
    }, NOW);
    eq(h.status, 'STALE');
    eq(h.actuallyRunning, false);
  });

  test('한 번도 안 돌았으면 실행 중이 아니다', () => {
    const h = runtimeHealth({ enabled: true, intervalSec: 10, workerHeartbeatAt: iso(NOW) }, NOW);
    eq(h.status, 'DEGRADED');
    assert(h.reason.includes('한 번도'), h.reason);
  });

  test('마지막 실행에서 오류가 났으면 그대로 적는다', () => {
    const h = runtimeHealth({
      enabled: true, intervalSec: 10,
      workerHeartbeatAt: iso(NOW - 1000), lastTickAt: iso(NOW - 1000),
      lastError: '시세 조회 실패',
    }, NOW);
    eq(h.status, 'DEGRADED');
    assert(h.reason.includes('시세 조회 실패'), h.reason);
  });

  console.log('[상시 실행 — 못 읽은 것과 정지는 다르다]');

  test('행을 못 읽으면 UNKNOWN이지 STOPPED가 아니다', () => {
    // false로 시작하면 서버 응답 전까지 '정지'가 보이고, 그 순간
    // [시작]을 누르면 두 번 시작하는 셈이 된다.
    const h = runtimeHealth(null, NOW);
    eq(h.status, 'UNKNOWN');
    eq(h.actuallyRunning, false);
    eq(h.label, '상태 확인 중…');
  });

  test('현재 시각을 모르면 판정하지 않는다', () => {
    eq(runtimeHealth({ enabled: true }, null).status, 'UNKNOWN');
  });

  test('꺼져 있으면 정지다', () => {
    eq(runtimeHealth({ enabled: false }, NOW).status, 'STOPPED');
  });

  test('차단이 오류보다 먼저다', () => {
    const h = runtimeHealth({ enabled: true, blockedReason: '미확정 주문 10건', lastError: 'x' }, NOW);
    eq(h.status, 'BLOCKED');
    eq(h.reason, '미확정 주문 10건');
  });

  test('전환 중 상태는 그대로 존중한다', () => {
    eq(runtimeHealth({ status: 'STARTING', enabled: true }, NOW).status, 'STARTING');
    eq(runtimeHealth({ status: 'STOPPING', enabled: true }, NOW).status, 'STOPPING');
  });

  test('일시정지는 정지와 구분한다', () => {
    eq(runtimeHealth({ status: 'PAUSED', enabled: true }, NOW).status, 'PAUSED');
  });

  console.log('[상시 실행 — 두 Worker가 겹치면 안 된다]');

  test('주인이 없으면 잡는다', () => {
    eq(leaseCheck({}, 'w1', NOW).verdict, 'ACQUIRE');
  });

  test('내가 주인이면 갱신이다', () => {
    eq(leaseCheck({ ownerWorkerId: 'w1', leaseExpiresAt: iso(NOW + 5000) }, 'w1', NOW).verdict, 'RENEW');
  });

  test('남이 잡고 있으면 막는다', () => {
    const v = leaseCheck({ ownerWorkerId: 'w2', leaseExpiresAt: iso(NOW + 5000) }, 'w1', NOW);
    eq(v.verdict, 'BLOCKED');
    assert(v.reason.includes('w2'), v.reason);
  });

  test('임대가 만료됐으면 이어받는다', () => {
    eq(leaseCheck({ ownerWorkerId: 'w2', leaseExpiresAt: iso(NOW - 1) }, 'w1', NOW).verdict, 'ACQUIRE');
  });

  test('만료 시각을 모르면 잡지 않는다', () => {
    // 겹쳐 돌면 같은 주문이 두 번 나간다 — 겹치는 쪽의 대가가 훨씬 크다.
    const v = leaseCheck({ ownerWorkerId: 'w2' }, 'w1', NOW);
    eq(v.verdict, 'BLOCKED');
    assert(v.reason.includes('두 번 나갑니다'), v.reason);
  });

  test('Worker id가 없으면 판정하지 않는다', () => {
    eq(leaseCheck({}, '', NOW).verdict, 'UNKNOWN');
    eq(leaseCheck({}, 'w1', null).verdict, 'UNKNOWN');
  });

  console.log('[상시 실행 — 같은 tick을 두 번 돌리지 않는다]');

  test('같은 주기 안의 재시도는 같은 열쇠다', () => {
    // 벽시계로 만들면 재시도가 새 열쇠를 만들어 중복을 못 막는다.
    const a = tickKey('rt1', NOW, 10);
    const b = tickKey('rt1', NOW + 3000, 10);
    eq(a, b, '같은 10초 슬롯이면 같은 열쇠여야 한다');
  });

  test('다음 주기는 다른 열쇠다', () => {
    assert(tickKey('rt1', NOW, 10) !== tickKey('rt1', NOW + 10_000, 10));
  });

  test('다른 실행기는 다른 열쇠다', () => {
    assert(tickKey('rt1', NOW, 10) !== tickKey('rt2', NOW, 10));
  });

  test('값이 모자라면 열쇠를 만들지 않는다', () => {
    eq(tickKey('', NOW, 10), null);
    eq(tickKey('rt1', null, 10), null);
    eq(tickKey('rt1', NOW, 0), null);
  });

  console.log('[상시 실행 — 브라우저 타이머를 상시 실행이라고 부르지 않는다]');

  test('서버 실행만 상시 실행이다', () => {
    eq(canCallAlwaysOn('SERVER'), true);
    eq(canCallAlwaysOn('BROWSER'), false);
    eq(canCallAlwaysOn('UNKNOWN'), false, '확인 못 한 것은 통과가 아니다');
  });

  test('브라우저 실행은 그 사실을 적는다', () => {
    assert(DURABILITY_NOTE.BROWSER.includes('상시 실행이 아닙니다'), DURABILITY_NOTE.BROWSER);
    assert(DURABILITY_NOTE.BROWSER.includes('멈춥니다'), DURABILITY_NOTE.BROWSER);
  });
}
