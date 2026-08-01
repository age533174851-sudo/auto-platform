// src/lib/risk/lossStreak.test.ts
//
// 하루 한도가 못 보는 두 가지를 잠근다.
//
//   월 −2.8% · 화 −2.9% · 수 −2.7% · 목 −2.9% · 금 −2.6%
//
// 매일 한도(−3%)를 안 넘었으니 하루 잠금은 **한 번도 안 걸린다.** 그런데
// 한 주에 −13%다. 이 테스트가 지키는 것이 그 눈이다.
//
// 그리고 연패: 잠금 해제를 **지금 시각** 기준으로 재면 조회할 때마다
// 뒤로 밀려 영원히 안 풀린다. 마지막 손절 시각 기준이어야 한다.

import { test, eq, assert } from '../../test/harness';
import {
  judgeWeeklyLoss, judgeLossStreak,
  readWeeklyLossConfig, readStreakConfig,
  utcWeekStart, nextUtcWeekStart, nextUtcDayStart,
  DEFAULT_WEEKLY, DEFAULT_STREAK,
  type StreakTrade,
} from './lossStreak';

const DAY = 86_400_000;
// 2023-11-15 = 수요일 (UTC)
const WED = Date.UTC(2023, 10, 15, 12, 0, 0);

const weekly = (netUsd: number | null, equity: number | null = 10_000, cfg = DEFAULT_WEEKLY) =>
  judgeWeeklyLoss({ weekNetUsd: netUsd, weekStartEquityUsd: equity, cfg });

const t = (pnl: number, hoursAgo: number): StreakTrade =>
  ({ realizedPnl: pnl, closedAtMs: WED - hoursAgo * 3_600_000 });

const streak = (trades: StreakTrade[] | null, nowMs = WED, cfg = DEFAULT_STREAK) =>
  judgeLossStreak({ trades, nowMs, cfg });

