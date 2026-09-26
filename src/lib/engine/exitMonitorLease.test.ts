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
  acquireExitLease,
} from './exitMonitorLease';

/**
 * 한 줄짜리 임차 표를 흉내내는 가짜 저장소.
 *
 * `cas: false`로 만들면 **main의 예전 구현**이 된다 — 본 값을 조건으로
 * 걸지 않고 그냥 upsert한다. 경합을 말로 설명하는 대신 그 구현을 그대로
 * 돌려 본다.
 */
function store(o: { row?: any; cas?: boolean; missingTable?: boolean; readThrows?: boolean } = {}) {
  let row: any = o.row ?? null;
  const log: string[] = [];
  return {
    log, current: () => row,
    api: {
      read: async () => {
        log.push('read');
        if (o.readThrows) throw new Error('DB 끊김');
        if (o.missingTable) return { missingTable: true };
        return { row: row == null ? null : { ...row } };
      },
      insert: async (r: any) => {
        log.push('insert');
        if (row != null) return { ok: false, error: 'duplicate key' };
        row = { holder: r.holder, fence: r.fence, expiresAtMs: r.expiresAtMs };
        return { ok: true, error: null };
      },
      compareAndSet: async (r: any, prevFence: number) => {
        log.push(`cas(${prevFence})`);
        // ★ 조건을 안 거는 예전 구현 (upsert)
        if (o.cas === false) {
          row = { holder: r.holder, fence: r.fence, expiresAtMs: r.expiresAtMs };
          return { updated: 1, error: null };
        }
        if (row == null || Number(row.fence) !== Number(prevFence)) return { updated: 0, error: null };
        row = { holder: r.holder, fence: r.fence, expiresAtMs: r.expiresAtMs };
        return { updated: 1, error: null };
      },
    },
  };
}

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

  // ══ 획득 경합 — 두 실행을 실제로 겹쳐서 돌린다 ══
  //
  // main의 구현은 읽고-판정하고-**조건 없이** upsert했다. 두 요청이 같은
  // 줄을 읽으면 같은 다음 번호를 계산하고, 둘 다 쓰기에 성공한다. 그러면
  // 뒤의 `fenceStillMine()`도 둘 다 통과한다 — **같은 포지션에 손절 이동·
  // 청산이 두 번** 나갈 수 있다. 그래서 경합을 코드로 재현한다.

  test('★ ① 조건 없이 쓰면 동시 요청 둘이 **둘 다 주인**이 된다 (main의 결함 재현)', async () => {
    const st = store({ row: { holder: 'w-old', fence: 7, expiresAtMs: NOW - 1 }, cas: false });
    const [a, b] = await Promise.all([
      acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW }),
      acquireExitLease({ store: st.api as any, me: 'w2', nowMs: NOW }),
    ]);
    eq(a.granted, true); eq(b.granted, true);
    eq(a.myFence, 8); eq(b.myFence, 8);
    assert(a.myFence === b.myFence, '경합이 재현되지 않았습니다');
  });

  test('★ ① 본 값을 조건으로 걸면 A만 성공하고 B는 RACE_LOST', async () => {
    const st = store({ row: { holder: 'w-old', fence: 7, expiresAtMs: NOW - 1 } });
    const [a, b] = await Promise.all([
      acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW }),
      acquireExitLease({ store: st.api as any, me: 'w2', nowMs: NOW }),
    ]);
    const won = [a, b].filter(x => x.granted);
    eq(won.length, 1, `★ ${won.length}개가 임차를 잡았습니다`);
    const lost = [a, b].find(x => !x.granted)!;
    eq(lost.code, 'RACE_LOST');
    eq(lost.granted, false, '★ 권한 없이 거래소를 바꿀 수 있습니다');
    eq(lost.myFence, null, '못 잡았으면 울타리 번호를 갖지 않는다');
    eq(Number(st.current().fence), 8, '표에는 하나만 남는다');
  });

  test('★ 빈 표에 동시에 둘이 들어가도 하나만 만든다', async () => {
    const st = store({ row: null });
    const [a, b] = await Promise.all([
      acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW }),
      acquireExitLease({ store: st.api as any, me: 'w2', nowMs: NOW }),
    ]);
    eq([a, b].filter(x => x.granted).length, 1, '★ 둘 다 임차를 만들었습니다');
  });

  test('★ ② 남이 쥐고 있고 만료 전이면 쓰기까지 가지 않는다 (WRITE 0)', async () => {
    const st = store({ row: { holder: 'w-other', fence: 3, expiresAtMs: NOW + 60_000 } });
    const r = await acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW });
    eq(r.code, 'SKIP'); eq(r.granted, false);
    assert(!st.log.some(l => l.startsWith('cas') || l === 'insert'),
      `★ 남의 임차 위에 썼습니다: ${st.log.join(',')}`);
  });

  test('★ ③ 만료된 임차는 새 fence로 한 번 가져온다', async () => {
    const st = store({ row: { holder: 'w-old', fence: 4, expiresAtMs: NOW - 1 } });
    const r = await acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW, ttlMs: LEASE_TTL_MS });
    eq(r.code, 'ACQUIRED', '가져왔으면 ACQUIRED다');
    eq(r.granted, true);
    eq(r.myFence, 5, '번호를 올려야 옛 실행이 통과하지 못한다');
    eq(Number(st.current().expiresAtMs), NOW + LEASE_TTL_MS);
    eq(st.log.filter(l => l.startsWith('cas')).length, 1, '한 번만 쓴다');
  });

  test('★ ④ 임차 상태를 못 읽으면 실행하지 않는다 (fail-closed)', async () => {
    const st = store({ readThrows: true });
    const r = await acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW });
    eq(r.granted, false);
    eq(r.code, 'SKIP');
    assert(!st.log.some(l => l.startsWith('cas') || l === 'insert'),
      '★ 못 읽고 썼습니다 — 빈 표로 취급하면 안 됩니다');
  });

  test('임차 표가 없는 배포에서는 임차 없이 돈다 — 기존 안전 의미 유지', async () => {
    const st = store({ missingTable: true });
    const r = await acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW });
    eq(r.code, 'UNTRACKED');
    eq(r.granted, true);
    eq(r.tracked, false);
    eq(r.myFence, null, '확인할 울타리가 없다');
  });

  test('내가 쥐고 있던 임차를 갱신할 때도 번호를 올린다', async () => {
    const st = store({ row: { holder: 'w1', fence: 4, expiresAtMs: NOW + 60_000 } });
    const r = await acquireExitLease({ store: st.api as any, me: 'w1', nowMs: NOW });
    eq(r.granted, true);
    eq(r.myFence, 5, '뒤늦게 깨어난 내 옛 실행이 통과하면 안 된다');
    eq(fenceStillMine({ myFence: 4, currentFence: 5 }).ok, false);
  });
}
