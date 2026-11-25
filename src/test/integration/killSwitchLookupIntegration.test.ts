// src/test/integration/killSwitchLookupIntegration.test.ts
//
// **킬스위치 라우트가 "연결을 못 읽었다"를 "그런 연결 없다"로 답하지 않는다.**
//
// 무엇이 잘못이었나
// ─────────────────
// 세 라우트가 연결을 이렇게 읽었다:
//
//   const { data: conn } = await sb.from('exchange_connections')…single();
//   if (!conn) return 404 connection_not_found;
//
// `update`·`reset`은 `error`를 **아예 받지 않았고**, `status`는 받긴
// 했지만 `if (error || !conn)`으로 같은 404에 합쳤다. 그래서 DB가
// 죽었든 권한이 막혔든 전부 **"그런 연결 없습니다"(404)**가 됐다.
//
// 왜 404가 위험한가
// ─────────────────
// 404는 호출자에게 "대상이 존재하지 않는다"는 뜻이다. 화면은 연결을
// 다시 만들라고 안내하고, 자동화는 그 연결을 목록에서 지운다. 그런데
// 사실은 연결이 그대로 있고 **우리가 읽지 못한 것**이다.
//
// 킬스위치에서는 한 겹 더 비싸다. 중지·해제·상태 조회가 404를 주면
// 그 회차는 "할 일이 없었다"로 끝난다 — 실제로는 **확인을 못 해서
// 아무것도 하지 않은 것**이다. 이 저장소 규칙 그대로다:
// UNKNOWN을 0으로 적지 않는다.
//
// 실제 라우트 핸들러 + 가짜 Supabase. 실제 DB·거래소 호출 없음.
import { test, eq, assert } from '../harness';
import { NO_ROWS_CODE } from '../../lib/exchanges/connectionLookup';

const FAKE_UID = '00000000-0000-4000-8000-0000000000b1';
const CONN_ID = '00000000-0000-4000-8000-0000000000b2';

type Reply = { data: unknown; error: unknown };

