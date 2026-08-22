// src/lib/autotrade/firstEvalRace.test.ts
//
// **켜는 순간과 Worker poll이 겹쳐도 주문은 한 번뿐인가.**
//
// 자동매매를 켜면 `POST /api/autotrade/schedule`이 저장 직후 첫 평가를
// 돌린다. 같은 순간 Fly Worker의 1분 poll이 같은 줄을 집을 수 있다.
// 둘 다 `evaluateIfDue`를 부르고, 조건이 맞았으면 **주문이 두 번 나간다.**
//
// 막는 것은 `claimSchedule`의 compare-and-set 하나다. `last_run_at`을
// 지금으로 바꾸되 **읽었을 때와 값이 같을 때만** 바꾼다. 이 파일은 그
// 방어가 실제로 서는지를 네트워크 없이 값으로 확인한다.
//
// **왜 화면 쪽 중복을 없앤 뒤에도 이 테스트가 필요한가.**
// 화면의 `runFirstCheck()`는 지웠다(첫 평가는 서버 응답을 그린다).
// 그래도 예약을 보는 곳은 여전히 둘이다 — 서버의 첫 평가와 Worker poll.
// 이 둘은 설계상 남는 것이므로, 중복 방어는 지우는 것이 아니라
// **테스트로 못 박는다.**
import { test, eq, assert } from '../../test/harness';
import { evaluateIfDue, claimSchedule, type ScheduleRow } from './evaluationRunner';

/**
 * `autotrade_schedules` 한 줄만 있는 가짜 Supabase.
 *
 * **compare-and-set을 진짜로 흉내 낸다.** `update().eq('id')`에 조건이
 * 하나 더 붙으면 그 값이 지금 값과 같을 때만 쓰고, 다르면 0줄을
 * 돌려준다. 여기서 그냥 항상 성공을 돌려주면 이 테스트는 아무것도
 * 검증하지 않는다.
 */
function fakeSb(row: any) {
  const state = { row, updates: 0, claims: 0 };
  const sb = {
    from(_table: string) {
      const b: any = {
        _patch: null as any,
        _id: null as any,
        _guardCol: null as string | null,
        _guardVal: undefined as any,
        _guarded: false,
        update(patch: any) { b._patch = patch; return b; },
        eq(col: string, val: any) {
          if (col === 'id') b._id = val;
          else { b._guarded = true; b._guardCol = col; b._guardVal = val; }
          return b;
        },
        is(col: string, val: any) {
          b._guarded = true; b._guardCol = col; b._guardVal = val; return b;
        },
        select(_cols: string) { return b; },
        _run() {
          if (b._id !== state.row.id) return { data: [], error: null };
          if (b._guarded) {
            const cur = state.row[b._guardCol as string] ?? null;
            const want = b._guardVal ?? null;
            // 값이 그 사이 바뀌었으면 진 것이다 — 0줄.
            if (cur !== want) return { data: [], error: null };
            state.claims++;
          }
          Object.assign(state.row, b._patch);
          state.updates++;
          return { data: [{ id: b._id }], error: null };
        },
        // 쿼리 빌더를 그대로 await 하는 호출부가 있다(`recordEvaluation`).
        // 마이크로태스크를 한 번 거치게 해서 두 호출이 실제로 엇갈리게 한다.
        then(res: any, rej: any) {
          return Promise.resolve().then(() => b._run()).then(res, rej);
        },
      };
      return b;
    },
  };
  return { sb, state };
}

/** 진입까지 간 실행기 응답. 부른 횟수를 센다 */
function countingFetch(calls: string[]) {
  return (async (url: any, _init?: any) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, entered: true, message: '진입했습니다' }),
    };
  }) as any;
}

function baseRow(): ScheduleRow {
  return {
    id: 'sched-1',
    user_id: 'user-1',
    symbol: 'BTCUSDT',
    connection_id: 'conn-1',
    mode: 'TESTNET',
    enabled: true,
    last_run_at: null,
    interval_min: 1440,
    strategy_id: 'daily-ladder',
    strategy_version: '1',
  };
}

function deps(calls: string[], source: any) {
  return {
    origin: 'https://example.invalid',
    adminSecret: 'x',
    fetchImpl: countingFetch(calls),
    timeoutMs: 5_000,
    source,
  };
}

