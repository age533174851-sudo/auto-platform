// src/lib/autotrade/schedulePages.test.ts
//
// Worker 예약 조회는 100개가 끝이 아니다. 페이지를 전부 읽기 전에는
// 어떤 예약도 평가하지 않는다 — 중간 페이지 실패를 정상 부분 목록으로
// 처리하면 뒤쪽 사용자의 예약이 영원히 굶는다.
import { test, eq, assert } from '../../test/harness';
import { loadEnabledSchedulePages, SCHEDULE_PAGE_SIZE, MAX_SCHEDULE_PAGES } from './schedulePages';

type FakeRow = { id: string };
const fakeRows = (n: number): FakeRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `schedule-${String(i).padStart(5, '0')}` }));

async function mustReject(p: Promise<unknown>, fragment: string): Promise<void> {
  let message = '';
  try { await p; } catch (e: any) { message = String(e?.message ?? e); }
  assert(message.includes(fragment), `예상한 실패(${fragment})가 없음: ${message || '정상 반환'}`);
}

export function runSchedulePagesTests() {
  console.log('[Worker 예약 전체 페이지 조회 — 부분 성공 금지]');

  test('250개 예약은 100+100+50으로 전부 읽고 마지막 예약도 남긴다', async () => {
    const all = fakeRows(250);
    const calls: string[] = [];
    const got = await loadEnabledSchedulePages<FakeRow>(async (from, to) => {
      calls.push(`${from}-${to}`);
      return { data: all.slice(from, to + 1), error: null };
    });
    eq(SCHEDULE_PAGE_SIZE, 100);
    eq(got.length, 250);
    eq(got[249].id, all[249].id);
    eq(calls.join(','), '0-99,100-199,200-299');
  });

  test('정확히 100개면 빈 두 번째 페이지까지 확인한다', async () => {
    const all = fakeRows(100);
    let calls = 0;
    const got = await loadEnabledSchedulePages<FakeRow>(async (from, to) => {
      calls++;
      return { data: all.slice(from, to + 1), error: null };
    });
    eq(got.length, 100);
    eq(calls, 2);
  });

  test('첫 페이지 0개는 정상적인 빈 예약 목록이다', async () => {
    const got = await loadEnabledSchedulePages<FakeRow>(async () => ({ data: [], error: null }));
    eq(got.length, 0);
  });

  test('두 번째 페이지 DB 오류는 부분 100개를 반환하지 않고 전체 실패한다', async () => {
    const all = fakeRows(150);
    await mustReject(loadEnabledSchedulePages<FakeRow>(async (from, to) =>
      from === 100
        ? { data: null, error: { message: 'exceed_egress_quota' } }
        : { data: all.slice(from, to + 1), error: null },
    ), 'exceed_egress_quota');
  });

  test('성공 HTTP여도 데이터가 배열이 아니면 0개로 둔갑하지 않는다', async () => {
    await mustReject(loadEnabledSchedulePages<FakeRow>(async () =>
      ({ data: null, error: null })), '배열');
  });

  test('잘못된 초과 크기 페이지는 조용히 잘라 쓰지 않는다', async () => {
    await mustReject(loadEnabledSchedulePages<FakeRow>(async () =>
      ({ data: fakeRows(101), error: null })), '초과');
  });

  test('상한에 도달하면 불완전한 목록을 반환하지 않는다', async () => {
    let calls = 0;
    await mustReject(loadEnabledSchedulePages<FakeRow>(async () => {
      calls++;
      return { data: fakeRows(SCHEDULE_PAGE_SIZE), error: null };
    }), '상한');
    eq(calls, MAX_SCHEDULE_PAGES);
  });
}
