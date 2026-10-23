// src/lib/supabase/jobClaimWindow.test.ts
//
// **backoff 중인 잡 10개가 11번째 긴급 잡을 가리지 않는가.**

import { test, eq, assert } from '../../test/harness';
import { claimableFilter, isJobClaimable, selectClaimable } from './jobClaimWindow';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const LIMIT = 10;   // 워커 조회의 `.limit(10)`과 같은 수

/** 우선순위 0짜리 오래된 PENDING 잡 10개가 전부 60초 backoff 중 */
function tenBackedOff() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `old-${i}`, action: 'PLACE_ORDER', priority: 0,
    created_at: iso(NOW - 3_600_000 + i * 1000),
    locked_until: iso(NOW + 60_000),
  }));
}
/** 그 뒤에 들어온 같은 우선순위의 킬스위치 잡 */
const KILL = {
  id: 'kill-1', action: 'KILL_SWITCH_EXECUTE', priority: 0,
  created_at: iso(NOW - 1000), locked_until: null,
};

export function runJobClaimWindowTests() {
  console.log('[잡 선택 창 — backoff가 긴급 잡을 가리지 않는다]');

  // ── 소유자가 요청한 재현 ─────────────────────────────────────
  test('★ backoff 10개 + 11번째 킬스위치 ⇒ 킬스위치가 선택된다', () => {
    const rows = [...tenBackedOff(), KILL];
    const picked = selectClaimable(rows, NOW, LIMIT);
    eq(picked.length, 1, '집을 수 있는 잡은 킬스위치 하나뿐입니다');
    eq(picked[0].id, 'kill-1', '긴급 잡이 backoff 10개에 가려졌습니다');
  });

  test('★ 자르고 나서 거르면 0개가 된다 — 이것이 막으려는 순서다', () => {
    const rows = [...tenBackedOff(), KILL];
    // 예전 순서: sort → limit(10) → 메모리에서 skip
    const sorted = [...rows].sort((a, b) =>
      (a.priority - b.priority) || String(a.created_at).localeCompare(String(b.created_at)));
    const afterLimit = sorted.slice(0, LIMIT).filter((r) => isJobClaimable(r, NOW));
    eq(afterLimit.length, 0, '재현에 실패했습니다 — 이 시험이 지키려는 결함이 아닙니다');
    // 그리고 그 10개 안에 킬스위치는 없다
    assert(!sorted.slice(0, LIMIT).some((r) => r.id === 'kill-1'),
      '킬스위치가 앞 10개에 들어와 재현이 성립하지 않습니다');
  });

  test('★ 재시작해도 backoff가 유지된다 — 메모리가 아니라 행에 있다', () => {
    // 재시작 = 프로세스 상태 없음. 입력은 DB 행뿐이다.
    const rows = tenBackedOff();
    eq(selectClaimable(rows, NOW, LIMIT).length, 0, '재시작 후 backoff 잡을 즉시 다시 집었습니다');
    // 시간이 지나면 다시 집힌다
    eq(selectClaimable(rows, NOW + 61_000, LIMIT).length, 10);
  });

  test('★ 다른 워커 인스턴스도 같은 판단을 한다 (입력이 행뿐이다)', () => {
    const rows = [...tenBackedOff(), KILL];
    const a = selectClaimable(rows, NOW, LIMIT).map((r) => r.id);
    const b = selectClaimable(rows, NOW, LIMIT).map((r) => r.id);
    eq(a.join(','), b.join(','), '인스턴스마다 다른 잡을 집습니다');
  });

  // ── 우선순위·FIFO 계약은 그대로다 ────────────────────────────
  test('우선순위가 낮은 숫자가 먼저다', () => {
    const rows = [
      { id: 'p5', priority: 5, created_at: iso(NOW - 9_000_000), locked_until: null },
      { id: 'p0', priority: 0, created_at: iso(NOW - 1000), locked_until: null },
      { id: 'p1', priority: 1, created_at: iso(NOW - 5_000_000), locked_until: null },
    ];
    eq(selectClaimable(rows, NOW, LIMIT).map((r) => r.id).join(','), 'p0,p1,p5');
  });

  test('같은 우선순위면 먼저 만들어진 것이 먼저다 (FIFO)', () => {
    const rows = [
      { id: 'b', priority: 0, created_at: iso(NOW - 1000), locked_until: null },
      { id: 'a', priority: 0, created_at: iso(NOW - 9000), locked_until: null },
    ];
    eq(selectClaimable(rows, NOW, LIMIT).map((r) => r.id).join(','), 'a,b');
  });

  test('backoff가 우선순위를 뒤집지 않는다 — 걸러질 뿐 순서는 그대로다', () => {
    const rows = [
      { id: 'p0-wait', priority: 0, created_at: iso(NOW - 9000), locked_until: iso(NOW + 60_000) },
      { id: 'p1-ready', priority: 1, created_at: iso(NOW - 8000), locked_until: null },
      { id: 'p0-ready', priority: 0, created_at: iso(NOW - 7000), locked_until: null },
    ];
    eq(selectClaimable(rows, NOW, LIMIT).map((r) => r.id).join(','), 'p0-ready,p1-ready');
  });

  test('빈 큐는 그냥 0개다 — 오류가 아니다', () => {
    eq(selectClaimable([], NOW, LIMIT).length, 0);
    eq(selectClaimable(null as any, NOW, LIMIT).length, 0);
  });

  test('10개를 넘으면 10개까지만 — 상한은 유지된다', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `r${i}`, priority: 0, created_at: iso(NOW - 100_000 + i), locked_until: null,
    }));
    eq(selectClaimable(rows, NOW, LIMIT).length, 10);
  });

  // ── 한 건 판정 ────────────────────────────────────────────────
  test('locked_until이 없으면 집는다', () => {
    eq(isJobClaimable({ locked_until: null }, NOW), true);
    eq(isJobClaimable({ locked_until: '' }, NOW), true);
    eq(isJobClaimable({}, NOW), true);
  });

  test('지난 시각이면 집는다, 미래면 안 집는다', () => {
    eq(isJobClaimable({ locked_until: iso(NOW - 1) }, NOW), true);
    eq(isJobClaimable({ locked_until: iso(NOW) }, NOW), true);
    eq(isJobClaimable({ locked_until: iso(NOW + 1) }, NOW), false);
  });

  test('★ 시각을 못 읽으면 집지 않는다 — 모르는 값을 "지났다"로 읽지 않는다', () => {
    eq(isJobClaimable({ locked_until: 'soon' }, NOW), false);
    eq(isJobClaimable({ locked_until: {} }, NOW), false);
    eq(isJobClaimable(null, NOW), false);
  });

  // ── 조회에 거는 조건 ──────────────────────────────────────────
  test('조건 문자열이 null과 지난 시각을 모두 포함한다', () => {
    const f = claimableFilter('2026-10-23T12:00:00.000Z');
    assert(f.includes('locked_until.is.null'), 'null 행이 빠집니다 — 평범한 잡이 전부 안 집힙니다');
    assert(f.includes('locked_until.lte.2026-10-23T12:00:00.000Z'), '지난 시각 조건이 없습니다');
  });

  test('조건에 쉼표가 더 끼지 않는다 (PostgREST가 항목을 쉼표로 가른다)', () => {
    eq(claimableFilter('2026-10-23T12:00:00.000Z').split(',').length, 2);
  });
}
