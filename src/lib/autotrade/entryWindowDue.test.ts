// src/lib/autotrade/entryWindowDue.test.ts
//
// 막으려는 것:
//  1. **09:10~09:30 창을 간격 위상이 먹는 것** — 간격 60분이면 평가는
//     매시 같은 분에 한 번 오고, 그 분이 창 밖이면 그날 진입은 사라지거나
//     30분 늦는다. 실측(2026-10-20)에서 워커 위상은 :39~:42였다
//  2. 창을 근거로 깨우면서 **창 안에서 매 분 깨우는 것** — 50분짜리
//     유예 창에서 평가가 50번 돈다. egress 할당량이 터진 참이다
//  3. 한국 시각을 못 읽은 것을 '창 밖'으로 적는 것
//  4. 예약을 **못 읽은 것**을 '예약 0건'으로 적는 것
import { test, assert, eq } from '../../test/harness';
import { entryWindowOf, windowDueVerdict } from './entryWindowDue';
import { dueCheck } from './evaluationLoop';
import { scheduleReadSummary } from './scheduleReadSummary';

const MIN = 60_000;
/** 그 한국시각(같은 날)의 UTC epoch. KST = UTC+9, 서머타임 없음 */
const kst = (hh: number, mm: number) => Date.UTC(2026, 9, 26, hh - 9, mm, 0);
const W = entryWindowOf('my-original-v1');

