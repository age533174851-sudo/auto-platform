// src/lib/autotrade/waitingRepro.test.ts
//
// **#450: 틱 로그가 매번 `WAITING`인 이유를 값으로 가린다.**
//
// 관측 (autotrade-tick 워크플로 실행 19회, 2026-11-01 ~ 11-05 전수)
// ─────────────────────────────────────────────────────────────────
// 19회 **전부** `{"skipped":true,"code":"WAITING"}`였다. 그런데 응답에는
// 코드만 있는 것이 아니다 — `detail`에 **남은 분(leftMin)**이 적혀 있다.
// 그 숫자가 이 파일의 자료다. 코드만 보면 간격을 알 수 없지만, 남은
// 분을 보면 간격이 드러난다.
//
//   dueCheck: leftMin = ceil((interval*60000 - (now - last_run_at)) / 60000)
//                       ^ 간격과 마지막 평가 시각이 둘 다 들어 있다
//
// 자료 출처 (GitHub Actions 실행 id · 응답 본문의 detail)
// ─────────────────────────────────────────────────────
//   41257640396 11-01T00:38:45 20분   41860796038 11-04T15:44:07 48분
//   41282291648 11-01T06:48:32 13분   41916559109 11-04T21:29:31  6분
//   41313345808 11-01T13:52:24 11분   41949913599 11-05T01:38:52 59분
//   41337639048 11-01T18:38:20 26분   41994727676 11-05T08:28:31 10분
//   41356899252 11-01T22:23:39 41분   42066545191 11-05T16:38:44  2분
//   41373359600 11-02T01:36:31 30분   41753308286 11-04T01:20:00  6분
//   41411620289 11-02T08:14:47 54분   41793516645 11-04T07:37:08 51분
//   41499718526 11-02T18:21:05 50분   41664728523 11-03T15:31:19 49분
//   41557365166 11-03T01:05:16  8분   41719951386 11-03T21:14:23  8분
//   41599197351 11-03T07:52:39 25분
//
// 모델은 최소다
// ─────────────
//   · 시계는 고정 배열(FakeClock) — `Date.now()`를 쓰면 시험이 흔들린다
//   · DB는 `last_run_at` 한 칸(FakeDB)
//   · 판정은 **정본 `dueCheck`를 그대로 부른다.** 여기서 다시 쓰면
//     재현이 코드가 아니라 내 상상을 시험한다
//
// 선점 규칙도 정본과 같다: `due.due === true`일 때만 `last_run_at`을
// 쓴다 (`evaluationRunner.ts:322` `if (!due.due) return` + `claimSchedule`).

import { test, eq, assert } from '../../test/harness';
import { dueCheck, MIN_GAP_MS } from './evaluationLoop';

const MIN = 60_000;

/** 실측: 틱 시각(UTC) · 그 틱이 받은 leftMin */
const OBS: { t: number; left: number }[] = [
  ['2026-11-01T00:38:45.572Z', 20], ['2026-11-01T06:48:32.905Z', 13],
  ['2026-11-01T13:52:24.094Z', 11], ['2026-11-01T18:38:20.405Z', 26],
  ['2026-11-01T22:23:39.284Z', 41], ['2026-11-02T01:36:31.642Z', 30],
  ['2026-11-02T08:14:47.210Z', 54], ['2026-11-02T18:21:05.862Z', 50],
  ['2026-11-03T01:05:16.887Z',  8], ['2026-11-03T07:52:39.053Z', 25],
  ['2026-11-03T15:31:19.644Z', 49], ['2026-11-03T21:14:23.769Z',  8],
  ['2026-11-04T01:20:00.569Z',  6], ['2026-11-04T07:37:08.023Z', 51],
  ['2026-11-04T15:44:07.532Z', 48], ['2026-11-04T21:29:31.800Z',  6],
  ['2026-11-05T01:38:52.767Z', 59], ['2026-11-05T08:28:31.626Z', 10],
  ['2026-11-05T16:38:44.587Z',  2],
].map(([iso, left]) => ({ t: Date.parse(String(iso)), left: Number(left) }));

const TICKS = OBS.map(o => o.t);
/** 폴러 타임라인의 시작 — 첫 틱보다 하루 앞 */
const START = Date.parse('2026-10-31T00:00:00Z');

