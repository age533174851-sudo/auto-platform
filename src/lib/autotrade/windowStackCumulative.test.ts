// src/lib/autotrade/windowStackCumulative.test.ts
//
// **#444와 #445는 형제다 — 둘 다 green이어도 "함께 green"은 아니다.**
//
// 두 PR 모두 #443에서 갈라져 나왔고 서로를 포함하지 않는다. 각자의 CI가
// 통과한 것은 **자기 수정만 있는 트리**에서의 결과다. 두 수정이 같은
// 09:00 창을 서로 다른 지점에서 만지므로, 누적 트리에서 한 번 더 본다.
//
//   #444  `forcedWindowStartMs`   주문 이력 조회의 **하한**
//   #445  `windowDueVerdict`      깨우기의 **종료 경계**
//   #442  `windowDueVerdict`      깨우기의 **시작 역산** (초 절삭)
//
// 세 수정이 모두 "분 단위 경계에서 초·밀리초가 새는" 같은 과를 다룬다.
// 한 트리에서 동시에 맞는지 확인하지 않으면, 셋 중 둘만 들어간 상태가
// 언젠가 배포된다.
//
// 막으려는 것:
//  1. 세 수정 중 하나가 통합에서 사라지는 것
//  2. 조회 하한이 09:00:00.000이 아니어서 이미 낸 주문이 조회에서 빠지고
//     **중복 진입**하는 것
//  3. 깨우는 쪽과 판단하는 쪽의 종료 경계가 어긋나는 것
//  4. 창을 열면서 일반 scalp·LIVE·PAPER까지 깨우는 것
//  5. `RISK_VETO`·이력 불명 fail-closed가 느슨해지는 것
import { test, assert, eq } from '../../test/harness';
import { entryWindowOf, windowDueVerdict } from './entryWindowDue';
import { dueCheck } from './evaluationLoop';
import { selectDueSchedules } from './schedulePoll';
import {
  forcedWindowStartMs, forcedEntryVerdict,
  FORCED_ENTRY_MODE, FORCED_ENTRY_PROFILE_ID, FORCED_ENTRY_PRESET_ID,
} from '../strategies/dailyForcedEntry';

/** FakeClock — 그 한국시각(2026-10-26)의 UTC epoch */
const kst = (hh: number, mm: number, ss = 0, ms = 0) =>
  Date.UTC(2026, 9, 26, hh - 9, mm, ss, ms);

const EXACT = { profileId: FORCED_ENTRY_PROFILE_ID, presetId: FORCED_ENTRY_PRESET_ID };
const LAST_RUN = kst(8, 42);

const row = (over: Record<string, any> = {}) => ({
  id: 'sch-1', symbol: 'BTCUSDT', mode: 'TESTNET', enabled: true,
  connection_id: 'conn-1', last_run_at: new Date(LAST_RUN).toISOString(),
  interval_min: 60, strategy_id: 'scalp',
  execution_profile_id: FORCED_ENTRY_PROFILE_ID,
  execution_preset_id: FORCED_ENTRY_PRESET_ID,
  ...over,
});

const wake = (hh: number, mm: number, ss = 0, ms = 0, over: Record<string, any> = {}) => {
  const r = row(over);
  return dueCheck({
    nowMs: kst(hh, mm, ss, ms), enabled: r.enabled, connectionId: r.connection_id,
    lastRunAtMs: r.last_run_at, intervalMin: r.interval_min, strategyId: r.strategy_id,
    profileId: r.execution_profile_id, presetId: r.execution_preset_id,
  } as any);
};

const judge = (hh: number, mm: number, ss = 0, ms = 0, orders: number | null = 0) =>
  forcedEntryVerdict({
    nowMs: kst(hh, mm, ss, ms), mode: FORCED_ENTRY_MODE,
    profileId: FORCED_ENTRY_PROFILE_ID, presetId: FORCED_ENTRY_PRESET_ID,
    ordersTodayInWindow: orders,
  });

