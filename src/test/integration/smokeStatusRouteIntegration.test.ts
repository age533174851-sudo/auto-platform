// src/test/integration/smokeStatusRouteIntegration.test.ts
//
// **상태 조회가 장부를 못 읽은 회차를 "회차 0건"으로 그렸다.**
//
// `advanceVerdict`는 받은 회차 목록만 본다 — 비어 있으면 "아직 아무
// 회차도 없다"로 읽어 **다음 회차를 열 수 있다**고 답한다. 순수 함수로서는
// 맞다. 문제는 그 목록을 만드는 쪽이었다:
//
//     const { data: t } = await sb.from('smoke_tests')…   // error를 버린다
//     tests = t || [];
//
// `/api/autotrade/smoke-test`의 상태 조회가 `error`를 보지 않았다. 그래서
// 3회차까지 돈 묶음의 회차 목록을 못 읽으면 화면에 **"1회차를 시작할 수
// 있습니다"**가 뜬다. 바로 옆의 `smoke_runs` 조회는 이미 `error`를 보고
// 끊고 있었다 — 한 함수 안에서 규칙이 갈려 있었다.
//
// 순수 판정만 확인하면 "목록이 비면 READY"가 **옳은 답**이라서 아무것도
// 잡히지 않는다. 그래서 **실제 GET 핸들러**를 불러 응답을 본다.
//
// 거래소를 부르지 않는다. 주문도, 장부 쓰기도 없다.

import { test, eq, assert } from '../harness';