/**
 * `last_run_at` 한 칸을 가진 FakeDB + 정본 판정으로 한 회차를 돌린다.
 *
 * **쓰기는 due 일 때만** — 정본 `evaluateIfDue`와 같다. 건너뜀에서 쓰면
 * 간격이 매번 갱신돼 영원히 안 돈다(코드가 이미 막고 있고, 이 모델도 같다).
 */
function poll(db: { lastRunAtMs: number | null }, nowMs: number, intervalMin: number | null) {
  const v = dueCheck({ nowMs, enabled: true, lastRunAtMs: db.lastRunAtMs, intervalMin });
  if (v.due) db.lastRunAtMs = nowMs;   // 선점 성공 = CAS 통과
  return v;
}

/** 틱만 도는 경우, 틱이 본 판정들 */
function ticksOnly(intervalMin: number | null, startLastRunAtMs: number | null) {
  const db = { lastRunAtMs: startLastRunAtMs };
  return TICKS.map(t => poll(db, t, intervalMin));
}

/**
 * **틱 + 더 자주 도는 선점자.** 틱이 본 판정들만 돌려준다.
 *
 * 선점자는 `pollSec`마다 보고, 자기 차례면 선점한다. 위상(`phaseSec`)은
 * 모르는 값이라 시험이 전부 훑는다 — 하나를 골라 맞추면 그건 재현이
 * 아니라 맞춤이다.
 */
function withClaimer(intervalMin: number, pollSec: number, phaseSec: number) {
  const db = { lastRunAtMs: null as number | null };
  const events: { at: number; who: 'tick' | 'claimer' }[] = [];
  for (const t of TICKS) events.push({ at: t, who: 'tick' });
  for (let t = START + phaseSec * 1000; t <= TICKS[TICKS.length - 1] + MIN; t += pollSec * 1000) {
    events.push({ at: t, who: 'claimer' });
  }
  events.sort((a, b) => a.at - b.at || (a.who === 'claimer' ? -1 : 1));
  const seen: ReturnType<typeof dueCheck>[] = [];
  for (const e of events) {
    const v = poll(db, e.at, intervalMin);
    if (e.who === 'tick') seen.push(v);
  }
  return seen;
}

/**
 * 간격 I를 가정했을 때 이 틱이 말하는 `last_run_at` 구간.
 *
 * leftMin = ceil((I*60000 - since)/60000) 이므로
 *   since ∈ [ (I-leftMin)*60000, (I-leftMin+1)*60000 )
 */
function lastRunAtWindow(intervalMin: number, o: { t: number; left: number }) {
  return {
    lo: o.t - (intervalMin - o.left + 1) * MIN + 1,
    hi: o.t - (intervalMin - o.left) * MIN,
  };
}

