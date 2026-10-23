// src/lib/engine/staleJobRecovery.test.ts
//
// **heartbeat를 못 읽은 것을 "살아 있는 워커 0명"으로 읽지 않는가.**

import { test, eq, assert } from '../../test/harness';
import { staleRecoveryPlan } from './staleJobRecovery';

const STALE_ONE = { data: [{ id: 'job-1', locked_by: 'worker-A', locked_until: '2026-10-23T12:00:00Z' }], error: null };
const BEATS_A_ALIVE = { data: [{ worker_id: 'worker-A', status: 'running', last_seen: '2026-10-23T13:59:00Z' }], error: null };
const BEATS_EMPTY = { data: [], error: null };

export function runStaleJobRecoveryTests() {
  console.log('[stale 회수 — heartbeat를 못 읽은 것은 워커 사망이 아니다]');

  // ── 소유자가 요청한 다섯 가지 ──────────────────────────────────
  test('★ (A) stale 있음 + heartbeat 조회 오류 ⇒ 회수 0건 + 명시 사유', () => {
    const p = staleRecoveryPlan({ stale: STALE_ONE, beats: { data: null, error: { message: '402 Payment Required' } } });
    eq(p.code, 'HEARTBEAT_UNREADABLE', '못 읽은 heartbeat를 "워커 0명"으로 읽었습니다');
    eq(p.recover.length, 0, '살아 있을 수도 있는 워커의 잡을 회수했습니다');
    assert(p.reason.includes('402'), '사유에 원인이 없습니다');
    assert(p.reason.includes('증거'), '왜 멈췄는지가 사유에 없습니다');
  });

  test('★ (B) 정상 heartbeat에 보유 워커가 살아 있음 ⇒ 0건', () => {
    const p = staleRecoveryPlan({ stale: STALE_ONE, beats: BEATS_A_ALIVE });
    eq(p.recover.length, 0, '살아 있는 워커의 잡을 회수했습니다');
    eq(p.skipped.length, 1);
    eq(p.code, 'NONE');
  });

  test('★ (C) 정상 heartbeat 빈 배열 + stale 조건 충족 ⇒ 1건', () => {
    const p = staleRecoveryPlan({ stale: STALE_ONE, beats: BEATS_EMPTY });
    eq(p.code, 'RECOVER', '성공한 빈 배열은 "살아 있는 워커 없음"이 맞습니다');
    eq(p.recover.length, 1);
    eq(p.recover[0].id, 'job-1');
  });

  test('★ (D) stale 목록 조회 오류 ⇒ 0건 + 0건으로 적지 않는다', () => {
    const p = staleRecoveryPlan({ stale: { data: null, error: { message: 'timeout' } }, beats: BEATS_EMPTY });
    eq(p.code, 'STALE_UNREADABLE', '못 읽은 목록을 "0건"으로 읽었습니다');
    eq(p.recover.length, 0);
    assert(p.reason.includes('timeout'), '사유에 원인이 없습니다');
  });

  // (E) 조회 후 locked_until/locked_by 변경 경쟁은 UPDATE 조건(CAS)이
  //     막는다 — 판정이 아니라 배선의 성질이라 검사기가 센다.

  // ── "못 읽음"과 "없음"을 가른다 ─────────────────────────────────
  test('★ heartbeat 응답이 배열이 아니면 "0명"으로 읽지 않는다', () => {
    for (const bad of [{ data: {}, error: null }, { data: 'none', error: null }, { data: null, error: null }]) {
      const p = staleRecoveryPlan({ stale: STALE_ONE, beats: bad as any });
      eq(p.code, 'HEARTBEAT_UNREADABLE', `비배열 응답(${JSON.stringify(bad.data)})을 0명으로 읽었습니다`);
      eq(p.recover.length, 0);
    }
  });

  test('stale 목록이 배열이 아니면 0건으로 읽지 않는다', () => {
    eq(staleRecoveryPlan({ stale: { data: {}, error: null }, beats: BEATS_EMPTY }).code, 'STALE_UNREADABLE');
    eq(staleRecoveryPlan({ stale: null, beats: BEATS_EMPTY }).code, 'STALE_UNREADABLE');
  });

  test('stale이 성공적으로 0건이면 그냥 NONE이다 — 오류가 아니다', () => {
    const p = staleRecoveryPlan({ stale: { data: [], error: null }, beats: BEATS_EMPTY });
    eq(p.code, 'NONE');
    eq(p.recover.length, 0);
  });

  test('★ stale이 0건이면 heartbeat를 못 읽어도 멈출 일이 없다', () => {
    // 되돌릴 후보가 없으면 근거가 필요 없다. 불필요한 경고를 내지 않는다.
    const p = staleRecoveryPlan({ stale: { data: [], error: null }, beats: { data: null, error: 'x' } });
    eq(p.code, 'NONE');
  });

  // ── 살아 있음 판정 ────────────────────────────────────────────
  test("status가 'stopped'인 워커는 살아 있지 않다", () => {
    const p = staleRecoveryPlan({
      stale: STALE_ONE,
      beats: { data: [{ worker_id: 'worker-A', status: 'stopped' }], error: null },
    });
    eq(p.code, 'RECOVER');
    eq(p.recover.length, 1);
  });

  test('다른 워커만 살아 있으면 회수한다', () => {
    const p = staleRecoveryPlan({
      stale: STALE_ONE,
      beats: { data: [{ worker_id: 'worker-B', status: 'running' }], error: null },
    });
    eq(p.code, 'RECOVER');
    eq(p.recover.length, 1);
  });

  test('locked_by가 비어 있으면 임자가 없으니 회수 대상이다', () => {
    const p = staleRecoveryPlan({
      stale: { data: [{ id: 'j', locked_by: null }], error: null }, beats: BEATS_A_ALIVE,
    });
    eq(p.code, 'RECOVER');
    eq(p.recover.length, 1);
  });

  test('여러 건이 섞이면 산 것만 남기고 나머지를 회수한다', () => {
    const p = staleRecoveryPlan({
      stale: { data: [
        { id: 'a', locked_by: 'worker-A' },
        { id: 'b', locked_by: 'worker-B' },
        { id: 'c', locked_by: null },
      ], error: null },
      beats: BEATS_A_ALIVE,
    });
    eq(p.recover.map((j: any) => j.id).join(','), 'b,c');
    eq(p.skipped.map((j: any) => j.id).join(','), 'a');
  });

  test('★ 회수가 비어 있지 않은 경우는 RECOVER 하나뿐이다', () => {
    const all = [
      staleRecoveryPlan({ stale: STALE_ONE, beats: BEATS_EMPTY }),
      staleRecoveryPlan({ stale: STALE_ONE, beats: BEATS_A_ALIVE }),
      staleRecoveryPlan({ stale: STALE_ONE, beats: { data: null, error: 'x' } }),
      staleRecoveryPlan({ stale: { data: null, error: 'x' }, beats: BEATS_EMPTY }),
    ];
    eq(all.filter((p) => p.recover.length > 0).length, 1);
    eq(all.filter((p) => p.recover.length > 0)[0].code, 'RECOVER');
  });

  test('모든 판정에 사유가 있다 — 조용히 멈추지 않는다', () => {
    for (const p of [
      staleRecoveryPlan({ stale: STALE_ONE, beats: BEATS_EMPTY }),
      staleRecoveryPlan({ stale: STALE_ONE, beats: { data: null, error: 'x' } }),
      staleRecoveryPlan({ stale: null, beats: null }),
    ]) assert(p.reason.trim().length > 0, `사유가 비었습니다: ${p.code}`);
  });
}