export async function runSmokeStatusRouteTests() {

  // ══════════════════════════════════════════════════════════
  // ★ 장부를 **못 읽은** 회차를 "회차 0건"으로 그리지 않는다
  // ══════════════════════════════════════════════════════════
  //
  //   `advanceVerdict`는 입력받은 회차 목록만 본다 — 목록이 비어 있으면
  //   "아직 아무 회차도 없다"로 읽어 **다음 회차를 열 수 있다**고 답한다.
  //   순수 함수로서는 맞다. 문제는 그 목록을 만드는 쪽이었다:
  //
  //     const { data: t } = await sb.from('smoke_tests')…   // error를 버린다
  //     tests = t || [];
  //
  //   `/api/autotrade/smoke-test`의 상태 조회가 `error`를 보지 않았다.
  //   그래서 3회차까지 돈 묶음의 회차 목록을 못 읽으면 화면에 **"1회차를
  //   시작할 수 있습니다"**가 뜬다. 바로 옆의 `smoke_runs` 조회는 이미
  //   `error`를 보고 500으로 끊고 있었다 — 한 함수 안에서 규칙이 갈려
  //   있었다.
  //
  //   여기서는 **실제 GET 핸들러**를 불러 응답을 본다. 순수 판정만
  //   확인하면 "목록이 비면 READY"가 옳은 답이라서 아무것도 안 잡힌다.

  console.log('[스모크 상태 조회 — 장부를 못 읽은 회차 (실제 핸들러)]');

  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/autotrade/smoke-test/route');
  const Module = require('module');
  const origLoad = Module._load;
  let stub: any = null;
  // **이 라우트가 직접 부르는 적재만** 가로챈다. 요청 이름만 보고
  // 넓게 가로채면 그 사이 적재된 다른 모듈이 가짜를 물고 캐시에 남아
  // 뒤에 도는 시험이 깨진다.
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (stub && parent && parent.filename === routePath
        && /(^@\/|\/)lib\/supabase\/admin$/.test(request)) {
      return stub;
    }
    return origLoad.apply(this, arguments as any);
  };

  const ADMIN = 'smoke-status-test-secret-0123456789';
  const prevAdmin = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = ADMIN;

  /** `smoke_runs`는 읽히고 `smoke_tests`만 지정한 대로 답하는 가짜 DB */
  const statusDb = (testsReply: { data: any; error: any },
    runsReply?: { data: any; error: any }) => ({
    from(table: string) {
      const c: any = {
        select: () => c, eq: () => c, in: () => c, is: () => c,
        order: () => c, limit: () => c,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: any) => Promise.resolve(
          table === 'smoke_runs'
            ? (runsReply ?? { data: [RUN_ROW], error: null })
            : testsReply).then(res),
      };
      return c;
    },
  });

  const RUN_ROW = {
    id: 'run-1', user_id: 'u-1', symbol: 'BTCUSDT', first_side: 'LONG',
    direction_mode: 'ALTERNATE', failure_policy: 'SAFE', attempts: 3,
    margin_usd: 20, leverage: 100, hold_min: 5, state: 'RUNNING',
    created_at: '2026-10-19T00:00:00Z',
  };
  const TEST_ROWS = [
    { id: 't-1', run_id: 'run-1', user_id: 'u-1', attempt_no: 1, side: 'LONG',
      state: 'CLOSED', verdict: 'PASS', created_at: '2026-10-19T00:01:00Z' },
  ];

  const callGet = async (db: any) => {
    stub = {
      getSupabaseAdmin: () => db,
      resolveUserId: async () => null,
      getUserIdFromRequest: async () => null,
      serviceRoleKeyRole: () => 'service_role',
    };
    delete require.cache[routePath];
    try {
      const mod = require(routePath);
      const url = new URL('https://x.test/api/autotrade/smoke-test?userId=u-1');
      const res = await mod.GET({
        headers: { get: (k: string) => (k.toLowerCase() === 'x-admin-secret' ? ADMIN : null) },
        nextUrl: url, url: String(url),
      });
      return { status: res.status ?? 200, body: await res.json() };
    } finally {
      delete require.cache[routePath];
      stub = null;
    }
  };

  // ① 둘 다 읽히면 회차가 그려진다 (기준선)
  {
    const r = await callGet(statusDb({ data: TEST_ROWS, error: null }));
    test('① 장부가 읽히면 회차가 그려진다 (기준선)', () => {
      eq(r.body.ok, true, JSON.stringify(r.body).slice(0, 200));
      eq(r.body.runs?.length, 1);
      eq(r.body.runs[0].tests?.length, 1, '읽은 회차가 실려야 한다');
    });
  }

  // ② 회차 목록 조회가 **실패**하면 0건으로 그리지 않는다
  {
    const r = await callGet(statusDb({ data: null, error: { message: '회차 조회 실패' } }));
    test('★ ② 회차 목록을 못 읽으면 "회차 0건"으로 그리지 않는다', () => {
      assert(r.body.ok !== true,
        `★ 못 읽은 장부가 정상 응답으로 나갔다: ${JSON.stringify(r.body).slice(0, 300)}`);
      const view = r.body.runs?.[0];
      assert(view == null || (view.tests ?? []).length > 0,
        '★ 회차 0건짜리 묶음 화면이 그려졌다 — 다음 회차를 열 수 있다고 읽힌다');
      assert(view == null || view.advance?.code !== 'READY',
        '★ 못 읽은 장부로 "다음 회차 가능"이 나왔다');
    });
  }

  // ③ 묶음 조회 실패는 예전처럼 끊긴다 (회귀)
  {
    const r = await callGet(statusDb({ data: TEST_ROWS, error: null },
      { data: null, error: { message: '묶음 조회 실패' } }));
    test('③ 묶음 조회 실패는 그대로 끊긴다 (기존 동작)', () => {
      eq(r.body.ok, false);
      eq(r.body.error, 'query_failed');
    });
  }

  // ④ 표가 아직 없는 배포는 **고장이 아니다** (회귀)
  {
    const r = await callGet(statusDb({ data: TEST_ROWS, error: null },
      { data: null, error: { message: 'relation "smoke_runs" does not exist' } }));
    test('④ 표가 아직 없으면 table_missing으로 알린다 (고장과 구별한다)', () => {
      eq(r.body.error, 'table_missing');
    });
  }

  Module._load = origLoad;
  if (prevAdmin === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = prevAdmin;
}
