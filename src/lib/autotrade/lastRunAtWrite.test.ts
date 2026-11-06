// src/lib/autotrade/lastRunAtWrite.test.ts
//
// **`autotrade_schedules.last_run_at`을 쓰는 곳은 둘이다.**
//
//   선점  `claimSchedule`     `new Date(nowMs)`   — 폴링 시각 · CAS 있음
//   기록  `recordEvaluation`  `new Date()`        — 전략 호출이 **끝난** 시각 · CAS 없음
//
// 뒤쪽이 앞쪽을 덮는다. 그래서 다음 창이 열리는 시각은 `설정 간격`이
// 아니라 `설정 간격 + 평가 소요시간` 뒤다. 회차마다 누적된다.
//
// 운영에서 실제로 밀렸다 (#450 · autotrade-tick 응답의 leftMin 19개를
// 역산한 결과, 선점 위상이 4.7일 동안 58:15 → 40:14 로 단조 전진했다 =
// 선점 1회당 약 22.5초 · 112회에 42분). 산수는
// `waitingRepro.test.ts`가, 코드가 그렇게 쓴다는 것은 이 파일이 잡는다.
//
// **고치는 것은 '언제 평가하나'가 아니라 '간격을 설정값대로 지키나'다.**
// 사용자가 60분을 넣었으면 60분이어야 한다.

import { test, eq, assert } from '../../test/harness';
import { evaluateIfDue, type ScheduleRow } from './evaluationRunner';

/**
 * `autotrade_schedules` 한 줄만 있는 가짜 Supabase.
 *
 * **CAS를 진짜로 흉내 낸다.** `update().eq('id')`에 조건이 더 붙으면 그
 * 값이 지금 값과 같을 때만 쓴다. 조건을 무시하면 이 시험이 아무것도
 * 검증하지 않는다.
 */
function fakeSb(row: any) {
  const state = { row, writes: [] as any[] };
  const sb = {
    from(_t: string) {
      const b: any = {
        _patch: null as any, _id: null as any,
        _guards: [] as Array<{ col: string; val: any }>,
        update(patch: any) { b._patch = patch; return b; },
        eq(col: string, val: any) {
          if (col === 'id') b._id = val; else b._guards.push({ col, val });
          return b;
        },
        is(col: string, val: any) { b._guards.push({ col, val }); return b; },
        select(_c: string) { return b; },
        _run() {
          if (b._id !== state.row.id) return { data: [], error: null };
          for (const g of b._guards) {
            const cur = state.row[g.col] ?? null;
            if (cur !== (g.val ?? null)) return { data: [], error: null };
          }
          state.writes.push({ patch: b._patch, guarded: b._guards.length > 0 });
          Object.assign(state.row, b._patch);
          return { data: [{ id: b._id }], error: null };
        },
        then(res: any, rej: any) {
          return Promise.resolve().then(() => b._run()).then(res, rej);
        },
      };
      return b;
    },
  };
  return { sb, state };
}

/** 진입까지 간 실행기 응답 */
function okFetch(calls: string[]) {
  return (async (url: any) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true, entered: true, message: '진입했습니다' }) };
  }) as any;
}

/**
 * **실제 시계와 확실히 다른 시각**을 쓴다.
 *
 * `nowMs`를 지금과 비슷하게 두면 `new Date()`를 적는 버그와 `nowMs`를
 * 적는 올바른 동작이 밀리초 차이로만 갈려서 시험이 흔들린다.
 */
const NOW = Date.UTC(2026, 0, 15, 3, 0, 0);
const INTERVAL_MIN = 60;

function row(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched-1', user_id: 'user-1', symbol: 'BTCUSDT',
    connection_id: 'conn-1', mode: 'TESTNET', enabled: true,
    // 간격이 10분 전에 지났다 → 이번 폴링은 차례다
    last_run_at: new Date(NOW - (INTERVAL_MIN + 10) * 60_000).toISOString(),
    interval_min: INTERVAL_MIN,
    strategy_id: 'daily-ladder', strategy_version: '1',
    ...over,
  } as ScheduleRow;
}

const deps = (calls: string[]) => ({
  origin: 'https://example.invalid', adminSecret: 'x',
  fetchImpl: okFetch(calls), source: 'FLY_WORKER' as const,
});

