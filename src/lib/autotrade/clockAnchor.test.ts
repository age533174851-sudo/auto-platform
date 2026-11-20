// src/lib/autotrade/clockAnchor.test.ts
//
// **"아침 9시에 매수"는 지금 모델로 표현할 수 없다 — cron을 고쳐도 안 된다.**
//
// 왜 이 파일이 있나
// ─────────────────
// #450에 이런 지시가 세 번 올라왔다: "`vercel.json`의 daily-ladder는
// 23:00 UTC(08:00 KST)인데 사용자가 요청한 09:00 KST와 다르다. 이 차이의
// 실제 영향부터 재현하라."
//
// 재현해 보니 **그 진단이 틀렸다.** 그리고 실제 문제는 더 깊다.
//
// ① `daily-ladder` 라우트에는 시각 로직이 아예 없다. 불리면 그 순간
//    판단할 뿐, 08:00인지 09:00인지 보지 않는다.
// ② 그 주소는 이미 **15분마다** 불린다
//    (`.github/workflows/autotrade-tick.yml` `*/15 * * * *`).
//    그 워크플로가 직접 적어 뒀다 — "Vercel Hobby는 하루 1회만 허용해서
//    지금까지 아침 8시 한 번만 돌았다. 이제 15분마다 물어본다."
//    즉 **08:00 1회 문제는 이미 해결돼 있다.**
// ③ 그래서 진입 시각을 정하는 것은 cron이 아니라
//    `autotrade_schedules.interval_min` + `last_run_at`이다.
//
// 진짜 문제는 여기다
// ──────────────────
// `dueCheck`의 입력은 `{ nowMs, enabled, connectionId, lastRunAtMs,
// intervalMin }` 뿐이다. **하루 중 몇 시인지를 받는 입력이 없다.**
// `autotrade_schedules`에도 시각 칸이 없다(031 생성 · 034 사이징 ·
// 035 `interval_min` 추가, 그 어디에도 없다).
//
// 그래서 진입 시각은 "`last_run_at` + 간격"이고, 그 위상은 **처음
// `last_run_at`이 찍힌 시각이 우연히 결정한다.** 09:00에 고정하는
// 수단이 모델에 없다.
//
// 이 시험은 그것을 **값으로** 보여 준다. 고치지 않는다 — 시각 앵커를
// 넣는 것은 진입 정책 변경이라 승인 사항이다. 여기서는 "cron을 09:00으로
// 바꾸면 해결된다"는 오해를 막는 것이 목적이다.

