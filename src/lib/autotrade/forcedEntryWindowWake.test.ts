// src/lib/autotrade/forcedEntryWindowWake.test.ts
//
// **09:00 강제 진입은 "라우트가 불렸을 때"만 판단된다 — 부르는 쪽이 09:00을 모른다.**
//
// #386은 `scalp` 라우트 **안에서** 09:00~09:30 창을 판단한다. 그런데 그
// 라우트를 부를지 말지 정하는 것은 `selectDueSchedules → dueCheck`이고,
// 그쪽은 `last_run_at + interval_min` **위상**만 본다.
//
//   08:42에 평가 · 간격 60분  →  09:00 폴링에서 WAITING
//                             →  다음 평가 09:42 = 창(09:00~09:30) 밖
//
// 그러면 라우트는 그날 창 안에서 **한 번도 불리지 않고**, #386의 판정은
// 돌아 볼 기회조차 없다. 아무 오류도 안 난다.
//
// #441/#442가 같은 문제를 고쳤지만 `entryWindowOf`가 **`my-original-v1`만**
// 돌려주고, 그 창은 09:10이다. 09:00 창은 여전히 비어 있다.
//
// 여기서 확인하는 것은 **스케줄러가 창 안에서 평가 기회를 주는가**까지다.
// 창 안에서 실제로 무엇을 하는지(강제 진입·RISK_VETO·주문)는 #386의
// `forcedEntryRouteIntegration.test.ts`가 이미 덮는다 — 겹쳐 쓰지 않는다.
//
// 막으려는 것:
//  1. 위상이 창을 먹어 그날 라우트가 안 불리는 것
//  2. 창을 열면서 **일반 scalp 예약까지** 깨우는 것 — 강제 진입과 무관한
//     예약이 하루 한 번 더 평가되고, 신호가 있으면 들어간다
//  3. 창 안에서 매 폴링마다 깨우는 것 (중복)
//  4. 창이 닫힌 뒤(09:31~) 뒤늦게 깨우는 것 — 유예 없는 창이다
//  5. TESTNET 외 예약이 이 루프에 들어오는 것
//  6. 창 값을 여기서 다시 적어 #386 정본과 갈리는 것
import { test, assert, eq } from '../../test/harness';
import { entryWindowOf, windowDueVerdict } from './entryWindowDue';
import { dueCheck } from './evaluationLoop';
import { selectDueSchedules } from './schedulePoll';
import {
  FORCED_ENTRY_START_KST, FORCED_ENTRY_WINDOW_MIN,
  FORCED_ENTRY_PROFILE_ID, FORCED_ENTRY_PRESET_ID,
  forcedEntryVerdict,
} from '../strategies/dailyForcedEntry';
import { WINDOW_END_KST, LATE_GRACE_MIN } from '../strategies/originalV1';

/** FakeClock — 그 한국시각(2026-10-26)의 UTC epoch. KST=UTC+9, 서머타임 없음 */
const kst = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 26, hh - 9, mm, ss);

/** 실측에서 나온 모양: 08:42에 평가하고 간격은 60분이다 */
const LAST_RUN = kst(8, 42);

const EXACT100X = { profileId: FORCED_ENTRY_PROFILE_ID, presetId: FORCED_ENTRY_PRESET_ID };

const row = (over: Record<string, any> = {}) => ({
  id: 'sch-1', symbol: 'BTCUSDT', mode: 'TESTNET', enabled: true,
  connection_id: 'conn-1', last_run_at: new Date(LAST_RUN).toISOString(),
  interval_min: 60, strategy_id: 'scalp',
  execution_profile_id: FORCED_ENTRY_PROFILE_ID,
  execution_preset_id: FORCED_ENTRY_PRESET_ID,
  ...over,
});

