import { upcomingFromCalendar, type CalendarEvent } from './econCalendar';
import { test, eq, assert } from '../../test/harness';

export function runCalendarVetoEvidenceTests() {
  const now = Date.parse('2026-10-21T15:00:00Z');
  const event: CalendarEvent = {
    id: 'fred-cpi', timestampUtc: Date.parse('2026-10-21T00:00:00Z'),
    event: 'CPI', impact: 'high', source: 'api', timeKnown: false,
  };
  test('FRED 날짜 전용 고영향 일정은 당일 오후에도 회피한다', () => {
    const events = upcomingFromCalendar([event], now, 24);
    eq(events.length, 1);
    eq(events[0].hoursUntil, 0);
    eq(events[0].impact, 'high');
  });
  test('FRED 날짜 전용 일정은 다음 날 자정 이후 발표된 것으로 오판하지 않는다', () => {
    eq(upcomingFromCalendar([event], Date.parse('2026-10-22T00:01:00Z'), 24).length, 0);
  });
  test('UTC 시각을 아는 일정은 실제 발표시간을 유지한다', () => {
    const exact = { ...event, timeKnown: true, timestampUtc: now + 3_600_000 };
    const items = upcomingFromCalendar([exact], now, 24);
    eq(items.length, 1);
    eq(items[0].hoursUntil, 1);
  });
  test('날짜만 아는 일정은 발표 전날을 자정 발표로 위장하지 않는다', () => {
    eq(upcomingFromCalendar([event], Date.parse('2026-10-20T23:59:00Z'), 24).length, 0);
  });
  test('유효하지 않은 일정 시각은 폐기한다', () => {
    eq(upcomingFromCalendar([{ ...event, timestampUtc: NaN }], now, 24).length, 0);
  });
}
