// src/test/integration/kisLookupIntegration.test.ts
//
// **한국투자증권 연결 다시 테스트가 "못 읽었다"를 "그런 연결 없다"로
// 답하지 않는다.**
//
//   const { data: conn } = await sb.from('exchange_connections')…maybeSingle();
//   if (!conn) return 404 connection_not_found;
//
// `error`를 받지 않는다. 그래서 DB가 죽으면 **"연결을 찾을 수 없다"**가
// 되고, 화면은 연결을 다시 등록하라고 안내한다. 증권사 연결은 앱키·
// 시크릿·계좌번호를 다시 받아야 하므로 그 안내의 대가가 크다 —
// 연결은 그대로 있는데 사용자를 재발급으로 보낸다.
//
// 같은 파일의 upsert 쪽(145행 근처)은 **이미 올바르다** — `error`를
// 보고 `save_failed`/500으로 구분하고, 주석도 "'연결 실패'로 뭉개면
// 키를 다시 발급받으러 간다"고 적어 뒀다. 그 분별이 읽기 쪽에만
// 빠져 있었다.
//
// 실제 핸들러 + 가짜 Supabase. 실제 DB·증권사 호출 없음.
import { test, eq, assert } from '../harness';
import { NO_ROWS_CODE } from '../../lib/exchanges/connectionLookup';

const FAKE_UID = '00000000-0000-4000-8000-0000000000e1';
const CONN_ID = '00000000-0000-4000-8000-0000000000e2';

type Reply = { data: unknown; error: unknown };
const FAIL: Reply = { data: null, error: { code: '08006', message: 'connection terminated' } };
const NO_ROWS: Reply = { data: null, error: { code: NO_ROWS_CODE, details: '0 rows' } };
const EMPTY: Reply = { data: null, error: null };

export async function runKisLookupTests(): Promise<void> {
  console.log('\n[통합 — KIS 연결 테스트가 "못 읽음"을 "없음"으로 답하지 않는다]');

  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/exchange/kis/route');

  let chain: Promise<unknown> = Promise.resolve();
  function call(reply: Reply) {
    const run = chain.then(() => callOnce(reply));
    chain = run.catch(() => undefined);
    return run;
  }

  async function callOnce(reply: Reply) {
    const oldAdmin = require.cache[adminPath];
    const oldRoute = require.cache[routePath];
    const fakeDb = {
      from() {
        const q: any = {
          select() { return q; }, eq() { return q; },
          maybeSingle() { return Promise.resolve(reply); },
          single() { return Promise.resolve(reply); },
          upsert() { return q; },
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

    const url = new URL('https://example.test/api/exchange/kis');
    const request: any = {
      nextUrl: url, url: url.toString(),
      headers: { get(n: string) { return n.toLowerCase() === 'authorization' ? 'Bearer fake' : null; } },
      json: async () => ({ action: 'test', connectionId: CONN_ID }),
    };
    try {
      const mod = require(routePath);
      const res = await mod.POST(request);
      let body: any = {};
      try { body = await res.json(); } catch { body = {}; }
      return { status: res.status as number, body, thrown: null as string | null };
    } catch (e) {
      // **삼키지 않는다.** 터진 것을 "404가 아니다"로 합격시키면 거짓 초록이다.
      return { status: 0, body: {}, thrown: String(e).slice(0, 140) };
    } finally {
      if (oldAdmin) require.cache[adminPath] = oldAdmin; else delete require.cache[adminPath];
      if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    }
  }

  test('★ kis test: 조회 실패는 503 connection_unreadable 이다', async () => {
    const r = await call(FAIL);
    assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
    eq(r.status, 503, `상태 (body=${JSON.stringify(r.body)})`);
    eq(r.body?.error, 'connection_unreadable', `코드 (status=${r.status})`);
    assert(r.status !== 404, '못 읽은 것을 "그런 연결 없다"로 적었다');
  });

  test('★ kis test: 행도 오류도 없는 응답은 0행이다 (404)', async () => {
    // `.maybeSingle()`이므로 빈 응답은 진짜 "없다"다.
    const r = await call(EMPTY);
    assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
    eq(r.status, 404, `body=${JSON.stringify(r.body)}`);
    eq(r.body?.error, 'connection_not_found');
  });

  test('kis test: 진짜 0행 오류도 404다 — 막기만 하지 않는다', async () => {
    const r = await call(NO_ROWS);
    assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
    eq(r.status, 404, `body=${JSON.stringify(r.body)}`);
    eq(r.body?.error, 'connection_not_found');
  });

  test('★ kis 응답에 DB 오류 원문이 섞이지 않는다', async () => {
    const r = await call({
      data: null, error: { code: '08006', message: 'could not connect to postgres://u:pw@h/d' },
    });
    assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
    // 조회 단계까지 갔음을 먼저 고정한다 — 앞에서 멈춘 응답으로 통과시키지 않는다.
    eq(r.status, 503, `조회 단계까지 가지 않았다 (body=${JSON.stringify(r.body)})`);
    const s = JSON.stringify(r.body);
    assert(!/postgres:\/\/|pw@|password|secret|key=/i.test(s), s);
  });
}
