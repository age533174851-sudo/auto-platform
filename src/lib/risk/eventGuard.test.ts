import { test, eq, assert } from '../../test/harness';
import { checkEventWindow, parseCalendarEvents, type EconEvent } from './eventGuard';

export function runEventGuardTests() {
  console.log('[지표 회피 — 시각을 모르면 하루를 막는다]');

  const MIN = 60_000;
  const ev = (o: Partial<EconEvent>): EconEvent => ({
    id: 'x', title: 'CPI', impact: 'high', at: Date.now(), ...o,
  });

  // ── 시각을 아는 경우 ────────────────────────────────────
  test('발표 30분 전이면 막는다', () => {
    eq(checkEventWindow([ev({ at: Date.now() + 20 * MIN })]).blocked, true);
  });

  test('충분히 멀면 안 막는다', () => {
    eq(checkEventWindow([ev({ at: Date.now() + 5 * 60 * MIN })]).blocked, false);
  });

  test('발표 후 60분까지 막는다', () => {
    eq(checkEventWindow([ev({ at: Date.now() - 30 * MIN })]).blocked, true);
    eq(checkEventWindow([ev({ at: Date.now() - 90 * MIN })]).blocked, false);
  });

  test('중요도가 낮으면 기본값으로는 안 막는다', () => {
    eq(checkEventWindow([ev({ at: Date.now(), impact: 'medium' })]).blocked, false);
    eq(checkEventWindow([ev({ at: Date.now(), impact: 'medium' })], { minImpact: 'medium' }).blocked, true);
  });

  // ── 시각을 모르는 경우 ──────────────────────────────────
  //
  // FRED는 날짜만 준다. 시각을 지어내면(예: 8시 30분 ET) 서머타임까지 얽혀
  // 한 시간이 어긋나고, ±30분 창에서는 **정확히 발표 순간에 진입이 열린다.**

  test('시각을 모르는 일정은 그날 하루 전체를 막는다', () => {
    const now = Date.now();
    const midnight = Date.UTC(
      new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    // 0시로 저장돼 있어도 지금이 그날이면 막힌다
    const r = checkEventWindow([ev({ at: midnight, dayOnly: true })]);
    eq(r.blocked, true);
    assert(r.reason.includes('하루 전체'), r.reason);
  });

  test('다른 날이면 안 막는다', () => {
    const yesterday = Date.now() - 36 * 60 * MIN;
    const d0 = Date.UTC(
      new Date(yesterday).getUTCFullYear(), new Date(yesterday).getUTCMonth(), new Date(yesterday).getUTCDate());
    eq(checkEventWindow([ev({ at: d0, dayOnly: true })]).blocked, false);
  });

  test('하루짜리는 ±윈도우를 쓰지 않는다 — 0시 기준이면 정작 발표 때 안 막힌다', () => {
    // 예전 규칙(±30분)이라면 0시에서 12시간 떨어진 지금은 통과했을 것이다.
    const now = Date.now();
    const midnight = Date.UTC(
      new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    const asTimed = checkEventWindow([ev({ at: midnight })]);          // dayOnly 없음
    const asDay   = checkEventWindow([ev({ at: midnight, dayOnly: true })]);
    // 지금이 0시 직후가 아니라면 둘의 답이 달라야 한다
    if (now - midnight > 90 * MIN) {
      eq(asTimed.blocked, false);
      eq(asDay.blocked, true);
    }
  });

  // ── 응답 → 이벤트 ───────────────────────────────────────
  test('time_known=false만 하루 종일로 본다', () => {
    // 값이 없으면(옛 행·다른 공급자) 시각을 아는 것으로 둔다. 없는 값을
    // '모른다'로 읽으면 기존 일정이 전부 하루 종일 회피가 되어 매매가
    // 통째로 멈춘다.
    const [a, b, c] = parseCalendarEvents([
      { id: '1', title: 'A', impact: 'high', at: 1_700_000_000_000, time_known: false },
      { id: '2', title: 'B', impact: 'high', at: 1_700_000_000_000, time_known: true },
      { id: '3', title: 'C', impact: 'high', at: 1_700_000_000_000 },
    ]);
    eq(a.dayOnly, true);
    eq(b.dayOnly, false);
    eq(c.dayOnly, false);
  });

  test('시각을 못 만들면 버린다', () => {
    eq(parseCalendarEvents([{ id: '1', title: 'A' }]).length, 0);
    eq(parseCalendarEvents([{ id: '1', title: 'A', date: 'nope' }]).length, 0);
  });

  test('빈 입력에도 터지지 않는다', () => {
    eq(parseCalendarEvents(null as any).length, 0);
    eq(checkEventWindow([]).blocked, false);
  });
}
