// 공급자 설정/응답 상태는 일정 수와 별개의 증거다.
// [] = 성공적으로 받은 정상 빈 일정; null = HTTP 오류/타임아웃/깨진 응답.
// Risk Veto가 의존하는 달력에서 "모든 공급자 실패"를 정상 0건으로 적지 않는다.

export interface CalendarProviderBatch {
  provider: string;
  items: unknown;
}

export type CalendarProviderVerdict = 'NO_PROVIDERS' | 'UNAVAILABLE' | 'AVAILABLE';

/**
 * FRED는 release_dates 배열을 반환하지만 pickFredEvents는 관심 없는 발표를
 * 버리므로, 선택된 fredRows.length가 0이어도 원본 응답이 유효하면 성공이다.
 */
export function calendarProviderVerdict(
  batches: readonly CalendarProviderBatch[],
  fredConfigured: boolean,
  fredResponseValid: boolean,
): CalendarProviderVerdict {
  if (batches.length === 0 && !fredConfigured) return 'NO_PROVIDERS';
  if ((fredConfigured && fredResponseValid) || batches.some(b => Array.isArray(b.items))) {
    return 'AVAILABLE';
  }
  return 'UNAVAILABLE';
}
