// src/lib/calendar/normalize.test.ts
//
// 막으려는 사고:
//  1. 시간대 없는 '2026-07-28 14:00'을 그대로 읽는 것 — JS Date는 그걸
//     실행 환경 시간대로 조용히 해석한다. 서버(UTC)와 개발자 노트북(KST)이
//     다른 답을 내고, 화면에는 둘 다 '오후 2시'로 보인다
//  2. 발표 전 지표에 실제치가 들어가는 것 — "CPI 3.2% 나왔다"가 되는데
//     아직 안 나온 숫자다
//  3. 중요도를 모를 때 'low'로 떨어뜨려 중요한 일정이 필터에서 빠지는 것
//  4. 같은 지표가 여러 공급자에서 와서 달력에 세 번 뜨는 것
import { test, assert, eq } from '../../test/harness';
import {
  parseImpact, toUtc, toDate, cleanValue, eventKey,
  normalizeEvent, collectEvents,
} from './normalize';

const PAST = '2020-01-15';
const FUTURE = '2099-01-15';

export function runCalendarTests() {
  console.log('[경제 캘린더 — 시간대]');

  test('시간대 없는 문자열은 받지 않는다', () => {
    // 어느 나라 2시인지 알 수 없다. 환경마다 다른 답이 나온다.
    eq(toUtc('2026-07-28 14:00'), null);
    eq(toUtc('2026-07-28T14:00'), null);
    eq(toUtc('2026-07-28T14:00:00'), null);
  });

  test('시간대가 있으면 UTC로 바꾼다', () => {
    eq(toUtc('2026-07-28T14:00:00Z'), '2026-07-28T14:00:00.000Z');
    // 한국 시각 23:00 = UTC 14:00
    eq(toUtc('2026-07-28T23:00:00+09:00'), '2026-07-28T14:00:00.000Z');
    eq(toUtc('2026-07-28T09:00:00-05:00'), '2026-07-28T14:00:00.000Z');
  });

  test('유닉스 초와 밀리초를 구분한다', () => {
    eq(toUtc(1769558400), toUtc(1769558400000));
    assert(toUtc(1769558400)!.startsWith('2026-'), String(toUtc(1769558400)));
  });

  test('알아볼 수 없으면 null', () => {
    eq(toUtc('내일'), null);
    eq(toUtc(''), null);
    eq(toUtc(null), null);
    eq(toUtc(0), null);
  });

  test('시각을 몰라도 날짜는 살린다', () => {
    // 하루 종일 일정이거나 시각 미정인 지표가 있다
    eq(toDate('2026-07-28 14:00'), '2026-07-28');
    eq(toDate('2026-07-28'), '2026-07-28');
    eq(toDate('2026-07-28T14:00:00Z'), '2026-07-28');
    eq(toDate('언젠가'), null);
  });

  console.log('[경제 캘린더 — 중요도]');

  test('공급자마다 다른 표기를 받는다', () => {
    for (const v of [3, '3', 'high', 'High', '주요']) eq(parseImpact(v), 'high', String(v));
    for (const v of [2, 'medium', 'Moderate', '중간']) eq(parseImpact(v), 'medium', String(v));
    for (const v of [1, 'low', '낮음']) eq(parseImpact(v), 'low', String(v));
  });

  test('모르면 unknown — low가 아니다', () => {
    // low로 떨어뜨리면 중요한 일정이 조용히 필터에서 빠진다
    eq(parseImpact(null), 'unknown');
    eq(parseImpact(''), 'unknown');
    eq(parseImpact('보라색'), 'unknown');
    eq(parseImpact('0'), 'unknown', '0은 low인지 없음인지 알 수 없다');
  });

  console.log('[경제 캘린더 — 값 정리]');

  test('빈 값 표기를 null로 통일한다', () => {
    // 빈 문자열을 두면 '0으로 나왔다'로도 '아직이다'로도 읽힌다
    for (const v of ['', ' ', '-', '—', 'N/A', 'n/a', 'null']) eq(cleanValue(v), null, String(v));
    eq(cleanValue('3.2%'), '3.2%');
    eq(cleanValue(0), '0', '숫자 0은 값이다');
  });

  console.log('[경제 캘린더 — 발표 전 실제치]');

  test('미래 일정에는 실제치를 넣지 않는다', () => {
    // 공급자가 예상치를 actual 자리에 채워 보내는 경우가 있다.
    // 그대로 두면 아직 안 나온 숫자가 '발표됨'으로 화면에 뜬다.
    const e = normalizeEvent({
      event: 'CPI', country: 'US', date: FUTURE,
      actual: '3.2%', forecast: '3.2%', previous: '3.1%',
    }, 'x')!;
    eq(e.actual, null, '발표 전인데 실제치가 남았다');
    eq(e.forecast, '3.2%', '예상치는 그대로 둬야 한다');
  });

  test('지난 일정의 실제치는 유지한다', () => {
    const e = normalizeEvent({
      event: 'CPI', country: 'US', date: PAST, actual: '3.4%', forecast: '3.2%',
    }, 'x')!;
    eq(e.actual, '3.4%');
  });

  console.log('[경제 캘린더 — 정규화]');

  test('공급자마다 다른 필드 이름을 읽는다', () => {
    const a = normalizeEvent({ event: 'CPI', country: 'US', date: PAST, estimate: '3.2%' }, 'te')!;
    eq(a.forecast, '3.2%');
    const b = normalizeEvent({ Event: 'FOMC', Country: 'US', Date: PAST, Forecast: '5.25%' }, 'fmp')!;
    eq(b.title, 'FOMC');
    eq(b.forecast, '5.25%');
  });

  test('제목이나 날짜가 없으면 버린다', () => {
    eq(normalizeEvent({ country: 'US', date: PAST }, 'x'), null);
    eq(normalizeEvent({ event: 'CPI', country: 'US' }, 'x'), null);
    eq(normalizeEvent(null as any, 'x'), null);
  });

  test('시간대 없는 일정도 날짜로는 남는다', () => {
    const e = normalizeEvent({ event: 'CPI', country: 'US', date: '2026-07-28 08:30' }, 'x')!;
    eq(e.at, null, '확정 못 한 시각을 만들어내면 안 된다');
    eq(e.date, '2026-07-28');
  });

  console.log('[경제 캘린더 — 중복 제거]');

  test('같은 지표는 한 번만 남긴다', () => {
    const r = collectEvents([
      { provider: 'a', items: [{ event: 'CPI', country: 'US', date: PAST }] },
      { provider: 'b', items: [{ event: 'C.P.I.', country: 'us', date: PAST }] },
    ]);
    eq(r.events.length, 1, '달력에 같은 지표가 두 번 뜬다');
    eq(r.removed, 1);
  });

  test('정보가 더 많은 쪽을 남긴다', () => {
    const r = collectEvents([
      { provider: 'thin', items: [{ event: 'CPI', country: 'US', date: PAST }] },
      { provider: 'rich', items: [{
        event: 'CPI', country: 'US', date: PAST,
        datetime: `${PAST}T13:30:00Z`, actual: '3.4%', forecast: '3.2%',
        previous: '3.1%', impact: 'high',
      }] },
    ]);
    eq(r.events.length, 1);
    eq(r.events[0].provider, 'rich');
    eq(r.events[0].actual, '3.4%');
  });

  test('시간순으로 돌려준다', () => {
    const r = collectEvents([{ provider: 'x', items: [
      { event: 'B', country: 'US', date: '2026-07-30' },
      { event: 'A', country: 'US', date: '2026-07-28' },
    ] }]);
    eq(r.events[0].title, 'A');
  });

  test('응답이 배열이 아니어도 죽지 않는다', () => {
    const r = collectEvents([
      { provider: 'a', items: null },
      { provider: 'b', items: { error: 'rate limit' } as any },
      { provider: 'c', items: [{ event: 'CPI', country: 'US', date: PAST }] },
    ]);
    eq(r.events.length, 1);
  });

  test('버린 개수를 알린다', () => {
    // 감추면 공급자 형식이 바뀌어도 모른다
    const r = collectEvents([{ provider: 'x', items: [
      { event: 'CPI', country: 'US', date: PAST },
      { country: 'US', date: PAST },
    ] }]);
    eq(r.skipped, 1);
  });

  test('지문이 국가를 구분한다', () => {
    // 같은 이름의 지표가 나라마다 있다
    assert(eventKey('US', 'CPI', PAST) !== eventKey('KR', 'CPI', PAST));
  });
}