export function runForcedEntryWindowWakeTests() {
  console.log('[09:00 강제 진입 창 — 부르는 쪽도 창을 안다]');

  // ── 창 값은 #386 정본에서 온다 ───────────────────
  test('★ 창 값을 다시 적지 않는다 — dailyForcedEntry 정본과 같다', () => {
    const w = entryWindowOf('scalp', EXACT100X);
    assert(w != null, '09:00 창이 없다');
    eq(w!.startMin, FORCED_ENTRY_START_KST.hh * 60 + FORCED_ENTRY_START_KST.mm);
    eq(w!.endMin, w!.startMin + FORCED_ENTRY_WINDOW_MIN);
    // #386의 창은 유예가 없다 — 09:30을 넘으면 AFTER_WINDOW다.
    // **그리고 09:30 자체가 이미 AFTER_WINDOW다** (`minute >= endMin`).
    // 그래서 마지막으로 깨우는 분은 endMin이 아니라 그 한 분 전이다.
    eq(w!.closeMin, w!.endMin - 1);
  });

  test('my-original-v1의 09:10 창은 그대로다 — 두 창이 섞이지 않는다', () => {
    const a = entryWindowOf('my-original-v1');
    eq(a!.startMin, 9 * 60 + 10);
    const b = entryWindowOf('scalp', EXACT100X);
    eq(b!.startMin, 9 * 60);
    assert(a!.startMin !== b!.startMin, '두 창이 같아졌다');
  });

  // ── 계약이 없는 scalp는 깨우지 않는다 ────────────
  test('★★★ 일반 scalp 예약은 09:00에 깨우지 않는다 (계약 없음)', () => {
    eq(entryWindowOf('scalp'), null);
    eq(entryWindowOf('scalp', { profileId: 'OTHER', presetId: FORCED_ENTRY_PRESET_ID }), null);
    eq(entryWindowOf('scalp', { profileId: FORCED_ENTRY_PROFILE_ID, presetId: 'OTHER' }), null);
  });

  test('계단식은 창이 없다 — 이 판정이 끼어들지 않는다', () => {
    eq(entryWindowOf('daily-ladder', EXACT100X), null);
  });

  // ── 실측 재현: 08:42 평가 · 간격 60 · 09:00 폴링 ──
  const at = (hh: number, mm: number, ss = 0, over: Record<string, any> = {}) => {
    const r = row(over);
    return dueCheck({
      nowMs: kst(hh, mm, ss), enabled: r.enabled, connectionId: r.connection_id,
      lastRunAtMs: r.last_run_at, intervalMin: r.interval_min,
      strategyId: r.strategy_id,
      profileId: r.execution_profile_id, presetId: r.execution_preset_id,
    } as any);
  };

  test('★★★ 08:42 평가 · 간격 60 · 09:00 폴링 — 평가 기회를 준다', () => {
    const v = at(9, 0);
    eq(v.due, true);
    eq(v.code, 'WINDOW');
  });

  test('★★ 08:59는 아직 창 밖이다 — 간격 판정 그대로', () => {
    const v = at(8, 59);
    eq(v.due, false);
    eq(v.code, 'WAITING');
  });

  // ── 이 단언은 #450에서 **고쳤다** (약화가 아니다) ──
  //
  // 원래 `eq(at(9, 30).code, 'WINDOW')`였다. 그런데 라우트
  // (`forcedEntryVerdict`)는 `minute >= endMin`이라 **09:30을 거부한다.**
  // 즉 이 단언이 지키고 있던 것은 "창이 09:30에도 깨운다"가 아니라
  // **"창이 라우트보다 한 분 넓다"**였다 — 깨워 봐야 AFTER_WINDOW만
  // 돌려받는 낭비이고, `entryWindowDue.ts` 자신이 하지 말라고 적어 둔 일이다.
  //
  // 주문이 나가는 시각은 바뀌지 않는다. 09:30에는 원래도 주문이 안 나갔다.
  // 바뀐 것은 **그 분에 헛되이 깨우지 않는다**는 것뿐이다.
  test('★ 창 안에서는 기회를 준다 — 09:29까지 (09:30은 라우트가 거부하는 분이다)', () => {
    eq(at(9, 15).code, 'WINDOW');
    eq(at(9, 29).code, 'WINDOW');
  });

  test('★★★ 09:31 — 창이 닫힌 뒤에는 뒤늦게 깨우지 않는다 (유예 없음)', () => {
    const v = at(9, 31);
    assert(v.code !== 'WINDOW', `창 밖인데 WINDOW로 깨웠다: ${v.code}`);
    eq(v.due, false);
  });

  test('★★ 창 안 중복 없음 — 한 번 평가하면 그 창에서 다시 깨우지 않는다', () => {
    const v = at(9, 20, 0, { last_run_at: new Date(kst(9, 5)).toISOString() });
    assert(v.code !== 'WINDOW', `중복으로 깨웠다: ${v.code}`);
  });

  test('★★ 초 단위 지터로 재평가되지 않는다 (#442와 같은 함정)', () => {
    // 09:01:10에 평가했고 지금은 09:02:45다. 창 시작을 초까지 끌고
    // 역산하면 09:01:45가 되어 09:01:10을 "창 이전"으로 잘못 읽는다.
    const v = at(9, 2, 45, { last_run_at: new Date(kst(9, 1, 10)).toISOString() });
    assert(v.code !== 'WINDOW', `초 단위 지터로 다시 깨웠다: ${v.code}`);
  });

  test('★ 중복 방지(MIN_GAP 1분)가 창 판정보다 먼저다', () => {
    const v = at(9, 0, 30, { last_run_at: new Date(kst(9, 0, 10)).toISOString() });
    eq(v.code, 'TOO_SOON');
    eq(v.due, false);
  });

  test('꺼진 예약 · 연결 없음은 창이 열려도 깨우지 않는다', () => {
    eq(at(9, 10, 0, { enabled: false }).code, 'OFF');
    eq(at(9, 10, 0, { connection_id: '' }).code, 'NO_CONNECTION');
  });

  // ── 폴러까지 이어진 배선 ─────────────────────────
  test('★★★ selectDueSchedules가 09:00에 이 예약을 due로 고른다', () => {
    const sel = selectDueSchedules([row()] as any, kst(9, 0));
    eq(sel.due.length, 1);
    eq(sel.due[0].verdict.code, 'WINDOW');
    eq(sel.skipped.length, 0);
  });

  test('★★ TESTNET 외 예약은 창이 열려도 이 루프가 보지 않는다', () => {
    for (const mode of ['LIVE', 'PAPER', 'MOCK', '', null]) {
      const sel = selectDueSchedules([row({ mode })] as any, kst(9, 0));
      eq(sel.due.length, 0);
      eq(sel.skipped[0]?.code, 'NOT_TESTNET');
    }
  });

  test('★★ 계약 없는 scalp는 폴러도 09:00에 고르지 않는다', () => {
    const sel = selectDueSchedules(
      [row({ execution_profile_id: null, execution_preset_id: null })] as any, kst(9, 0));
    eq(sel.due.length, 0);
    eq(sel.skipped[0]?.code, 'WAITING');
  });

  test('★★ 예약을 못 읽으면 고를 것이 없다 — 0건을 "창 통과"로 읽지 않는다', () => {
    // 폴러는 읽기 실패 시 빈 배열조차 넘기지 않지만(워커가 먼저 return한다),
    // 혹시 넘어오더라도 창을 근거로 무언가를 만들어 내지 않아야 한다.
    const sel = selectDueSchedules([] as any, kst(9, 0));
    eq(sel.due.length, 0);
    eq(sel.skipped.length, 0);
  });

  // ── 순수 창 판정 ─────────────────────────────────
  const W0900 = entryWindowOf('scalp', EXACT100X);

  // 여기도 같은 이유로 09:30 기대를 고쳤다 (위 주석 참고).
  test('09:00 창 판정 경계 — 09:00 포함 · 09:29 포함 · 09:30부터 제외', () => {
    eq(windowDueVerdict({ nowMs: kst(9, 0), lastRunAtMs: LAST_RUN, window: W0900 }).code, 'WINDOW_OPEN');
    eq(windowDueVerdict({ nowMs: kst(9, 29), lastRunAtMs: LAST_RUN, window: W0900 }).code, 'WINDOW_OPEN');
    eq(windowDueVerdict({ nowMs: kst(9, 30), lastRunAtMs: LAST_RUN, window: W0900 }).code, 'OUTSIDE');
    eq(windowDueVerdict({ nowMs: kst(9, 31), lastRunAtMs: LAST_RUN, window: W0900 }).code, 'OUTSIDE');
  });

  test('한국 시각을 못 읽으면 "창 밖"이 아니라 CLOCK_UNKNOWN이다', () => {
    eq(windowDueVerdict({ nowMs: NaN, lastRunAtMs: LAST_RUN, window: W0900 }).code, 'CLOCK_UNKNOWN');
  });

  // ── 깨우는 쪽과 라우트가 **같은 분**에 동의하는가 (#450) ──
  //
  // 이 파일 위의 ⑥번("창 값을 여기서 다시 적어 정본과 갈리는 것")은 창의
  // **값**만 봤다. 그런데 같은 창이라도 **경계를 세는 방식**이 다르면 또
  // 갈린다. 실제로 갈려 있었다:
  //
  //   entryWindowDue.windowDueVerdict  `nowMin > endMin + graceMin` → 09:30 **포함**
  //   dailyForcedEntry.forcedEntryVerdict `minute >= endMin`        → 09:30 **제외**
  //
  // 그래서 09:30 한 분 동안 스케줄러는 창을 근거로 평가를 깨우는데
  // 라우트는 AFTER_WINDOW로 거부한다. `entryWindowDue.ts`가 직접
  // "깨우는 쪽이 더 늦게까지 깨우면 평가만 낭비된다"고 적어 둔 그 상태다.
  //
  // 값 비교로는 못 잡는다 — **판정끼리 대조해야** 잡힌다.

  const routeAt = (ms: number) => forcedEntryVerdict({
    nowMs: ms, mode: 'TESTNET',
    profileId: FORCED_ENTRY_PROFILE_ID, presetId: FORCED_ENTRY_PRESET_ID,
    ordersTodayInWindow: 0,
  });

  test('★★★ 깨우는 쪽은 라우트보다 넓지 않다 — 08:50~09:40 전 분 대조', () => {
    const wider: string[] = [];
    for (let m = 8 * 60 + 50; m <= 9 * 60 + 40; m++) {
      const ms = kst(Math.floor(m / 60), m % 60);
      const woke = windowDueVerdict({ nowMs: ms, lastRunAtMs: LAST_RUN, window: W0900 }).due;
      const code = routeAt(ms).code;
      const routeRefusesForTime = code === 'BEFORE_WINDOW' || code === 'AFTER_WINDOW';
      if (woke && routeRefusesForTime) {
        wider.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}=${code}`);
      }
    }
    eq(wider.length, 0, `깨우는 쪽이 라우트보다 넓다: ${wider.join(' · ')}`);
  });

  test('★★★ 09:29:59는 깨우고, 09:30:00·09:30:59는 창을 근거로 깨우지 않는다', () => {
    eq(windowDueVerdict({ nowMs: kst(9, 29, 59), lastRunAtMs: LAST_RUN, window: W0900 }).code, 'WINDOW_OPEN');
    eq(windowDueVerdict({ nowMs: kst(9, 30, 0), lastRunAtMs: LAST_RUN, window: W0900 }).code, 'OUTSIDE');
    eq(windowDueVerdict({ nowMs: kst(9, 30, 59), lastRunAtMs: LAST_RUN, window: W0900 }).code, 'OUTSIDE');
  });

  test('★★ 09:30에 평가하더라도 그것은 "창이 깨운 것"이 아니다 — 일반 주기와 구분한다', () => {
    // 간격이 찬 예약은 09:30에도 평가된다. 그건 정상이고 막지 않는다.
    // 다만 그 근거는 **창이 아니라 간격**이어야 한다 — 기록에 그렇게 남는다.
    const due = at(9, 30, 0, { last_run_at: new Date(kst(8, 25)).toISOString() });
    eq(due.code, 'DUE');
    // 같은 시각, 간격이 안 찬 예약은 아무도 깨우지 않는다.
    eq(at(9, 30, 0).code, 'WAITING');
  });

  test('★★ my-original-v1의 유예는 그대로다 — 이 수정이 다른 창을 좁히지 않는다', () => {
    const w = entryWindowOf('my-original-v1');
    const endMin = WINDOW_END_KST.hh * 60 + WINDOW_END_KST.mm;
    const last = endMin + LATE_GRACE_MIN;
    const atMin = (m: number) => windowDueVerdict({
      nowMs: kst(Math.floor(m / 60), m % 60), lastRunAtMs: kst(0, 5), window: w,
    }).code;
    eq(atMin(last), 'WINDOW_OPEN', `유예 마지막 분(${last})이 닫혔다`);
    eq(atMin(last + 1), 'OUTSIDE');
  });
}
