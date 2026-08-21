// src/lib/ledger/coverageSet.test.ts
//
// **이 테스트가 막는 것: 없는 행이 검사를 통과하는 것.**
//
// 지갑의 "오늘 매매손익" 완전성 판정이 이랬다:
//
//   complete = ledger_ingest_state에서 읽은 행.every(오늘을 덮는가)
//
// 연결이 셋인데 상태 행이 하나뿐이면, 그 하나가 오늘을 덮는 순간
// `every()`는 참이다. **한 번도 수집된 적 없는 두 연결은 검사에
// 등장조차 하지 않는다.** 그 연결의 수수료·펀딩이 빠진 매매손익이
// 숫자로 확정되고, 빠진 비용은 전부 수익으로 보인다.
import { test, eq, assert } from '../../test/harness';
import { ledgerCompleteness } from './coverageSet';

const DAY = Date.parse('2026-08-21T00:00:00.000Z');
const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const covering = (id: string) => ({ connectionId: id, fromMs: DAY - 86_400_000, toMs: NOW });

export function runCoverageSetTests() {
  console.log('[장부 완전성 — 있는 행만 보면 없는 행은 영원히 통과한다]');

  test('상태 행이 없는 활성 연결이 있으면 완전하지 않다', () => {
    // 예전 `every()` 판정이 정확히 여기서 참을 돌려줬다.
    const v = ledgerCompleteness({
      expected: ['c1', 'c2', 'c3'],
      states: [covering('c1')],
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.complete, false);
    eq(v.code, 'MISSING_CONNECTIONS');
    eq(v.missing.join(','), 'c2,c3');
    assert(v.reason.includes('전부 수익으로 보입니다'), v.reason);
  });

  test('모든 활성 연결이 구간을 덮으면 완전하다', () => {
    const v = ledgerCompleteness({
      expected: ['c1', 'c2'],
      states: [covering('c1'), covering('c2')],
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.complete, true); eq(v.code, 'COMPLETE');
  });

  test('행은 있는데 구간을 못 덮으면 완전하지 않다', () => {
    const v = ledgerCompleteness({
      expected: ['c1'],
      states: [{ connectionId: 'c1', fromMs: DAY - 1000, toMs: NOW - 3 * 3600_000 }],
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.complete, false); eq(v.code, 'PARTIAL_PERIOD');
    eq(v.partial.join(','), 'c1');
  });

  test('연결 목록을 못 읽었으면 완전하다고 말하지 않는다', () => {
    // **빈 목록과 못 읽은 것은 다르다.** 못 읽은 것을 빈 목록으로
    // 읽으면 대조할 것이 없으니 언제나 통과한다 — /api/ledger/sync가
    // 없는 칸 이름 하나 때문에 조용히 성공하던 것과 같은 고장이다.
    const v = ledgerCompleteness({
      expected: null, states: [covering('c1')],
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.complete, false); eq(v.code, 'CONNECTIONS_UNKNOWN');
  });

  test('수집 상태를 못 읽었으면 완전하다고 말하지 않는다', () => {
    const v = ledgerCompleteness({
      expected: ['c1'], states: null,
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.complete, false); eq(v.code, 'INGEST_UNKNOWN');
  });

  test('활성 연결이 하나도 없으면 완전하다고 말하지 않는다', () => {
    // 대조할 것이 없다는 이유로 통과시키면, 연결이 사라진 상태에서
    // 매매손익이 확정된다.
    const v = ledgerCompleteness({
      expected: [], states: [],
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.complete, false); eq(v.code, 'NO_CONNECTION');
  });

  test('비활성이 된 옛 연결은 완전성을 막지 않는다', () => {
    // 이미 안 쓰는 연결이 옛 구간에 머물러 있다고 오늘 손익을 막을
    // 이유는 없다. 다만 사라졌다고 적지도 않는다.
    const v = ledgerCompleteness({
      expected: ['c1'],
      states: [covering('c1'), { connectionId: 'old', fromMs: DAY - 99_000_000, toMs: DAY - 88_000_000 }],
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.complete, true);
    eq(v.stale.join(','), 'old');
  });

  test('상태 행이 없는 연결이 있으면 구간 판정보다 먼저 걸린다', () => {
    // 순서가 반대면 "최근 5분이 안 덮였다"만 보이고, **한 번도 안 읽은
    // 연결이 있다**는 더 큰 사실이 가려진다.
    const v = ledgerCompleteness({
      expected: ['c1', 'c2'],
      states: [{ connectionId: 'c1', fromMs: DAY - 1000, toMs: NOW - 3600_000 }],
      periodFromMs: DAY, periodToMs: NOW,
    });
    eq(v.code, 'MISSING_CONNECTIONS');
  });
}