export function runLastRunAtWriteTests() {
  console.log('[last_run_at 쓰기 경로 — 간격이 설정값대로 지켜지나]');

  test('★ **기록은 선점 시각을 적는다** — 평가에 걸린 시간을 간격에 더하지 않는다', async () => {
    const calls: string[] = [];
    const { sb, state } = fakeSb(row());
    const r = await evaluateIfDue(sb as any, row(), deps(calls), NOW);
    eq(r.due.due, true, r.due.reason);
    eq(calls.length, 1, '전략을 한 번 불러야 한다');
    eq(state.row.last_run_at, new Date(NOW).toISOString(),
      `기록이 선점 시각이 아니다 — ${state.row.last_run_at}`);
  });

  test('★ 기록이 선점 시각보다 **뒤**를 적지 않는다', async () => {
    const calls: string[] = [];
    const { sb, state } = fakeSb(row());
    await evaluateIfDue(sb as any, row(), deps(calls), NOW);
    const written = Date.parse(String(state.row.last_run_at));
    assert(Number.isFinite(written), `쓴 값을 읽을 수 없다: ${state.row.last_run_at}`);
    assert(written <= NOW,
      `선점 ${new Date(NOW).toISOString()} 보다 ${(written - NOW) / 1000}초 뒤를 적었다`);
  });

  test('★ 선점과 기록이 **같은 값**을 적는다 — 두 쓰기가 갈리지 않는다', async () => {
    const calls: string[] = [];
    const { sb, state } = fakeSb(row());
    await evaluateIfDue(sb as any, row(), deps(calls), NOW);
    const stamps = state.writes
      .map(w => w.patch?.last_run_at)
      .filter((x: any) => typeof x === 'string');
    assert(stamps.length >= 2, `last_run_at 쓰기가 ${stamps.length}번 — 선점과 기록 둘이어야 한다`);
    eq(new Set(stamps).size, 1, `서로 다른 값을 적었다: ${stamps.join(' · ')}`);
  });

  test('선점은 CAS 로 쓴다 — enabled·cancelled_at·이전 값을 함께 본다', async () => {
    const calls: string[] = [];
    const { sb, state } = fakeSb(row());
    await evaluateIfDue(sb as any, row(), deps(calls), NOW);
    assert(state.writes.some(w => w.guarded && w.patch?.last_run_at),
      '조건 없는 쓰기만 있었다 — 중복 실행을 막지 못한다');
  });

  test('차례가 아니면 아무것도 쓰지 않는다 — 간격이 밀리지 않는다', async () => {
    const calls: string[] = [];
    const fresh = row({ last_run_at: new Date(NOW - 10 * 60_000).toISOString() });
    const { sb, state } = fakeSb(fresh);
    const r = await evaluateIfDue(sb as any, { ...fresh }, deps(calls), NOW);
    eq(r.due.due, false);
    eq(r.due.code, 'WAITING');
    eq(state.writes.length, 0, '건너뛰었는데 쓰기가 있었다');
    eq(calls.length, 0, '건너뛰었는데 전략을 불렀다');
  });

  // ── 알려진 틈 (이 PR 에서 **고치지 않는다** · #450 에 보고) ──
  //
  // `NO_CONNECTION`은 선점 없이 `recordEvaluation`을 부른다. 그러면
  // 연결이 비어 있는 예약은 **폴링마다**(Worker 는 60초) `last_run_at`이
  // 갱신되고, 화면에는 "1분 전에 평가함"으로 보인다 — 평가는 한 번도
  // 못 했는데. 같은 파일의 주석("건너뛸 때는 last_run_at 을 건드리지
  // 않는다")과 어긋난다.
  //
  // 여기서 같이 고치지 않는 이유: 고치면 그 줄이 폴링마다 BLOCKED 를
  // 다시 적게 되어(간격 검사가 NO_CONNECTION 보다 뒤에 있다) 쓰기 양이
  // 오히려 늘어난다. 두 동작 변경을 한 PR 에 묶지 않는다.
  test('알려진 틈 — 연결이 없으면 선점 없이 last_run_at 이 갱신된다 (#450 보고)', async () => {
    const calls: string[] = [];
    const noConn = row({ connection_id: '' });
    const { sb, state } = fakeSb(noConn);
    const r = await evaluateIfDue(sb as any, { ...noConn }, deps(calls), NOW);
    eq(r.due.code, 'NO_CONNECTION');
    eq(calls.length, 0, '연결이 없는데 전략을 불렀다');
    const guarded = state.writes.filter(w => w.guarded).length;
    eq(guarded, 0, '선점이 있었다면 이 틈은 이미 없는 것이다 — 주석을 고쳐라');
    assert(state.writes.some(w => w.patch?.last_run_at),
      '이 틈이 사라졌다면 위 주석과 이 시험을 지워라');
  });
}