export function runEntryWindowDueTests() {
  console.log('[9시 진입 창 — 간격 위상이 창을 먹지 않는다]');

  // ── 창 표 ────────────────────────────────────────
  test('창은 전략 정본에서 온다 (09:10~09:30 · 유예 30분)', () => {
    assert(W != null, '창이 없다');
    eq(W!.startMin, 9 * 60 + 10);
    eq(W!.endMin, 9 * 60 + 30);
    eq(W!.graceMin, 30);
  });

  test('창이 없는 전략은 null — 이 판정이 끼어들지 않는다', () => {
    eq(entryWindowOf('daily-ladder'), null);
    eq(entryWindowOf('scalp'), null);
    eq(entryWindowOf(null), null);
    eq(entryWindowOf(undefined), null);
  });

  // ── 창 판정 ──────────────────────────────────────
  test('★ 창 안이고 오늘 아직 안 봤으면 평가한다', () => {
    const v = windowDueVerdict({ nowMs: kst(9, 15), lastRunAtMs: kst(8, 42), window: W });
    eq(v.code, 'WINDOW_OPEN');
    eq(v.due, true);
  });

  test('★ 유예 안(09:30~10:00)이면 늦었다고 적으면서 평가한다', () => {
    const v = windowDueVerdict({ nowMs: kst(9, 45), lastRunAtMs: kst(8, 42), window: W });
    eq(v.code, 'WINDOW_OPEN');
    eq(v.due, true);
    assert(v.reason.includes('15분'), v.reason);
  });

  test('★★ 창 안에서 한 번 평가한 뒤에는 다시 깨우지 않는다', () => {
    const v = windowDueVerdict({ nowMs: kst(9, 20), lastRunAtMs: kst(9, 12), window: W });
    eq(v.code, 'WINDOW_DONE');
    eq(v.due, false);
  });

  test('★★ 초 단위 차이로 오늘 창을 다시 열지 않는다 (09:10:10 → 09:11:45)', () => {
    // 과거 계산은 nowMs의 :45초를 창 시작에 보존하여 09:10:45로 오판했다.
    // 09:10:10에 이미 평가했어도 WINDOW_OPEN이 다시 나오는 회귀를 잡는다.
    const v = windowDueVerdict({
      nowMs: kst(9, 11) + 45_000,
      lastRunAtMs: kst(9, 10) + 10_000,
      window: W,
    });
    eq(v.code, 'WINDOW_DONE');
    eq(v.due, false);
  });

  test('초 단위 경계: 창 전 09:09:59 평가는 오늘 창 평가로 세지 않는다', () => {
    const v = windowDueVerdict({
      nowMs: kst(9, 11) + 45_000,
      lastRunAtMs: kst(9, 9) + 59_000,
      window: W,
    });
    eq(v.code, 'WINDOW_OPEN');
    eq(v.due, true);
  });

  test('창 전(09:09)은 창 밖이다 — 간격 관문이 판단한다', () => {
    const v = windowDueVerdict({ nowMs: kst(9, 9), lastRunAtMs: kst(8, 42), window: W });
    eq(v.code, 'OUTSIDE');
    eq(v.due, false);
  });

  test('유예까지 지나면(10:01) 창을 근거로 깨우지 않는다', () => {
    const v = windowDueVerdict({ nowMs: kst(10, 1), lastRunAtMs: kst(8, 42), window: W });
    eq(v.code, 'OUTSIDE');
    eq(v.due, false);
  });

  test('★ 한국 시각을 못 읽으면 "창 밖"이 아니라 CLOCK_UNKNOWN이다', () => {
    const v = windowDueVerdict({ nowMs: NaN, lastRunAtMs: kst(8, 42), window: W });
    eq(v.code, 'CLOCK_UNKNOWN');
    eq(v.due, false);
  });

  // ── 배선: dueCheck가 실제로 창을 쓴다 ────────────
  const base = { enabled: true, connectionId: 'c1', intervalMin: 60 };

  test('★★★ 실측 위상(:42) — 간격 60분이면 창을 놓치던 자리에서 깨운다', () => {
    // 2026-10-20 실측: 워커는 08:42 KST에 평가했고, 간격 60분이면
    // 다음은 09:42 — 창(09:30)이 닫힌 뒤다. 창 판정이 09:10에 깨운다.
    const v = dueCheck({
      ...base, nowMs: kst(9, 10), lastRunAtMs: kst(8, 42),
      strategyId: 'my-original-v1',
    } as any);
    eq(v.due, true);
    eq(v.code, 'WINDOW');
  });

  test('★★★ 같은 위상·같은 시각이라도 창 없는 전략은 간격을 따른다', () => {
    // 배선이 모든 전략을 깨우면 계단식이 하루 수십 번 평가된다.
    const v = dueCheck({
      ...base, nowMs: kst(9, 10), lastRunAtMs: kst(8, 42),
      strategyId: 'daily-ladder',
    } as any);
    eq(v.due, false);
    eq(v.code, 'WAITING');
  });

  test('★★ 창으로 깨운 뒤 같은 창에서 또 깨우지 않는다 (매 분 평가 방지)', () => {
    const v = dueCheck({
      ...base, nowMs: kst(9, 25), lastRunAtMs: kst(9, 11),
      strategyId: 'my-original-v1',
    } as any);
    eq(v.due, false);
    assert(v.code === 'WAITING', v.code);
  });

  test('★★ 배선: 95초 뒤 같은 창을 다시 평가하지 않는다', () => {
    // MIN_GAP(1분)은 이미 지났지만 60분 간격은 아직 지나지 않았다.
    // 창 시작을 현재 초로 역산하면 WINDOW가 다시 열리던 경로다.
    const v = dueCheck({
      ...base,
      nowMs: kst(9, 11) + 45_000,
      lastRunAtMs: kst(9, 10) + 10_000,
      strategyId: 'my-original-v1',
    } as any);
    eq(v.due, false);
    eq(v.code, 'WAITING');
  });

  test('★★ 중복 방지(MIN_GAP 1분)가 창 판정보다 먼저다', () => {
    const v = dueCheck({
      ...base, nowMs: kst(9, 15), lastRunAtMs: kst(9, 15) - 20_000,
      strategyId: 'my-original-v1',
    } as any);
    eq(v.due, false);
    eq(v.code, 'TOO_SOON');
  });

  test('창 밖에서는 기존 간격 판정 그대로다 — 더하기만 한다', () => {
    const a = dueCheck({ ...base, nowMs: kst(14, 0), lastRunAtMs: kst(13, 30),
      strategyId: 'my-original-v1' } as any);
    const b = dueCheck({ ...base, nowMs: kst(14, 0), lastRunAtMs: kst(13, 30) } as any);
    eq(a.code, b.code);
    eq(a.due, b.due);
    eq(a.due, false);
  });

  test('꺼진 예약은 창이 열려도 깨우지 않는다', () => {
    const v = dueCheck({ ...base, enabled: false, nowMs: kst(9, 15),
      lastRunAtMs: kst(8, 42), strategyId: 'my-original-v1' } as any);
    eq(v.due, false);
    eq(v.code, 'OFF');
  });

  test('연결이 없으면 창이 열려도 깨우지 않는다', () => {
    const v = dueCheck({ ...base, connectionId: '', nowMs: kst(9, 15),
      lastRunAtMs: kst(8, 42), strategyId: 'my-original-v1' } as any);
    eq(v.due, false);
    eq(v.code, 'NO_CONNECTION');
  });

  // ── 경계 전수: 09:00 · 09:09 · 09:10 · 09:30 · 09:31 ──
  //
  // **09:00은 이 전략의 창이 아니다.** `my-original-v1`의 창은 09:10에
  // 열린다(`originalV1.ts`의 WINDOW_START_KST). "매일 09:00 매수"는
  // 별도 Draft #386의 Exact100X/scalp 경로(`dailyForcedEntry.ts`,
  // FORCED_ENTRY_START_KST = 09:00)이고 **이 파일과 다른 전략이다.**
  //
  // 둘을 섞어 "9시 매수가 된다"고 적지 않기 위해 경계를 하나씩 못 박는다.
  // 전략 상수는 **건드리지 않는다** — 09:00을 이 전략의 창으로 만드는 것은
  // 진입 정책 변경이고, 별도 승인 없이 할 일이 아니다.

  const atKst = (hh: number, mm: number) =>
    windowDueVerdict({ nowMs: kst(hh, mm), lastRunAtMs: kst(7, 0), window: W });

  test('★★★ 09:00 KST — my-original-v1의 창이 아니다 (창은 09:10)', () => {
    const v = atKst(9, 0);
    eq(v.code, 'OUTSIDE');
    eq(v.due, false);
  });

  test('09:09 KST — 창 1분 전, 아직 아니다', () => {
    const v = atKst(9, 9);
    eq(v.code, 'OUTSIDE');
    eq(v.due, false);
  });

  test('★ 09:10 KST — 창 시작 경계는 포함이다', () => {
    const v = atKst(9, 10);
    eq(v.code, 'WINDOW_OPEN');
    eq(v.due, true);
    assert(!v.reason.includes('분 전에 닫혔'), v.reason);
  });

  test('★ 09:30 KST — 창 끝 경계도 포함이고 늦지 않았다', () => {
    const v = atKst(9, 30);
    eq(v.code, 'WINDOW_OPEN');
    eq(v.due, true);
    assert(!v.reason.includes('분 전에 닫혔'), v.reason);
  });

  test('★ 09:31 KST — 창은 닫혔고 유예 1분째다', () => {
    const v = atKst(9, 31);
    eq(v.code, 'WINDOW_OPEN');
    eq(v.due, true);
    assert(v.reason.includes('1분 전에 닫혔'), v.reason);
  });

  test('10:00 KST — 유예 마지막 분은 아직 포함이다', () => {
    const v = atKst(10, 0);
    eq(v.code, 'WINDOW_OPEN');
    eq(v.due, true);
  });

  // 같은 경계를 **배선된 판정**으로도 본다. 순수 함수만 맞고 배선이
  // 틀리면 운영에서는 여전히 창을 놓친다.
  const bAt = (hh: number, mm: number) => dueCheck({
    enabled: true, connectionId: 'c1', intervalMin: 60,
    nowMs: kst(hh, mm), lastRunAtMs: kst(7, 0), strategyId: 'my-original-v1',
  } as any);

  test('★★ 배선 경계 — 09:00은 WINDOW로 깨우지 않는다', () => {
    const v = bAt(9, 0);
    assert(v.code !== 'WINDOW', `09:00에 WINDOW로 깨웠다: ${v.code}`);
  });

  test('★★ 배선 경계 — 09:10부터 09:31까지는 WINDOW로 깨운다', () => {
    for (const [hh, mm] of [[9, 10], [9, 20], [9, 30], [9, 31]] as const) {
      const v = bAt(hh, mm);
      eq(v.code, 'WINDOW');
      eq(v.due, true);
    }
  });

  // ── 못 읽은 것을 0으로 적지 않는다 ───────────────
  console.log('[예약 읽기 — 못 읽은 것은 0건이 아니다]');

  test('★★★ 읽기 실패는 scheduled=null이다 (0이 아니다)', () => {
    const s = scheduleReadSummary({
      rows: [],
      readError: 'Service for this project is restricted due to the following '
        + 'violations: exceed_egress_quota.',
    });
    eq(s.ok, false);
    eq(s.scheduled, null);
    eq(s.unknown, true);
    assert(s.note.includes('exceed_egress_quota'), s.note);
  });

  test('진짜 0건은 0으로 적는다 — 둘을 섞지 않는다', () => {
    const s = scheduleReadSummary({ rows: [], readError: null });
    eq(s.ok, true);
    eq(s.scheduled, 0);
    eq(s.unknown, false);
    assert(s.note.includes('enabled=true'), s.note);
  });

  test('읽었으면 센 값 그대로다', () => {
    const s = scheduleReadSummary({ rows: [{ id: 1 }, { id: 2 }], readError: null });
    eq(s.ok, true);
    eq(s.scheduled, 2);
    eq(s.unknown, false);
  });

  test('배열이 아닌 응답도 "0건"이 아니다', () => {
    const s = scheduleReadSummary({ rows: null, readError: null });
    eq(s.ok, false);
    eq(s.scheduled, null);
    eq(s.unknown, true);
  });
}