export function runWindowStackCumulativeTests() {
  console.log('[#444 + #445 누적 — 세 수정이 한 트리에서 동시에 맞는가]');

  // ── #444: 조회 하한은 언제나 09:00:00.000 ────────
  const WINDOW_START = kst(9, 0, 0, 0);

  test('★★★ forcedWindowStartMs — 창 안 어느 시각에서도 09:00:00.000이다', () => {
    for (const [hh, mm, ss, ms] of [
      [9, 0, 0, 0], [9, 0, 45, 123], [9, 1, 45, 123], [9, 29, 59, 999],
    ] as const) {
      const got = forcedWindowStartMs(kst(hh, mm, ss, ms));
      eq(got, WINDOW_START,
        `${hh}:${mm}:${ss}.${ms} → ${got == null ? 'null' : new Date(got).toISOString()}`);
    }
  });

  test('★★ 조회 하한이 초를 끌고 오면 이미 낸 주문이 빠진다 — 그 자리를 못 박는다', () => {
    // 09:00:10에 낸 주문은 09:01:45 시점의 조회 하한보다 **뒤**여야 한다.
    const placedAt = kst(9, 0, 10);
    const lowerBound = forcedWindowStartMs(kst(9, 1, 45, 123));
    assert(lowerBound != null && placedAt >= lowerBound,
      `09:00:10 주문이 조회 하한(${lowerBound}) 밖으로 밀렸다`);
  });

  test('시각을 못 읽으면 하한도 null이다 — 0으로 적지 않는다', () => {
    eq(forcedWindowStartMs(NaN), null);
  });

  // ── #445: 종료 경계가 두 경로에서 같다 ───────────
  test('★★★ 09:29:59 — 깨우는 쪽 WINDOW · 판단하는 쪽 DUE', () => {
    eq(wake(9, 29, 59).code, 'WINDOW');
    eq(judge(9, 29, 59).code, 'DUE');
  });

  test('★★★ 09:30:00 — 양쪽 모두 거절', () => {
    assert(wake(9, 30, 0).code !== 'WINDOW', `깨웠다: ${wake(9, 30, 0).code}`);
    eq(judge(9, 30, 0).code, 'AFTER_WINDOW');
  });

  test('★★ 08:55~09:35 전 구간에서 두 경로가 어긋나지 않는다 (누적 트리)', () => {
    for (let m = 8 * 60 + 55; m <= 9 * 60 + 35; m++) {
      const hh = Math.floor(m / 60), mm = m % 60;
      eq(wake(hh, mm).code === 'WINDOW', judge(hh, mm).code === 'DUE',
        `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
    }
  });

  // ── #442: 창 안 재평가 없음 (초 단위 지터) ───────
  test('★★ 창 안에서 한 번 평가한 뒤 초 단위 지터로 다시 깨우지 않는다', () => {
    for (const [lastSs, nowMm, nowSs] of [[10, 2, 45], [59, 1, 1], [0, 29, 59]] as const) {
      const v = wake(9, nowMm, nowSs, 0,
        { last_run_at: new Date(kst(9, 1, lastSs)).toISOString() });
      assert(v.code !== 'WINDOW',
        `09:01:${lastSs} 평가 뒤 09:${nowMm}:${nowSs}에 다시 깨웠다: ${v.code}`);
    }
  });

  // ── 중복 진입 차단은 판단 쪽에서도 산다 ──────────
  test('★★ 오늘 창에서 이미 냈으면 판단 쪽이 막는다', () => {
    eq(judge(9, 15, 0, 0, 1).code, 'ALREADY_TODAY');
  });

  test('★★★ 이력을 못 읽으면 내지 않는다 — 0건으로 적지 않는다', () => {
    eq(judge(9, 15, 0, 0, null).code, 'HISTORY_UNKNOWN');
  });

  // ── 범위 차단 ────────────────────────────────────
  test('★★ 일반 scalp(계약 없음)는 09:00에 깨우지 않는다', () => {
    eq(entryWindowOf('scalp'), null);
    const sel = selectDueSchedules(
      [row({ execution_profile_id: null, execution_preset_id: null })] as any, kst(9, 0));
    eq(sel.due.length, 0);
  });

  test('★★ LIVE · PAPER · MOCK · 빈 값은 이 루프가 보지 않는다', () => {
    for (const mode of ['LIVE', 'PAPER', 'MOCK', '', null]) {
      const sel = selectDueSchedules([row({ mode })] as any, kst(9, 0));
      eq(sel.due.length, 0);
      eq(sel.skipped[0]?.code, 'NOT_TESTNET');
    }
  });

  test('★ TESTNET + 계약 있으면 09:00에 고른다 (누적 트리에서도)', () => {
    const sel = selectDueSchedules([row()] as any, kst(9, 0));
    eq(sel.due.length, 1);
    eq(sel.due[0].verdict.code, 'WINDOW');
  });

  // ── my-original-v1 의미 보존 ─────────────────────
  test('★★ 09:10 창(my-original-v1)의 포함·유예는 그대로다', () => {
    const w = entryWindowOf('my-original-v1');
    eq(w!.startMin, 9 * 60 + 10);
    eq(w!.graceMin, 30);
    eq(w!.endExclusive, undefined);
    eq(windowDueVerdict({ nowMs: kst(9, 30), lastRunAtMs: kst(7, 0), window: w }).code, 'WINDOW_OPEN');
    eq(windowDueVerdict({ nowMs: kst(10, 0), lastRunAtMs: kst(7, 0), window: w }).code, 'WINDOW_OPEN');
    eq(windowDueVerdict({ nowMs: kst(10, 1), lastRunAtMs: kst(7, 0), window: w }).code, 'OUTSIDE');
  });
}
