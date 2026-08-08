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
  fenceCheck, nextFencingToken, orderKey, shouldSubmit, gapCheck,
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

  console.log('[상시 실행 — F. 늦게 깨어난 Worker는 주문 못 낸다]');

  test('임대가 넘어간 뒤 늦게 깨어난 Worker를 막는다', () => {
    // 10:00 A가 잡음(7) → A 멈춤 → 10:01 만료, B가 잡음(8)
    // → 10:02 A가 깨어남. A는 자기가 주인인 줄 안다.
    // leaseCheck는 이걸 못 막는다 — A는 이미 통과한 뒤에 멈췄다.
    const v = fenceCheck(7, 8);
    eq(v.ok, false);
    eq(v.code, 'STALE');
    assert(v.reason.includes('두 번 나갑니다'), v.reason);
  });

  test('번호가 같으면 아직 주인이다', () => {
    const v = fenceCheck(8, 8);
    eq(v.ok, true);
    eq(v.code, 'CURRENT');
  });

  test('번호를 못 읽으면 진행하지 않는다', () => {
    // 모르는 채로 주문을 내면 겹쳤을 때 되돌릴 방법이 없다.
    eq(fenceCheck(null, 8).code, 'UNKNOWN');
    eq(fenceCheck(7, null).code, 'UNKNOWN');
    eq(fenceCheck('abc', 8).code, 'UNKNOWN');
    eq(fenceCheck(1.5, 8).code, 'UNKNOWN');
  });

  test('내 번호가 더 크면 있을 수 없는 상태다 — 역시 막는다', () => {
    const v = fenceCheck(9, 8);
    eq(v.ok, false);
    eq(v.code, 'UNKNOWN');
  });

  test('임대를 새로 잡을 때마다 번호가 오른다', () => {
    eq(nextFencingToken(7), 8);
    eq(nextFencingToken(0), 1);
    eq(nextFencingToken(null), 1, '없으면 1부터');
    eq(nextFencingToken('abc'), 1);
  });

  console.log('[상시 실행 — G. tick 중복과 주문 중복은 다른 문제다]');

  test('같은 tick 안의 두 주문은 다른 열쇠다', () => {
    // tickKey 하나로 합치면 두 번째 주문이 첫 번째와 같은 열쇠를 갖는다.
    const k = tickKey('rt1', NOW, 10)!;
    assert(orderKey(k, 0) !== orderKey(k, 1), '같은 tick의 두 주문이 같은 열쇠다');
  });

  test('같은 주문의 재시도는 같은 열쇠다', () => {
    // tick은 한 번 돌았는데 네트워크 타임아웃으로 제출이 두 번 나가는 사고.
    const k = tickKey('rt1', NOW, 10)!;
    eq(orderKey(k, 0), orderKey(k, 0));
  });

  test('열 번 재시도해도 한 번만 보낸다', () => {
    const k = tickKey('rt1', NOW, 10)!;
    const key = orderKey(k, 0)!;
    const sent: string[] = [];
    let submitted = 0;
    for (let i = 0; i < 10; i++) {
      if (shouldSubmit(key, sent).ok) { submitted++; sent.push(key); }
    }
    eq(submitted, 1);
  });

  test('보낸 목록을 못 읽으면 보내지 않는다', () => {
    // 이미 나간 주문 위에 하나를 더 얹는 쪽이 훨씬 나쁘다.
    const v = shouldSubmit('k#0', null);
    eq(v.ok, false);
    assert(v.reason.includes('모르는 채로'), v.reason);
  });

  test('열쇠를 못 만들면 보내지 않는다', () => {
    eq(orderKey(null, 0), null);
    eq(orderKey('k', -1), null);
    eq(orderKey('k', 1.5), null);
    eq(shouldSubmit(null, []).ok, false);
  });

  console.log('[상시 실행 — 멈춘 동안을 지어내지 않는다]');

  test('3분 죽어 있었다고 18번을 따라잡지 않는다', () => {
    // 그건 일어나지 않은 거래 18건을 만드는 것이다.
    const g = gapCheck({ lastTickAtMs: NOW - 180_000, nowMs: NOW, intervalSec: 10 });
    eq(g.hasGap, true);
    eq(g.missedTicks, 17);
    eq(g.shouldCatchUp, false);
    assert(g.reason.includes('없던 거래를 만듭니다'), g.reason);
  });

  test('제때 돌았으면 빈 구간이 없다', () => {
    const g = gapCheck({ lastTickAtMs: NOW - 10_000, nowMs: NOW, intervalSec: 10 });
    eq(g.hasGap, false);
    eq(g.missedTicks, 0);
  });

  test('주기를 모르면 빈 구간을 계산하지 않는다', () => {
    const g = gapCheck({ lastTickAtMs: NOW - 180_000, nowMs: NOW });
    eq(g.missedTicks, null);
    eq(g.hasGap, false);
    eq(g.shouldCatchUp, false);
  });

  test('따라잡기는 어떤 경우에도 하지 않는다', () => {
    for (const ms of [0, 10_000, 180_000, 86_400_000]) {
      eq(gapCheck({ lastTickAtMs: NOW - ms, nowMs: NOW, intervalSec: 10 }).shouldCatchUp, false, String(ms));
    }
  });
}