export function runFirstEvalRaceTests() {
  console.log('[켜는 순간 + Worker poll — 주문은 한 번뿐]');

  test('동시에 들어와도 실행기는 한 번만 불린다', async () => {
    const { sb, state } = fakeSb(baseRow());
    const calls: string[] = [];
    const now = Date.parse('2026-08-22T00:10:00Z');

    // 두 호출 모두 **같은 스냅샷**을 들고 있다 — 실제로도 그렇다.
    // 서버는 방금 저장한 줄을, Worker는 방금 조회한 줄을 들고 온다.
    const snapA = { ...baseRow() };
    const snapB = { ...baseRow() };

    const [a, b] = await Promise.all([
      evaluateIfDue(sb, snapA, deps(calls, 'MANUAL') as any, now),
      evaluateIfDue(sb, snapB, deps(calls, 'FLY_WORKER') as any, now),
    ]);

    eq(calls.length, 1, `실행기 호출 ${calls.length}회 — 주문 경로가 두 번 열렸다`);
    eq(state.claims, 1, '선점에 성공한 쪽이 둘이면 안 된다');

    const ran = [a, b].filter((r) => r.record != null);
    const lost = [a, b].filter((r) => r.record == null);
    eq(ran.length, 1, '평가 기록이 둘이면 안 된다');
    eq(lost.length, 1);
    eq(ran[0].record!.outcome, 'ENTERED');
    eq(ran[0].record!.executed, true);
  });

  test('진 쪽은 오류가 아니다 — 중복 방지가 일한 것이다', async () => {
    const { sb } = fakeSb(baseRow());
    const calls: string[] = [];
    const now = Date.parse('2026-08-22T00:10:00Z');

    const [a, b] = await Promise.all([
      evaluateIfDue(sb, { ...baseRow() }, deps(calls, 'MANUAL') as any, now),
      evaluateIfDue(sb, { ...baseRow() }, deps(calls, 'FLY_WORKER') as any, now),
    ]);

    const lost = [a, b].find((r) => r.record == null)!;
    // 실패로 적으면 화면이 빨개지고, 진짜 고장이 그 안에 묻힌다.
    eq(lost.saveError, null, '선점 실패를 저장 오류로 적으면 안 된다');
    eq(lost.due.due, false);
  });

  test('진 쪽은 last_run_at을 덮어쓰지 않는다', async () => {
    // 진 쪽이 시각을 다시 쓰면 간격이 밀려서 다음 차례가 통째로 사라진다.
    const { sb, state } = fakeSb(baseRow());
    const calls: string[] = [];
    const now = Date.parse('2026-08-22T00:10:00Z');

    await Promise.all([
      evaluateIfDue(sb, { ...baseRow() }, deps(calls, 'MANUAL') as any, now),
      evaluateIfDue(sb, { ...baseRow() }, deps(calls, 'FLY_WORKER') as any, now),
    ]);
    // 이긴 쪽의 선점 + 기록, 두 번만 쓴다.
    eq(state.updates, 2, `줄을 ${state.updates}번 고쳤다 — 진 쪽도 썼다`);
  });

  test('선점은 값이 그대로일 때만 성공한다', async () => {
    const { sb, state } = fakeSb(baseRow());
    const now = Date.parse('2026-08-22T00:10:00Z');
    const first = await claimSchedule(sb, baseRow(), now);
    eq(first.ok, true);

    // 옛 스냅샷(last_run_at=null)으로 다시 집으면 진다.
    const second = await claimSchedule(sb, baseRow(), now + 1000);
    eq(second.ok, false);
    eq(second.code, 'LOST');
    eq(state.claims, 1);
  });

  test('선점 조회가 실패한 것을 남이 가져간 것으로 읽지 않는다', async () => {
    // 오류를 'LOST'로 읽으면 그 예약은 아무도 안 도는데 로그는 조용하다.
    const broken = {
      from() {
        const b: any = {
          update() { return b; }, eq() { return b; }, is() { return b; },
          select() { return b; },
          then(res: any, rej: any) {
            return Promise.resolve({ data: null, error: { message: 'connection reset' } })
              .then(res, rej);
          },
        };
        return b;
      },
    };
    const v = await claimSchedule(broken, baseRow(), Date.now());
    eq(v.ok, false);
    assert(v.code !== 'LOST', `조회 실패를 LOST로 적었다 — ${v.code}`);
  });

  test('이미 돈 차례는 실행기까지 가지 않는다', async () => {
    // 첫 평가가 끝난 직후 Worker poll이 오는 흔한 순서.
    const row = baseRow();
    const { sb } = fakeSb(row);
    const calls: string[] = [];
    const now = Date.parse('2026-08-22T00:10:00Z');

    const first = await evaluateIfDue(sb, { ...baseRow() }, deps(calls, 'MANUAL') as any, now);
    eq(first.record!.outcome, 'ENTERED');
    eq(calls.length, 1);

    // Worker가 방금 갱신된 줄을 읽고 30초 뒤에 온다.
    const fresh: ScheduleRow = { ...baseRow(), last_run_at: row.last_run_at };
    const second = await evaluateIfDue(sb, fresh, deps(calls, 'FLY_WORKER') as any, now + 30_000);
    eq(second.due.due, false, '간격 검사가 통과시켰다');
    eq(second.record, null);
    eq(calls.length, 1, `실행기가 ${calls.length}번 불렸다`);
  });

  test('꺼진 예약은 켜는 순간 경로로도 돌지 않는다', async () => {
    const { sb } = fakeSb({ ...baseRow(), enabled: false });
    const calls: string[] = [];
    const r = await evaluateIfDue(
      sb, { ...baseRow(), enabled: false }, deps(calls, 'MANUAL') as any,
      Date.parse('2026-08-22T00:10:00Z'),
    );
    eq(r.due.due, false);
    eq(calls.length, 0);
  });
}