export async function runKillSwitchLookupTests(): Promise<void> {
  console.log('\n[통합 — 킬스위치가 연결 "못 읽음"을 "없음"으로 답하지 않는다]');

  const adminPath = require.resolve('../../lib/supabase/admin');
  const routes = {
    status: require.resolve('../../app/api/risk/kill-switch/status/route'),
    update: require.resolve('../../app/api/risk/kill-switch/update/route'),
    reset: require.resolve('../../app/api/risk/kill-switch/reset/route'),
  } as const;

  // **한 번에 하나씩 돈다.** 라우트는 admin 모듈을 정적으로 집으므로
  // 겹치면 다른 시험의 가짜 DB를 쓴다.
  let chain: Promise<unknown> = Promise.resolve();
  function call(which: keyof typeof routes, reply: Reply) {
    const run = chain.then(() => callOnce(which, reply));
    chain = run.catch(() => undefined);
    return run;
  }

  async function callOnce(which: keyof typeof routes, reply: Reply) {
    const routePath = routes[which];
    const oldAdmin = require.cache[adminPath];
    const oldRoute = require.cache[routePath];

    const fakeDb = {
      from(table: string) {
        const q: any = {
          select() { return q; },
          eq() { return q; },
          order() { return q; },
          limit() { return q; },
          insert() { return Promise.resolve({ data: null, error: null }); },
          upsert() { return Promise.resolve({ data: null, error: null }); },
          update() { return q; },
          single() {
            if (table === 'exchange_connections') return Promise.resolve(reply);
            return Promise.resolve({ data: null, error: { code: NO_ROWS_CODE } });
          },
          maybeSingle() {
            if (table === 'exchange_connections') return Promise.resolve(reply);
            return Promise.resolve({ data: null, error: null });
          },
          then(res: any, rej: any) {
            return Promise.resolve({ data: [], error: null }).then(res, rej);
          },
        };
        return q;
      },
    };

    require.cache[adminPath] = {
      id: adminPath, filename: adminPath, loaded: true,
      exports: { getSupabaseAdmin: () => fakeDb, resolveUserId: async () => FAKE_UID },
    } as any;
    delete require.cache[routePath];

    const url = new URL('https://example.test/api/risk/kill-switch/' + which);
    url.searchParams.set('connectionId', CONN_ID);
    const request: any = {
      nextUrl: url, url: url.toString(),
      headers: { get(n: string) { return n.toLowerCase() === 'authorization' ? 'Bearer fake' : null; } },
      json: async () => ({ connectionId: CONN_ID }),
    };

    try {
      const mod = require(routePath);
      const handler = which === 'status' ? mod.GET : mod.POST;
      const res = await handler(request);
      let body: any = {};
      try { body = await res.json(); } catch { body = {}; }
      return { status: res.status as number, body, thrown: null as string | null };
    } catch (e) {
      // **삼키지 않는다.** 예전 판은 여기서 `{ status: 500 }`을 돌려줬고,
      // 아래 단언이 "404가 아니다"만 봤기 때문에 **핸들러가 터져도 통과**했다.
      // 부정(404가 아니다)을 단언하면 터진 것과 제대로 답한 것이 같아진다.
      // 그래서 던진 것은 던진 것으로 남기고, 아래에서 계약을 직접 본다.
      return { status: 0, body: {}, thrown: String(e).slice(0, 120) };
    } finally {
      if (oldAdmin) require.cache[adminPath] = oldAdmin; else delete require.cache[adminPath];
      if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    }
  }

  const FAIL: Reply = { data: null, error: { code: '08006', message: 'connection terminated' } };
  const NO_ROWS: Reply = { data: null, error: { code: NO_ROWS_CODE, details: '0 rows' } };
  const EMPTY: Reply = { data: null, error: null };

  for (const which of ['status', 'update', 'reset'] as const) {
    test(`★ ${which}: 조회 실패는 503 connection_unreadable 이다`, async () => {
      const r = await call(which, FAIL);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 503, `못 읽은 것의 상태 (body=${JSON.stringify(r.body)})`);
      eq(r.body?.error, 'connection_unreadable', `못 읽은 것의 코드 (status=${r.status})`);
      // 부정도 함께 고정한다 — 되돌아가면 이 줄이 먼저 깨진다.
      assert(r.status !== 404, '못 읽은 것을 "그런 연결 없다"로 적었다');
      assert(r.body?.error !== 'connection_not_found', 'error=connection_not_found 로 적었다');
    });

    test(`★ ${which}: 행도 오류도 없는 응답도 503 connection_unreadable 이다`, async () => {
      // `.single()`은 0행이면 PGRST116을 준다. 둘 다 비어 온 것은
      // 대답을 못 받은 것이다.
      const r = await call(which, EMPTY);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 503, `빈 응답의 상태 (body=${JSON.stringify(r.body)})`);
      eq(r.body?.error, 'connection_unreadable', `빈 응답의 코드 (status=${r.status})`);
      assert(r.status !== 404, '대답을 못 받은 것을 "없다"로 적었다');
    });

    test(`${which}: 진짜 0행은 그대로 404다 — 막기만 하지 않는다`, async () => {
      const r = await call(which, NO_ROWS);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 404, `0행인데 404가 아니다 (body=${JSON.stringify(r.body)})`);
      eq(r.body?.error, 'connection_not_found');
    });
  }

  test('★ 응답에 DB 오류 원문이 섞이지 않는다', async () => {
    const r = await call('update', {
      data: null,
      error: { code: '08006', message: 'could not connect to postgres://user:pw@h/db' },
    });
    assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
    const s = JSON.stringify(r.body);
    assert(!/postgres:\/\/|pw@|password|secret|key=/i.test(s), s);
  });
}