export function runLossStreakTests() {
  console.log('[주간 한도 — 하루 한도가 못 보는 것]');

  test('매일 한도를 안 넘겨도 주간에서 걸린다', () => {
    // −2.8 −2.9 −2.7 −2.9 −2.6 = −13.9% (하루 한도 3%는 한 번도 안 걸렸다)
    const v = weekly(-1390, 10_000);
    eq(v.status, 'locked');
    eq(v.blockEntries, true);
    assert(v.reason.includes('청산은 계속'), v.reason);
  });

  test('한도 안이면 남은 여유를 알려준다', () => {
    const v = weekly(-300, 10_000);
    eq(v.status, 'ok');
    eq(v.limitUsd, 700);
    eq(v.remainingUsd, 400);
  });

  test('이익 중이면 여유가 한도 전액이다', () => {
    eq(weekly(500, 10_000).remainingUsd, 700);
  });

  test('정확히 한도에 닿으면 잠근다 (넘어야 잠그면 한 번 더 나간다)', () => {
    eq(weekly(-700, 10_000).status, 'locked');
  });

  test('**손익을 모르면 막는다** — 조회 실패는 "한도 안"이 아니다', () => {
    const v = weekly(null);
    eq(v.status, 'unknown');
    eq(v.blockEntries, true);
  });

  test('비율 한도를 걸었는데 시작 자산을 모르면 막는다 — 잠금이 조용히 사라지면 안 된다', () => {
    const v = weekly(-100, null);
    eq(v.status, 'unknown');
    assert(v.reason.includes('시작 자산'), v.reason);
  });

  test('둘 다 있으면 **작은 쪽**이 이긴다', () => {
    // 비율 7% = 700, 금액 한도 300 → 300이 이긴다
    const v = weekly(-350, 10_000, { maxLossPct: 7, maxLossUsd: 300 });
    eq(v.limitUsd, 300);
    eq(v.status, 'locked');
  });

  test('금액 한도만 있으면 시작 자산이 없어도 판정한다', () => {
    const v = weekly(-100, null, { maxLossPct: null, maxLossUsd: 500 });
    eq(v.status, 'ok');
    eq(v.limitUsd, 500);
  });

  test('한도가 아예 없으면 막지 않는다', () => {
    const v = weekly(-99999, 10_000, { maxLossPct: null, maxLossUsd: null });
    eq(v.status, 'ok');
    eq(v.blockEntries, false);
  });

  console.log('[연패 잠금]');

  test('5연패면 잠근다', () => {
    const v = streak([t(-10, 5), t(-10, 4), t(-10, 3), t(-10, 2), t(-10, 1)]);
    eq(v.streak, 5);
    eq(v.status, 'locked');
    assert(v.reason.includes('청산은 계속'), v.reason);
  });

  test('4연패면 아직 아니다 — 남은 횟수를 알려준다', () => {
    const v = streak([t(-10, 4), t(-10, 3), t(-10, 2), t(-10, 1)]);
    eq(v.streak, 4);
    eq(v.status, 'ok');
    assert(v.reason.includes('5회'), v.reason);
  });

  test('중간에 이익이 하나 있으면 연패가 끊긴다', () => {
    const v = streak([t(-10, 6), t(-10, 5), t(+5, 4), t(-10, 3), t(-10, 2), t(-10, 1)]);
    eq(v.streak, 3, '이익 이후의 3연패만 센다');
    eq(v.status, 'ok');
  });

  test('본전(±0)은 연패를 끊지도 세지도 않는다', () => {
    const v = streak([t(-10, 5), t(-10, 4), t(0, 3), t(-10, 2), t(-10, 1)]);
    eq(v.streak, 4, '본전을 반등으로 치면 안 되고, 손실로 세도 안 된다');
  });

  test('순서가 섞여 들어와도 시각순으로 센다', () => {
    // 입력 순서는 뒤죽박죽이지만 시각순으로는 4h(+5) → 3h → 2h → 1h.
    // 이익 이후의 손실은 셋이다.
    const v = streak([t(-10, 1), t(+5, 4), t(-10, 2), t(-10, 3)]);
    eq(v.streak, 3, '입력 순서가 아니라 시각 순서로 세야 한다');
    // 입력 순서대로 셌다면 첫 건(-10) 다음이 이익이라 1에서 끊긴다
    assert(v.streak !== 1, '배열 순서를 그대로 믿으면 안 된다');
  });

  test('거래가 없으면 연패도 없다', () => {
    eq(streak([]).streak, 0);
    eq(streak([]).status, 'ok');
  });

  test('**기록을 못 읽으면 막는다** — 빈 배열과 null은 다르다', () => {
    const v = streak(null);
    eq(v.status, 'unknown');
    eq(v.blockEntries, true);
    assert(v.reason.includes('확인하지 못'), v.reason);
  });

  console.log('[연패 잠금 — 언제 풀리나]');

  test('잠금은 **마지막 손절 시각** 기준이다 — 지금 시각 기준이면 영원히 안 풀린다', () => {
    const trades = [t(-10, 5), t(-10, 4), t(-10, 3), t(-10, 2), t(-10, 1)];
    const a = streak(trades, WED);
    const b = streak(trades, WED + 3 * 3_600_000);   // 3시간 뒤에 다시 조회
    eq(a.unlockAtMs, b.unlockAtMs, '조회할 때마다 뒤로 밀리면 안 된다');
  });

  test('기본은 다음 UTC 자정까지', () => {
    const v = streak([t(-10, 5), t(-10, 4), t(-10, 3), t(-10, 2), t(-10, 1)]);
    eq(v.unlockAtMs, nextUtcDayStart(WED - 3_600_000));
  });

  test('시간이 지나면 풀린다 — 연패 기록은 그대로여도', () => {
    const trades = [t(-10, 5), t(-10, 4), t(-10, 3), t(-10, 2), t(-10, 1)];
    const v = streak(trades, WED + 2 * DAY);
    eq(v.status, 'ok');
    eq(v.streak, 5, '연패 수는 사실 그대로 보고한다');
    assert(v.reason.includes('지났습니다'), v.reason);
  });

  test('잠금 길이를 시간으로 정할 수 있다', () => {
    const trades = [t(-10, 5), t(-10, 4), t(-10, 3), t(-10, 2), t(-10, 1)];
    const cfg = { maxConsecutiveLosses: 5, lockHours: 4 };
    const v = judgeLossStreak({ trades, nowMs: WED, cfg });
    eq(v.unlockAtMs, (WED - 3_600_000) + 4 * 3_600_000);
    // 5시간 뒤면 풀린다
    eq(judgeLossStreak({ trades, nowMs: WED + 5 * 3_600_000, cfg }).status, 'ok');
  });

  test('연패 잠금을 끄면 아무리 잃어도 안 막는다', () => {
    const trades = Array.from({ length: 20 }, (_, i) => t(-10, 20 - i));
    const v = judgeLossStreak({
      trades, nowMs: WED, cfg: { maxConsecutiveLosses: null, lockHours: null },
    });
    eq(v.status, 'ok');
    eq(v.blockEntries, false);
  });

  console.log('[주 경계 — UTC 월요일]');

  test('수요일의 주 시작은 그 주 월요일 0시', () => {
    const start = utcWeekStart(WED);
    eq(new Date(start).getUTCDay(), 1, '월요일');
    eq(new Date(start).getUTCHours(), 0);
    eq(start, Date.UTC(2023, 10, 13));
  });

  test('일요일은 **지난 월요일**이 주 시작이다 — 일요일 시작이면 주말 손실이 쪼개진다', () => {
    const sun = Date.UTC(2023, 10, 19, 23, 0, 0);   // 2023-11-19 일요일
    eq(utcWeekStart(sun), Date.UTC(2023, 10, 13));
  });

  test('월요일 0시 자신은 그 주의 시작', () => {
    const mon = Date.UTC(2023, 10, 13, 0, 0, 0);
    eq(utcWeekStart(mon), mon);
  });

  test('다음 주는 정확히 7일 뒤', () => {
    eq(nextUtcWeekStart(WED) - utcWeekStart(WED), 7 * DAY);
  });

  console.log('[설정 읽기]');

  const envOf = (o: Record<string, string>) => (k: string) => o[k];

  test('기본값 — 주간 7% · 연패 5회', () => {
    eq(readWeeklyLossConfig(envOf({})).cfg.maxLossPct, DEFAULT_WEEKLY.maxLossPct);
    eq(readStreakConfig(envOf({})).cfg.maxConsecutiveLosses, DEFAULT_STREAK.maxConsecutiveLosses);
  });

  test('값을 바꾼다', () => {
    eq(readWeeklyLossConfig(envOf({ WEEKLY_MAX_LOSS_PCT: '10' })).cfg.maxLossPct, 10);
    eq(readStreakConfig(envOf({ MAX_CONSECUTIVE_LOSSES: '3' })).cfg.maxConsecutiveLosses, 3);
  });

  test('off로 끌 수 있다 — 끄는 방법이 없으면 사용자가 코드를 고쳐야 한다', () => {
    for (const v of ['off', 'none', 'false', '0']) {
      eq(readWeeklyLossConfig(envOf({ WEEKLY_MAX_LOSS_PCT: v })).cfg.maxLossPct, null, v);
      eq(readStreakConfig(envOf({ MAX_CONSECUTIVE_LOSSES: v })).cfg.maxConsecutiveLosses, null, v);
    }
  });

  test('이상한 값은 기본값을 쓰되 그 사실을 남긴다', () => {
    const r = readWeeklyLossConfig(envOf({ WEEKLY_MAX_LOSS_PCT: 'abc' }));
    eq(r.cfg.maxLossPct, DEFAULT_WEEKLY.maxLossPct);
    assert(r.note.includes('WEEKLY_MAX_LOSS_PCT'), `오타를 알려야 한다: ${r.note}`);
  });
}