export function runWaitingReproTests() {
  console.log('[#450 — 틱이 매번 WAITING 인 이유를 leftMin 으로 가리기]');

  test('모델이 정본과 같다 — 건너뜀은 last_run_at 을 안 건드린다', () => {
    const db = { lastRunAtMs: TICKS[0] };
    poll(db, TICKS[0] + 10 * MIN, 60);          // 10분 뒤 = WAITING
    eq(db.lastRunAtMs, TICKS[0], '건너뛰었는데 시각이 갱신됐다');
  });

  // ── ① 자료 자체의 사실 ──

  test('관측 19회는 전부 WAITING 이고, leftMin 은 하나도 59분을 넘지 않는다', () => {
    eq(OBS.length, 19);
    const max = Math.max(...OBS.map(o => o.left));
    const min = Math.min(...OBS.map(o => o.left));
    eq(max, 59, `leftMin 최대 ${max}분`);
    assert(min >= 1, `leftMin 최소 ${min}분 — 0이면 DUE 였을 것이다`);
  });

  test('관측 구간은 4.7일이다 — 틱은 평균 5.9시간에 한 번만 왔다', () => {
    const spanMin = Math.round((TICKS[TICKS.length - 1] - TICKS[0]) / MIN);
    eq(spanMin, 6720, '관측 구간(분)');
    const gapH = spanMin / (OBS.length - 1) / 60;
    assert(gapH > 5.8 && gapH < 6.3, `틱 평균 간격 ${gapH.toFixed(1)}시간`);
  });

  // ── ② leftMin 이 간격의 하한을 준다 ──

  test('**leftMin 59분이 관측됐다 → 간격은 59분 이상이다**', () => {
    // leftMin = ceil(I - since/분) 이고 since ≥ MIN_GAP 이므로 leftMin ≤ I.
    // 즉 관측된 leftMin 의 최대값이 간격의 하한이다.
    eq(MIN_GAP_MS, 60_000, '최소 간격 방어 1분');
    const lower = Math.max(...OBS.map(o => o.left));
    eq(lower, 59);
    for (const I of [1, 15, 30, 58]) {
      const over = OBS.filter(o => o.left > I);
      assert(over.length > 0, `간격 ${I}분이면 leftMin ${over.length}개가 범위를 넘는다`);
    }
  });

  test('**간격 60분이면 leftMin 의 가능 범위는 1..59 — 관측이 꼭 들어맞는다**', () => {
    // since ∈ [1분, 60분) → leftMin = ceil(60 - since/분) ∈ [1, 59]
    assert(OBS.every(o => o.left >= 1 && o.left <= 59),
      `범위를 벗어난 값: ${OBS.filter(o => o.left < 1 || o.left > 59).map(o => o.left).join(',')}`);
  });

  // ── ③ 틱 단독으로는 관측이 안 된다 ──

  test('틱 단독 · 간격 60분: 19회 전부 DUE 다 — 관측과 정반대다', () => {
    const codes = ticksOnly(60, TICKS[0] - 10 * 60 * MIN).map(v => v.code);
    eq(codes.filter(c => c === 'DUE').length, 19, codes.join(','));
    eq(codes.filter(c => c === 'WAITING').length, 0);
  });

  test('틱 단독이면 간격이 아무리 커도 첫 회차는 DUE 또는 FIRST 다', () => {
    for (const iv of [60, 300, 1440, 10080]) {
      eq(ticksOnly(iv, null)[0].code, 'FIRST', `간격 ${iv}: 기록이 없으면 첫 평가다`);
      eq(ticksOnly(iv, TICKS[0] - (iv + 1) * MIN)[0].code, 'DUE', `간격 ${iv}: 간격이 지났으면 DUE 다`);
    }
  });

  test('**틱 단독으로 19회 전부 WAITING 이 되려면 간격이 6721분(4.7일) 넘어야 한다**', () => {
    const start = TICKS[0] - 10 * MIN;        // MIN_GAP 밖 · 간격 안
    let boundary: number | null = null;
    for (let iv = 60; iv <= 20160; iv += 1) {
      if (ticksOnly(iv, start).every(v => v.code === 'WAITING')) { boundary = iv; break; }
    }
    assert(boundary != null, '전부 WAITING 이 되는 간격이 없다');
    const spanMin = Math.round((TICKS[TICKS.length - 1] - TICKS[0]) / MIN);
    assert((boundary as number) > spanMin, `최소 간격 ${boundary}분 · 관측 구간 ${spanMin}분`);
    // 그런데 그 간격이면 leftMin 이 6000분대로 적힌다. 관측은 59분이
    // 최대다 — **틱 단독 가설은 leftMin 이 배제한다.**
    const codes = ticksOnly(boundary as number, start);
    const modelMax = Math.max(...codes.map(v => v.leftMin ?? 0));
    assert(modelMax > 1000, `모델 leftMin 최대 ${modelMax}분`);
    assert(modelMax > Math.max(...OBS.map(o => o.left)) * 10,
      '틱 단독 가설의 leftMin 은 관측보다 자릿수가 다르다');
  });

  // ── ④ 재현: 더 자주 도는 선점자 + 간격 60분 ──

  test('**간격 60분 + 60초마다 보는 선점자: 위상 60개 전부에서 19회 모두 WAITING**', () => {
    let all = 0;
    for (let ph = 0; ph < 60; ph += 1) {
      const seen = withClaimer(60, 60, ph);
      eq(seen.length, 19);
      if (seen.every(v => v.code === 'WAITING')) all += 1;
    }
    eq(all, 60, '위상에 상관없이 재현돼야 한다 — 하나만 맞으면 맞춤이다');
  });

  test('**그 모델의 leftMin 범위가 관측과 같은 자릿수다**', () => {
    let modelMax = 0, modelMin = Infinity;
    for (let ph = 0; ph < 60; ph += 1) {
      for (const v of withClaimer(60, 60, ph)) {
        modelMax = Math.max(modelMax, v.leftMin ?? 0);
        modelMin = Math.min(modelMin, v.leftMin ?? 0);
      }
    }
    assert(modelMax <= 59 && modelMax >= 50, `모델 leftMin 최대 ${modelMax}분`);
    assert(modelMin >= 1, `모델 leftMin 최소 ${modelMin}분`);
  });

  test('선점자 주기가 간격보다 길면 틱도 통과한다 — 아무 폴러나 범인이 아니다', () => {
    // 간격 60분 · 선점자가 6시간마다 → 창이 비는 틱이 생긴다
    let someDue = 0;
    for (let ph = 0; ph < 360; ph += 37) {
      if (withClaimer(60, 6 * 3600, ph).some(v => v.code === 'DUE')) someDue += 1;
    }
    assert(someDue > 0, '선점자가 드물면 틱이 통과하는 회차가 있어야 한다');
  });

  // ── ⑤ 기본값 1440분은 leftMin 이 배제한다 ──

  test('**간격 1440분(기본값)은 같은 모델에서 leftMin 1400분대를 만든다 — 관측과 다르다**', () => {
    let modelMax = 0;
    for (let ph = 0; ph < 60; ph += 1) {
      for (const v of withClaimer(1440, 60, ph)) modelMax = Math.max(modelMax, v.leftMin ?? 0);
    }
    assert(modelMax > 1300, `모델 leftMin 최대 ${modelMax}분`);
    // 관측 19개가 전부 59분 이하일 확률은 (59/1440)^19 ≈ 0 이다.
    const obsMax = Math.max(...OBS.map(o => o.left));
    assert(obsMax * 20 < modelMax, `관측 최대 ${obsMax}분 · 모델 최대 ${modelMax}분`);
  });

  test('간격 1440분 가정은 **자기모순이다** — 같은 날에 선점이 세 번 필요해진다', () => {
    // 1440분 간격이면 선점은 하루 한 번만 가능하다. 그런데 leftMin 을
    // 1440 으로 역산하면 11-01 하루에 세 개의 서로 다른 last_run_at 이
    // 나온다 — 간격 1440분과 양립할 수 없다.
    const sameDay = OBS.slice(0, 3).map(o => lastRunAtWindow(1440, o));
    const mids = sameDay.map(w => (w.lo + w.hi) / 2);
    for (let i = 1; i < mids.length; i += 1) {
      const gapMin = Math.abs(mids[i] - mids[i - 1]) / MIN;
      assert(gapMin < 1440,
        `역산한 두 선점이 ${Math.round(gapMin)}분 차이 — 1440분 간격이면 불가능해야 한다`);
    }
  });

  // ── ⑥ 역산한 last_run_at 이 한 선점자를 가리킨다 ──

  test('**간격 60분으로 역산하면 선점 시각이 매시 같은 위상에 모인다**', () => {
    const phases = OBS.map(o => {
      const w = lastRunAtWindow(60, o);
      const mid = (w.lo + w.hi) / 2;
      return ((mid % (60 * MIN)) + 60 * MIN) % (60 * MIN) / 1000;   // 초
    });
    // 원형 자료다 — 가장 좁은 호의 폭을 본다
    const sorted = [...phases].sort((a, b) => a - b);
    let arc = Infinity;
    for (const lo of sorted) {
      arc = Math.min(arc, Math.max(...sorted.map(x => ((x - lo) % 3600 + 3600) % 3600)));
    }
    // 4.7일 동안 위상이 2500초 안에 머문다 = 선점자가 하나이고 그 주기가
    // 간격과 같다. 서로 무관한 폴러가 둘이면 위상이 3600초를 다 채운다.
    assert(arc < 2600, `위상 폭 ${Math.round(arc)}초`);
  });

  test('**그 위상이 단조 전진한다 — 간격이 설정값보다 조금씩 길어진다**', () => {
    const phases = OBS.map(o => {
      const w = lastRunAtWindow(60, o);
      return ((w.lo + w.hi) / 2 % (60 * MIN) + 60 * MIN) % (60 * MIN) / 1000;
    });
    // 첫 관측 58:15 → 마지막 40:14 (한 바퀴 안에서 전진)
    let advances = 0;
    for (let i = 1; i < phases.length; i += 1) {
      if (((phases[i] - phases[i - 1]) % 3600 + 3600) % 3600 < 1800) advances += 1;
    }
    eq(advances, phases.length - 1, '위상이 뒤로 간 구간이 있다 — 단조가 아니다');
    const claims = Math.round((TICKS[TICKS.length - 1] - TICKS[0]) / (60 * MIN));
    const total = ((phases[phases.length - 1] - phases[0]) % 3600 + 3600) % 3600;
    const perClaim = total / claims;
    assert(claims > 100, `선점 ${claims}회`);
    assert(perClaim > 10 && perClaim < 60,
      `선점 1회당 ${perClaim.toFixed(1)}초 밀림 — 폴링 주기(60초) 안이다`);
  });

  // ── ⑦ 그 밀림의 산수: 기록이 선점 시각을 덮어쓴다 ──
  //
  // `evaluateIfDue`는 `last_run_at`을 **두 번** 쓴다.
  //   선점   `claimSchedule`      → new Date(nowMs)      (폴링 시각)
  //   기록   `recordEvaluation`   → new Date()           (전략 호출이 끝난 시각)
  // 뒤쪽이 앞쪽을 덮으므로 다음 창은 `설정 간격 + 평가 소요시간` 뒤에
  // 열린다. 회차마다 누적된다.

  /** 선점 후 기록이 `+evalMs` 뒤를 적는 모델. N회차의 선점 시각을 돌려준다 */
  function claimTimes(intervalMin: number, evalMs: number, cycles: number, recordAfterClaim: boolean) {
    const db = { lastRunAtMs: null as number | null };
    const out: number[] = [];
    // 1초마다 보는 선점자 — 양자화를 없애고 밀림만 남긴다
    for (let t = START; out.length < cycles; t += 1000) {
      const v = dueCheck({ nowMs: t, enabled: true, lastRunAtMs: db.lastRunAtMs, intervalMin });
      if (!v.due) continue;
      db.lastRunAtMs = t;                                   // claimSchedule
      out.push(t);
      db.lastRunAtMs = recordAfterClaim ? t + evalMs : t;    // recordEvaluation
    }
    return out;
  }

  test('**지금 동작: 기록이 평가 종료 시각을 적으면 N회차에 N×평가시간 밀린다**', () => {
    const evalMs = 22_000;
    const t = claimTimes(60, evalMs, 11, true);
    const first = t[1] - t[0];
    const tenth = t[10] - t[0];
    // 10회차면 10×(60분 + 22초)
    eq(Math.round(first / 1000), 60 * 60 + 22, '한 회차 간격(초)');
    eq(Math.round(tenth / 1000), 10 * (60 * 60 + 22), '10회차 누적(초)');
    const slipMin = (tenth - 10 * 60 * MIN) / MIN;
    assert(slipMin > 3, `10회차에 ${slipMin.toFixed(1)}분 밀렸다`);
  });

  test('**고친 동작: 기록이 선점 시각을 적으면 간격이 설정값 그대로다**', () => {
    const t = claimTimes(60, 22_000, 11, false);
    eq(Math.round((t[1] - t[0]) / 1000), 60 * 60, '한 회차 간격(초)');
    eq(Math.round((t[10] - t[0]) / 1000), 10 * 60 * 60, '10회차 누적(초)');
  });

  test('관측된 밀림(선점 1회당 22.5초)이 그 산수와 같은 크기다', () => {
    // 112회 선점 동안 42분이 밀렸다. 회차당 22.5초.
    const claims = Math.round((TICKS[TICKS.length - 1] - TICKS[0]) / (60 * MIN));
    const t = claimTimes(60, 22_500, claims + 1, true);
    const slipMin = (t[claims] - t[0] - claims * 60 * MIN) / MIN;
    assert(slipMin > 35 && slipMin < 50, `모델 누적 밀림 ${slipMin.toFixed(1)}분 (관측 약 42분)`);
  });

  // ── 남는 것 ──
  //
  // 이 파일이 **못** 말하는 것:
  //   · `interval_min`의 **저장된 값**. leftMin 이 하한 59분을 주고 60분이
  //     범위에 꼭 맞지만, 이 세션은 운영 DB 를 읽을 수 없다. 60분은
  //     **추정**이고 그 확인은 #581 화면이 한다.
  //   · 선점자가 **어느 것인지.** 코드에 후보가 셋 있다 —
  //     Fly Worker(`worker/src/index.ts:586`, `POLL_INTERVAL_MS` 60초),
  //     Vercel 크론(`vercel.json` `0 23 * * *`, 하루 1회),
  //     화면(`AutotradeControl.tsx:393`·`LeftRail.tsx:47`).
  //     주기가 60초인 것은 Worker 하나뿐이고 역산한 위상 폭이 그것과
  //     맞지만, 운영에서 어느 것이 썼는지는 `last_decision.source`에
  //     있고 그 칸은 여기서 못 읽는다 — **UNKNOWN 이다.**
}
