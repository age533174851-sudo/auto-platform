// src/lib/autotrade/schedulePages.ts
//
// Fly Worker가 읽는 활성 예약 목록은 100개에서 끝나지 않는다.
// DB가 한 페이지만 돌려줘도 정상 응답이므로, 길이 100이면 다음 페이지를
// 확인한다. 전체 목록을 확보하기 전에는 어느 예약도 평가하지 않는다.
//
// 조회가 중간에 실패하면 부분 목록을 성공으로 돌려주지 않는다.
// 서버/워커 메모리를 보호하기 위해 최대 페이지 수도 둔다. 상한에
// 닿았을 때 일부 예약을 조용히 굶기는 대신 실패를 보고한다.

/** Supabase/PostgREST 조회에 맞춘 0-based inclusive range 크기 */
export const SCHEDULE_PAGE_SIZE = 100;
/** 비정상적으로 큰 목록은 명시적 오류로 드러낸다 (최대 10,000개) */
export const MAX_SCHEDULE_PAGES = 100;

export interface SchedulePageResult {
  data: unknown;
  error?: unknown;
}

/**
 * 안정된 고유 키로 정렬한 페이지를 받아 전체 목록을 조립한다.
 * fetchPage는 반드시 `order('id', { ascending: true }).range(from, to)`
 * 계약을 지켜야 한다. 오류·비배열·페이지 초과·상한 도달은 fail closed.
 *
 * offset 페이지네이션은 읽는 중 예약이 변경될 때 스냅샷을 보장하지
 * 않는다. 각 예약의 실제 실행 권한은 별도의 DB CAS가 다시 확인한다.
 */
export async function loadEnabledSchedulePages<T>(
  fetchPage: (from: number, to: number) => Promise<SchedulePageResult>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_SCHEDULE_PAGES; page++) {
    const from = page * SCHEDULE_PAGE_SIZE;
    const to = from + SCHEDULE_PAGE_SIZE - 1;
    const result = await fetchPage(from, to);
    if (result?.error) {
      const error = result.error as any;
      throw new Error(`예약 목록 조회 실패(${from}-${to}): ${String(error?.message ?? error)}`);
    }
    if (!Array.isArray(result?.data)) {
      throw new Error(`예약 목록 조회 실패(${from}-${to}): 응답이 배열이 아닙니다`);
    }
    if (result.data.length > SCHEDULE_PAGE_SIZE) {
      throw new Error(`예약 목록 조회 실패(${from}-${to}): 페이지 크기 초과`);
    }
    rows.push(...result.data as T[]);
    if (result.data.length < SCHEDULE_PAGE_SIZE) return rows;
  }
  throw new Error(`예약 목록 조회 실패: ${MAX_SCHEDULE_PAGES}페이지 상한에 도달해 전체 목록을 확인하지 못했습니다`);
}
