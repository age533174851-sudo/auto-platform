// src/test/integration/futuresLookupIntegration.test.ts
//
// **선물 조회 라우트가 "못 읽었다"를 "그런 연결 없다"로 답하지 않는다.**
//
// 이 셋은 앞의 묶음과 **모양이 다르다.** `error`를 받기는 했다:
//
//   const { data: conn, error } = await sb.from('exchange_connections')…single();
//   if (error || !conn) return 404 connection_not_found;
//
// 받아서 **같은 404에 합쳤다.** 그래서 호출자 쪽에서는 받은 것과 안 받은
// 것이 구별되지 않는다 — DB가 죽어도 "그런 연결 없다"다. `error`를 아예
// 안 보는 것보다 덜 나쁘지도 않다: 코드를 읽는 사람은 `error`가 처리된
// 것으로 보고 지나간다.
//
// 그리고 **0행도 오류로 온다** — `.single()`의 0행은 PGRST116이다. 그래서
// `error`가 있다고 못 읽은 것이 아니고, 이 구분이 한 줄이 아니라서
// connectionLookup 한 곳에 둔다.
//
// 실제 핸들러 + 가짜 Supabase. 실제 DB·거래소 호출 없음.
import { test, eq, assert } from '../harness';
import { NO_ROWS_CODE } from '../../lib/exchanges/connectionLookup';

const FAKE_UID = '00000000-0000-4000-8000-0000000000d1';
const CONN_ID = '00000000-0000-4000-8000-0000000000d2';

type Reply = { data: unknown; error: unknown };
const FAIL: Reply = { data: null, error: { code: '08006', message: 'connection terminated' } };
const NO_ROWS: Reply = { data: null, error: { code: NO_ROWS_CODE, details: '0 rows' } };
const EMPTY: Reply = { data: null, error: null };

export async function runFuturesLookupTests(): Promise<void> {
  console.log('\n[통합 — 선물 조회가 연결 "못 읽음"을 "없음"으로 답하지 않는다]');

  const adminPath = require.resolve('../../lib/supabase/admin');
  const routes = {
    'futures/account': { p: require.resolve('../../app/api/binance/futures/account/route'), m: 'GET' },
    'futures/brackets': { p: require.resolve('../../app/api/binance/futures/brackets/route'), m: 'GET' },
    'futures/diagnose': { p: require.resolve('../../app/api/binance/futures/diagnose/route'), m: 'POST' },
  } as const;

  let chain: Promise<unknown> = Promise.resolve();
  function call(which: keyof typeof routes, reply: Reply) {
    const run = chain.then(() => callOnce(which, reply));
    chain = run.catch(() => undefined);
    return run;
  }

  async function callOnce(which: keyof typeof routes, reply: Reply) {
    const { p: routePath, m: method } = routes[which];
    const oldAdmin = require.cache[adminPath];
    const oldRoute = require.cache[routePath];
    const fakeDb = {
      from(table: string) {
        const q: any = {
          select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return q; },
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
          then(res: any, rej: any) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
        };
        return q;
      },
    };
    require.cache[adminPath] = {
      id: adminPath, filename: adminPath, loaded: true,
      exports: { getSupabaseAdmin: () => fakeDb, resolveUserId: async () => FAKE_UID },
    } as any;
    delete require.cache[routePath];

    const url = new URL('https://example.test/api/binance/' + which);
    url.searchParams.set('connectionId', CONN_ID);
    // `brackets`는 연결 조회 **전에** symbol을 요구한다. 없으면
    // `missing_symbol`에서 멈추고, 그 응답으로도 "404가 아니다"는
    // 통과한다 — 조회 단계까지 가지 못한 시험은 아무것도 증명하지 않는다.
    url.searchParams.set('symbol', 'BTCUSDT');
    const request: any = {
      nextUrl: url, url: url.toString(),
      headers: { get(n: string) { return n.toLowerCase() === 'authorization' ? 'Bearer fake' : null; } },
      json: async () => ({ connectionId: CONN_ID }),
    };
    try {
      const mod = require(routePath);
      const res = await mod[method](request);
      let body: any = {};
      try { body = await res.json(); } catch { body = {}; }
      return { status: res.status as number, body, thrown: null as string | null };
    } catch (e) {
      // **삼키지 않는다.** 터진 것을 "404가 아니다"로 합격시키면 거짓 초록이다.
      return { status: 0, body: {}, thrown: String(e).slice(0, 120) };
    } finally {
      if (oldAdmin) require.cache[adminPath] = oldAdmin; else delete require.cache[adminPath];
      if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    }
  }

  for (const which of ['futures/account', 'futures/brackets', 'futures/diagnose'] as const) {
    test(`★ ${which}: 조회 실패는 503 connection_unreadable 이다`, async () => {
      const r = await call(which, FAIL);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 503, `상태 (body=${JSON.stringify(r.body)})`);
      eq(r.body?.error, 'connection_unreadable', `코드 (status=${r.status})`);
      assert(r.status !== 404, '못 읽은 것을 "그런 연결 없다"로 적었다');
    });

    test(`★ ${which}: 행도 오류도 없는 응답도 503 connection_unreadable 이다`, async () => {
      const r = await call(which, EMPTY);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 503, `상태 (body=${JSON.stringify(r.body)})`);
      eq(r.body?.error, 'connection_unreadable');
    });

    test(`${which}: 진짜 0행은 그대로 404다 — 막기만 하지 않는다`, async () => {
      const r = await call(which, NO_ROWS);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 404, `body=${JSON.stringify(r.body)}`);
      eq(r.body?.error, 'connection_not_found');
    });
  }

  test('★ 선물 응답에 DB 오류 원문이 섞이지 않는다', async () => {
    const r = await call('futures/account', {
      data: null, error: { code: '08006', message: 'could not connect to postgres://u:pw@h/d' },
    });
    assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
    // 인증 단계에서 멈춘 응답으로 통과시키지 않는다 — 조회까지 갔음을 먼저 고정한다.
    eq(r.status, 503, `조회 단계까지 가지 않았다 (body=${JSON.stringify(r.body)})`);
    const s = JSON.stringify(r.body);
    assert(!/postgres:\/\/|pw@|password|secret|key=/i.test(s), s);
  });
}
