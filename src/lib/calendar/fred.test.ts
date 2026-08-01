import { test, eq, assert } from '../../test/harness';
import { pickFredEvents, fredEventsToRows, fredReleaseDatesUrl, FRED_WATCH } from './fred';

export function runFredTests() {
  console.log('[FRED — 날짜만 알 때 시각을 지어내지 않는다]');

  const row = (release_name: string, date: string) => ({ release_name, date });

  test('볼 목록에 있는 발표만 고른다', () => {
    // FRED에는 하루에도 수십 개가 있다. 전부 넣으면 '고영향'이라는 구분이
    // 무의미해지고 회피가 상시 발동해 매매가 멈춘다.
    const r = pickFredEvents([
      row('Consumer Price Index', '2026-08-15'),
      row('Advance Durable Goods Shipments Detail', '2026-08-15'),
      row('Employment Situation', '2026-09-04'),
    ]);
    eq(r.length, 2);
    eq(r[0].title, '미국 소비자물가지수 (CPI)');
  });

  test('이름 전체가 아니라 조각으로 맞춘다', () => {
    // FRED가 표기를 바꿔도 계속 잡혀야 한다.
    const r = pickFredEvents([row('Consumer Price Index for All Urban Consumers', '2026-08-15')]);
    eq(r.length, 1);
  });

  test('대소문자를 가리지 않는다', () => {
    eq(pickFredEvents([row('CONSUMER PRICE INDEX', '2026-08-15')]).length, 1);
  });

  test('시각은 언제나 모르는 것으로 표시한다', () => {
    // 여기서 '8시 30분 ET'를 넣고 싶어지는데, 서머타임까지 얽히면 한 시간이
    // 어긋난다. 회피 창이 ±30분이면 **정확히 발표 순간에 진입이 열린다.**
    const r = pickFredEvents([row('Consumer Price Index', '2026-08-15')]);
    eq(r[0].timeKnown, false);
  });

  test('날짜 모양이 아니면 버린다 — 추측해서 채우지 않는다', () => {
    eq(pickFredEvents([row('Consumer Price Index', '')]).length, 0);
    eq(pickFredEvents([row('Consumer Price Index', '2026/08/15')]).length, 0);
    eq(pickFredEvents([row('Consumer Price Index', 'August 15')]).length, 0);
  });

  test('이름이 없으면 버린다', () => {
    eq(pickFredEvents([row('', '2026-08-15')]).length, 0);
  });

  test('같은 날 같은 발표는 한 번만', () => {
    // FRED는 정정·재발표로 같은 release가 여러 줄 올 수 있다.
    const r = pickFredEvents([
      row('Consumer Price Index', '2026-08-15'),
      row('Consumer Price Index', '2026-08-15'),
    ]);
    eq(r.length, 1);
  });

  test('다른 날이면 따로 센다', () => {
    const r = pickFredEvents([
      row('Consumer Price Index', '2026-08-15'),
      row('Consumer Price Index', '2026-09-15'),
    ]);
    eq(r.length, 2);
  });

  test('날짜 순으로 준다', () => {
    const r = pickFredEvents([
      row('Employment Situation', '2026-09-04'),
      row('Consumer Price Index', '2026-08-15'),
    ]);
    eq(r[0].date, '2026-08-15');
  });

  test('중요도가 붙는다 — 전부 high가 아니다', () => {
    const r = pickFredEvents([
      row('Consumer Price Index', '2026-08-15'),
      row('Producer Price Index', '2026-08-16'),
    ]);
    eq(r[0].impact, 'high');
    eq(r[1].impact, 'medium');
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(pickFredEvents(null).length, 0);
    eq(pickFredEvents(undefined).length, 0);
    eq(pickFredEvents([null as any]).length, 0);
  });

  // ── 저장 행 ─────────────────────────────────────────────
  test('저장 행의 시각은 그날 0시 UTC이고 time_known은 false다', () => {
    // 이 0시는 발표 시각이 아니다. '모른다'는 뜻이고 time_known이 그 사실을
    // 들고 간다 — 회피 판정이 그 표시를 보고 하루 전체를 막는다.
    const rows = fredEventsToRows(pickFredEvents([row('Consumer Price Index', '2026-08-15')]));
    eq(rows[0].timestamp_utc, '2026-08-15T00:00:00.000Z');
    eq(rows[0].time_known, false);
    eq(rows[0].source, 'fred');
    eq(rows[0].country, 'US');
  });

  test('예상치·이전치는 비운다 — FRED가 안 준다', () => {
    // 없는 것을 0이나 빈 문자열로 채우면 화면이 '0%'를 진짜 전망으로 그린다.
    const rows = fredEventsToRows(pickFredEvents([row('Employment Situation', '2026-09-04')]));
    eq(rows[0].forecast, null);
    eq(rows[0].previous, null);
    eq(rows[0].actual, null);
  });

  test('같은 발표는 같은 id — 다시 받아도 덮어쓴다', () => {
    const a = fredEventsToRows(pickFredEvents([row('Consumer Price Index', '2026-08-15')]));
    const b = fredEventsToRows(pickFredEvents([row('Consumer Price Index', '2026-08-15')]));
    eq(a[0].id, b[0].id);
  });

  // ── 주소 ────────────────────────────────────────────────
  test('키와 기간이 주소에 들어간다', () => {
    const u = fredReleaseDatesUrl('KEY123', '2026-08-01', '2026-09-01');
    assert(u.includes('api_key=KEY123'), u);
    assert(u.includes('realtime_start=2026-08-01'), u);
    assert(u.includes('file_type=json'), u);
  });

  test('볼 목록에 중복 키가 없다', () => {
    // 같은 조각이 둘이면 앞의 것만 맞고 뒤는 죽은 설정이 된다.
    const seen = new Set(FRED_WATCH.map(w => w.match));
    eq(seen.size, FRED_WATCH.length);
  });
}
