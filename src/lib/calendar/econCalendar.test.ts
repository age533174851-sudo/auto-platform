import { test, eq, assert } from '../../test/harness';
import { makeManualEvent } from './econCalendar';

// 수동 1건 입력은 Risk Veto가 읽는 `econ_events`에 그대로 들어간다.
// 일괄 경로(`/api/calendar/sync`의 validate)는 impact·event를 검사하는데
// 수동 경로는 검사하지 않았다 — **경로가 둘인데 한쪽만 막혀 있었다.**
//
// 조용히 다른 일정이 되는 세 가지:
//   ① impact 'HIGH' → 저장은 되고, 읽을 때 'low'로 떨어져 Veto가 안 걸린다
//   ② timezoneOffsetMinutes: null → isFinite(null)===true 라 UTC로 읽힌다(KST면 9시간)
//   ③ '2026-02-30' → Date.UTC가 3월 2일로 넘긴다
export function runEconManualEventTests() {
  console.log('[경제 캘린더 수동 입력 — 다른 일정으로 조용히 바꾸지 않는다]');

  const ok = { event: 'FOMC', impact: 'high' as const, localDateTime: '2026-12-17T04:00', timezoneOffsetMinutes: 540 };
  const isErr = (r: any) => r && typeof r === 'object' && 'error' in r;

  test('정상 입력은 KST → UTC로 바뀐다', () => {
    const r: any = makeManualEvent(ok);
    assert(!isErr(r), JSON.stringify(r));
    eq(new Date(r.timestampUtc).toISOString(), '2026-12-16T19:00:00.000Z');
    eq(r.impact, 'high');
  });

  test('① impact는 low|medium|high만 — "HIGH"를 저장하면 읽을 때 low가 된다', () => {
    assert(isErr(makeManualEvent({ ...ok, impact: 'HIGH' as any })), 'HIGH 통과');
    assert(isErr(makeManualEvent({ ...ok, impact: undefined as any })), 'impact 없음 통과');
  });

  test('event 이름이 없으면 TypeError(500)가 아니라 거절이다', () => {
    let r: any;
    try { r = makeManualEvent({ ...ok, event: undefined as any }); }
    catch (e: any) { r = { thrown: String(e?.message || e) }; }
    assert(isErr(r), `거절이 아님: ${JSON.stringify(r)}`);
    assert(isErr(makeManualEvent({ ...ok, event: '   ' })), '빈 이름 통과');
  });

  test('② 시간대가 null·빈 문자열이면 UTC로 읽지 않는다', () => {
    assert(isErr(makeManualEvent({ ...ok, timezoneOffsetMinutes: null as any })), 'null → UTC');
    assert(isErr(makeManualEvent({ ...ok, timezoneOffsetMinutes: '' as any })), "'' → UTC");
    assert(isErr(makeManualEvent({ ...ok, timezoneOffsetMinutes: '540' as any })), '문자열 통과');
    assert(isErr(makeManualEvent({ ...ok, timezoneOffsetMinutes: 5400 })), '±14시간 밖 통과');
  });

  test('UTC(0)는 명시된 시간대다 — 거절하지 않는다', () => {
    const r: any = makeManualEvent({ ...ok, timezoneOffsetMinutes: 0 });
    assert(!isErr(r), JSON.stringify(r));
    eq(new Date(r.timestampUtc).toISOString(), '2026-12-17T04:00:00.000Z');
  });

  test('③ 없는 날짜·시각을 다음 날로 넘기지 않는다', () => {
    assert(isErr(makeManualEvent({ ...ok, localDateTime: '2026-02-30T03:00' })), '2/30 → 3/2');
    assert(isErr(makeManualEvent({ ...ok, localDateTime: '2026-13-01T03:00' })), '13월 → 다음 해');
    assert(isErr(makeManualEvent({ ...ok, localDateTime: '2026-12-17T24:00' })), '24시 → 다음 날');
    assert(isErr(makeManualEvent({ ...ok, localDateTime: '2026-12-17T03:60' })), '60분 통과');
    // 윤년의 2/29는 있는 날이다
    assert(!isErr(makeManualEvent({ ...ok, localDateTime: '2028-02-29T03:00' })), '윤년 2/29 거절');
  });
}
