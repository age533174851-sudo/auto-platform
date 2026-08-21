// src/lib/engine/exitMonitorLease.test.ts
//
// **한 번 옮긴 손절을 또 옮기지 않는다.**
//
// 워커가 재시작하거나 두 대가 동시에 뜨면 같은 순간에 청산 감시를 두 번
// 깨울 수 있다. 임차는 그걸 막고, 울타리 번호는 **느린 실행이 뒤늦게
// 깨어나 자기가 아직 주인인 줄 아는 것**을 막는다.

import { test, eq, assert } from '../../test/harness';
import {
  leaseDecision, fenceStillMine, exitMonitorOverdue, LEASE_TTL_MS, OVERDUE_BLOCK_MS,
} from './exitMonitorLease';

const NOW = 1_800_000_000_000;

export function runExitMonitorLeaseTests() {
  console.log('[청산 감시 임차 — 두 번 돌지 않는다]');

  test('임차가 비어 있으면 가져온다', () => {
    const d = leaseDecision({ current: null, me: 'w1', nowMs: NOW });
    eq(d.code, 'ACQUIRED');
    eq(d.granted, true);
    eq(d.nextFence, 1);
  });

  test('**두 워커가 동시에 떠도 하나만 가져간다**', () => {
    const held = { holder: 'w1', fence: 5, expiresAtMs: NOW + LEASE_TTL_MS };
    const d = leaseDecision({ current: held, me: 'w2', nowMs: NOW });
    eq(d.code, 'HELD_BY_OTHER');
    eq(d.granted, false);
    // **기다리지 않는다.** 그쪽이 하면 되는 일이다.
    assert(/건너뜁니다/.test(d.reason), d.reason);
  });

  test('만료된 임차는 가져오고 번호를 올린다', () => {
    const d = leaseDecision({
      current: { holder: 'w1', fence: 5, expiresAtMs: NOW - 1 }, me: 'w2', nowMs: NOW });
    eq(d.code, 'TAKEN_OVER');
    eq(d.nextFence, 6);
  });

  test('**워커가 재시작해도 중복 실행되지 않는다** — 자기 임차는 갱신하고 번호를 올린다', () => {
    // 재시작한 워커가 같은 id로 돌아왔다. 예전 실행이 뒤늦게 깨어나도
    // 번호가 올라가 있어 자기가 낡았다는 걸 안다.
    const d = leaseDecision({
      current: { holder: 'w1', fence: 7, expiresAtMs: NOW + 1000 }, me: 'w1', nowMs: NOW });
    eq(d.granted, true);
    eq(d.nextFence, 8);
  });

  test('임차를 읽지 못하면 가져가지 않는다', () => {
    // **빈 표와 못 읽은 표는 다르다.** 못 읽은 것을 빈 것으로 보면
    // 남이 도는 중에 같이 돈다.
    const d = leaseDecision({ current: undefined, me: 'w1', nowMs: NOW });
    eq(d.code, 'UNKNOWN');
    eq(d.granted, false);
  });

  // ── 울타리 ──

  test('내 울타리가 최신이면 주문을 낸다', () => {
    eq(fenceStillMine({ myFence: 8, currentFence: 8 }).ok, true);
  });

  test('**느린 실행이 뒤늦게 깨어나면 아무것도 하지 않는다**', () => {
    // 거래소 응답이 90초 걸리는 사이 임차가 넘어갔다.
    const r = fenceStillMine({ myFence: 8, currentFence: 9 });
    eq(r.ok, false);
    assert(/낡았습니다/.test(r.reason), r.reason);
  });

  test('울타리를 다시 읽지 못하면 통과가 아니다', () => {
    eq(fenceStillMine({ myFence: 8, currentFence: undefined }).ok, false);
    eq(fenceStillMine({ myFence: 8, currentFence: null }).ok, false);
    eq(fenceStillMine({ myFence: null, currentFence: 8 }).ok, false);
  });

  // ── 밀림 ──

  const IV = 5 * 60_000;

  test('제때 돌고 있으면 정상이다', () => {
    const v = exitMonitorOverdue({ lastSuccessMs: NOW - 60_000, nowMs: NOW, intervalMs: IV });
    eq(v.code, 'OK');
    eq(v.blockEntry, false);
  });

  test('간격 두 배를 넘기면 밀린 것으로 본다 — 다만 바로 막지는 않는다', () => {
    const v = exitMonitorOverdue({ lastSuccessMs: NOW - 3 * IV, nowMs: NOW, intervalMs: IV });
    eq(v.code, 'OVERDUE');
    eq(v.overdue, true);
    // 배포 한 번에 하루가 멈추면 안 된다.
    eq(v.blockEntry, false);
  });

  test('**30분을 넘기면 새 진입을 막는다** — 못 닫는 것은 사고다', () => {
    const v = exitMonitorOverdue({ lastSuccessMs: NOW - OVERDUE_BLOCK_MS - 1000, nowMs: NOW, intervalMs: IV });
    eq(v.blockEntry, true);
    assert(/새 포지션을 열지 않습니다/.test(v.reason), v.reason);
  });

  test('기록을 못 읽은 것을 "안 돌았다"로 적지 않는다', () => {
    const v = exitMonitorOverdue({ lastSuccessMs: undefined, nowMs: NOW, intervalMs: IV });
    eq(v.code, 'UNKNOWN');
    eq(v.blockEntry, false);
  });

  test('**첫 배포 직후(기록 없음)에 매매를 멈추지 않는다**', () => {
    // 058이 막 적용된 직후가 이 상태다. 이 기능을 배포한 순간
    // 자동매매가 꺼지면 안 된다.
    const v = exitMonitorOverdue({ lastSuccessMs: null, nowMs: NOW, intervalMs: IV });
    eq(v.code, 'NEVER_RAN');
    eq(v.blockEntry, false);
  });
}