import { test, eq, assert } from '../../test/harness';
import { dueCheck, nextEvaluationAtMs } from './evaluationLoop';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** UTC 기준 그 순간의 KST 시:분 */
function kst(ms: number): string {
  const d = new Date(ms + 9 * HOUR);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * 폴러를 돌려서 **실제로 평가가 일어난 순간들**을 모은다.
 *
 * 폴러는 `pollEveryMs`마다 와서 `dueCheck`를 묻고, due면 그 순간을
 * `last_run_at`으로 적는다(`claimSchedule`과 같은 동작).
 */
function simulate(i: {
  startMs: number;
  days: number;
  pollEveryMs: number;
  intervalMin: number;
  lastRunAtMs: number | null;
  /** 평가 1회가 last_run_at에 더하는 지연 — #583이 고친 드리프트 */
  perCycleDelayMs?: number;
}): number[] {
  const fires: number[] = [];
  let last = i.lastRunAtMs;
  const end = i.startMs + i.days * DAY;
  for (let now = i.startMs; now <= end; now += i.pollEveryMs) {
    const v = dueCheck({
      nowMs: now, enabled: true, connectionId: 'c',
      lastRunAtMs: last == null ? null : new Date(last).toISOString(),
      intervalMin: i.intervalMin,
    });
    if (v.due) {
      fires.push(now);
      last = now + (i.perCycleDelayMs ?? 0);
    }
  }
  return fires;
}

export function runClockAnchorTests() {
  console.log('[시각 앵커 — "9시에 매수"를 표현할 수단이 없다]');

  // ── ① dueCheck에 시각 입력이 없다 ──
  test('★ dueCheck는 하루 중 몇 시인지를 입력으로 받지 않는다', () => {
    // 같은 간격, 같은 "지난 시간". 벽시계만 12시간 다르다.
    const base = Date.UTC(2026, 10, 6, 0, 0, 0);
    const a = dueCheck({
      nowMs: base, enabled: true, connectionId: 'c',
      lastRunAtMs: new Date(base - 61 * MIN).toISOString(), intervalMin: 60,
    });
    const b = dueCheck({
      nowMs: base + 12 * HOUR, enabled: true, connectionId: 'c',
      lastRunAtMs: new Date(base + 12 * HOUR - 61 * MIN).toISOString(), intervalMin: 60,
    });
    // 벽시계가 00:00이든 12:00이든 판정이 똑같다 — 시각은 보지 않는다.
    eq(a.due, b.due);
    eq(a.code, b.code);
    eq(a.code, 'DUE');
  });

  // ── ② 진입 시각은 last_run_at의 위상이 정한다 ──
  test('★ 같은 간격이라도 last_run_at이 다르면 다른 시각에 진입한다', () => {
    const d0 = Date.UTC(2026, 10, 6, 0, 0, 0);
    // 둘 다 하루 간격(1440분). 하나는 00:00 KST(=전날 15:00Z)에 마지막
    // 실행, 하나는 09:00 KST(=00:00Z)에.
    const A = simulate({
      startMs: d0, days: 3, pollEveryMs: 15 * MIN, intervalMin: 1440,
      lastRunAtMs: Date.UTC(2026, 10, 5, 15, 0, 0),
    });
    const B = simulate({
      startMs: d0, days: 3, pollEveryMs: 15 * MIN, intervalMin: 1440,
      lastRunAtMs: Date.UTC(2026, 10, 6, 0, 0, 0) - 1,
    });
    assert(A.length >= 2 && B.length >= 2, '둘 다 여러 번 돌아야 한다');
    // **시각이 다르다.** 모델에 09:00을 지정할 자리가 없기 때문이다.
    assert(kst(A[0]) !== kst(B[0]),
      `위상이 다르면 시각이 달라야 한다 — A=${kst(A[0])} B=${kst(B[0])}`);
  });

  test('★ 하루 간격이면 진입 시각은 last_run_at의 시각을 그대로 따른다', () => {
    // 마지막 실행이 03:17 KST였다면 다음 진입도 03:17 KST 근처다.
    // 09:00을 원해도 그 값을 넣을 입력이 없다.
    const last = Date.UTC(2026, 10, 5, 18, 17, 0); // = 03:17 KST
    const fires = simulate({
      startMs: Date.UTC(2026, 10, 6, 0, 0, 0), days: 4,
      pollEveryMs: 15 * MIN, intervalMin: 1440, lastRunAtMs: last,
    });
    assert(fires.length >= 3, `여러 번 돌아야 한다 (${fires.length})`);
    for (const f of fires) {
      const [h] = kst(f).split(':').map(Number);
      // 폴러가 15분마다이므로 최대 15분 늦을 수 있다 — 시(hour)는 03이다.
      eq(h, 3);
    }
  });

  // ── ③ 더 자주 물어봐도 진입 시각은 안 움직인다 ──
  test('★ 폴링을 15분에서 1분으로 바꿔도 진입 시각은 거의 같다', () => {
    const last = Date.UTC(2026, 10, 5, 18, 0, 0);
    const start = Date.UTC(2026, 10, 6, 0, 0, 0);
    const slow = simulate({ startMs: start, days: 3, pollEveryMs: 15 * MIN, intervalMin: 1440, lastRunAtMs: last });
    const fast = simulate({ startMs: start, days: 3, pollEveryMs: MIN, intervalMin: 1440, lastRunAtMs: last });
    eq(slow.length, fast.length);
    // 자주 물어보면 더 정확히 그 시각에 맞지만, **다른 시각이 되지는 않는다.**
    assert(Math.abs(slow[0] - fast[0]) <= 15 * MIN, '같은 시각 근처여야 한다');
    eq(kst(fast[0]), '03:00');
  });

  test('★ cron 시각을 08:00에서 09:00으로 바꿔도 진입 시각은 바뀌지 않는다', () => {
    // 하루 1회 폴러를 23:00Z(08:00 KST)와 00:00Z(09:00 KST)로 각각 둔다.
    // 간격 60분 예약이면 **어느 쪽이든 폴러가 온 그 순간** 진입한다 —
    // 즉 진입 시각을 정하는 것은 예약이 아니라 폴러다. 그런데 지금은
    // 폴러가 15분마다 오므로, cron 한 줄을 고치는 것은 아무 효과가 없다.
    const start = Date.UTC(2026, 10, 6, 0, 0, 0);
    const last = Date.UTC(2026, 10, 5, 20, 33, 0);
    const every15 = simulate({ startMs: start, days: 2, pollEveryMs: 15 * MIN, intervalMin: 60, lastRunAtMs: last });
    // 15분 폴러 + 60분 간격이면 하루에 24번 가까이 돈다.
    assert(every15.length >= 20, `하루 간격이 아니라 매시간이다 (${every15.length}회/2일)`);
    // 그 시각들은 09:00에 몰려 있지 않다 — 하루 종일 퍼져 있다.
    const hours = new Set(every15.map((f) => kst(f).split(':')[0]));
    assert(hours.size >= 10,
      `진입이 하루 전체에 퍼져 있어야 한다 — 실제 ${hours.size}개 시간대`);
  });

  // ── ④ 위상 드리프트 — 그리고 폴링 그리드가 그것을 증폭한다 ──
  //
  // **여기서 예상보다 큰 것을 발견했다.** `last_run_at`에 평가 시간이
  // 더해지면(#583이 고친 동작) 다음 due가 폴링 눈금을 **막 지나친**
  // 자리에 떨어진다. 그러면 다음 눈금까지 기다리므로, **22.5초 지연이
  // 폴링 간격 하나(15분)만큼의 드리프트가 된다 — 약 40배 증폭이다.**
  //
  // 시뮬레이션 측정값(40일, 간격 1440분):
  //   지연 0    · 폴 15분 → 평균 1440.00분 (+0.00)
  //   지연 22.5초 · 폴 15분 → 평균 1455.00분 (+15.00)  ← 지연이 아니라 폴링 간격만큼
  //   지연 22.5초 · 폴 1분  → 평균 1441.00분 (+1.00)   ← 폴링을 줄이면 드리프트도 줄어든다
  //
  // 이것은 **시뮬레이션**이다. 운영에서 제가 실측한 드리프트(약 9.6초/회)
  // 보다 크다 — 실제 폴러는 고정 눈금이 아니라 작업 후 sleep이므로
  // 눈금 자체가 함께 밀린다. 그래서 여기 숫자를 운영 수치로 주장하지
  // 않는다. 고정하는 것은 **기전**이다: 지연이 폴링 간격으로 증폭된다.
  test('★ 지연이 없으면 진입 시각이 고정된다', () => {
    const fires = simulate({
      startMs: Date.UTC(2026, 10, 1, 0, 0, 0), days: 40,
      pollEveryMs: 15 * MIN, intervalMin: 1440,
      lastRunAtMs: Date.UTC(2026, 9, 30, 18, 0, 0), perCycleDelayMs: 0,
    });
    assert(fires.length >= 40, `충분히 돌아야 한다 (${fires.length})`);
    // 처음과 끝의 시각이 같다 — 위상이 유지된다.
    eq(kst(fires[0]), kst(fires[fires.length - 1]));
  });

  test('★ 지연이 있으면 드리프트가 **폴링 간격**만큼 생긴다 (지연 크기가 아니다)', () => {
    const start = Date.UTC(2026, 10, 1, 0, 0, 0);
    const last = Date.UTC(2026, 9, 30, 18, 0, 0);
    const avgGapMin = (f: number[]) =>
      f.slice(1).reduce((a, x, i) => a + (x - f[i]) / MIN, 0) / Math.max(1, f.length - 1);

    const slowPoll = simulate({
      startMs: start, days: 40, pollEveryMs: 15 * MIN, intervalMin: 1440,
      lastRunAtMs: last, perCycleDelayMs: 22_500,
    });
    const fastPoll = simulate({
      startMs: start, days: 40, pollEveryMs: MIN, intervalMin: 1440,
      lastRunAtMs: last, perCycleDelayMs: 22_500,
    });

    // 22.5초 지연인데 15분 폴링에서는 간격이 15분 늘어난다.
    eq(Math.round(avgGapMin(slowPoll) - 1440), 15);
    // 같은 22.5초 지연인데 1분 폴링에서는 1분만 늘어난다.
    eq(Math.round(avgGapMin(fastPoll) - 1440), 1);
    // 즉 드리프트의 크기를 정하는 것은 지연이 아니라 폴링 간격이다.
    assert(avgGapMin(slowPoll) > avgGapMin(fastPoll),
      '폴링이 드물수록 드리프트가 커야 한다');
  });

  test('★ 드리프트가 쌓이면 같은 창에서 발사 횟수가 줄어든다', () => {
    const start = Date.UTC(2026, 10, 1, 0, 0, 0);
    const last = Date.UTC(2026, 9, 30, 18, 0, 0);
    const clean = simulate({
      startMs: start, days: 40, pollEveryMs: 15 * MIN, intervalMin: 1440,
      lastRunAtMs: last, perCycleDelayMs: 0,
    });
    const drift = simulate({
      startMs: start, days: 40, pollEveryMs: 15 * MIN, intervalMin: 1440,
      lastRunAtMs: last, perCycleDelayMs: 22_500,
    });
    // 한 주기가 길어지므로 같은 40일에 **덜** 돈다 — 진입 기회를 잃는다.
    assert(drift.length < clean.length,
      `드리프트가 있으면 덜 돌아야 한다 — clean=${clean.length} drift=${drift.length}`);
    // 그리고 시각이 크게 밀린다 (09:00 → 18:45).
    assert(kst(drift[drift.length - 1]) !== kst(clean[clean.length - 1]),
      '시각이 밀려야 한다');
  });

  // ── ⑤ nextEvaluationAtMs도 시각을 모른다 ──
  test('nextEvaluationAtMs는 간격만 더한다 — 시각으로 맞추지 않는다', () => {
    const last = Date.UTC(2026, 10, 6, 18, 37, 0);
    const next = nextEvaluationAtMs({
      lastRunAtMs: new Date(last).toISOString(), intervalMin: 1440,
    });
    eq(next, last + DAY);
    // 09:00 KST(= 00:00Z)로 당겨지지 않는다. 18:37Z 그대로 하루 뒤다.
    eq(kst(next as number), '03:37');
  });
}
