// src/lib/supabase/serverFetch.test.ts
//
// 지키는 것
//  1. 읽기(GET/HEAD)에 no-store가 붙는다 — 이게 이번 고장의 수정이다
//  2. **쓰기의 의미를 바꾸지 않는다** — POST/PATCH/DELETE는 그대로 간다
//  3. method · headers · body · signal 같은 나머지 옵션을 보존한다
//  4. 호출부가 cache를 이미 정했으면 덮지 않는다
//  5. admin client 옵션에 그 fetch가 실제로 들어간다
import { test, assert, eq } from '../../test/harness';
import { noStoreServerFetch, adminClientOptions } from './serverFetch';

/** 마지막으로 넘어온 (input, init)을 잡아 두는 가짜 fetch */
function spy() {
  const seen: { input: any; init: any }[] = [];
  const f = (async (input: any, init: any) => { seen.push({ input, init }); return { ok: true } as any; }) as any;
  return { f, seen, last: () => seen[seen.length - 1] };
}

export function runServerFetchTests() {
  console.log('\n🚿 서버 Supabase fetch (stale GET 방지)');

  // ── 1. 읽기에는 붙는다 ──
  test('GET에 cache:no-store가 붙는다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)('https://x.test/rest/v1/worker_heartbeat' as any);
    eq(s.last().init.cache, 'no-store', 'no-store');
  });

  test('method를 GET으로 명시해도 붙는다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)('https://x.test/a' as any, { method: 'GET' } as any);
    eq(s.last().init.cache, 'no-store', 'no-store');
    eq(s.last().init.method, 'GET', 'method 보존');
  });

  test('HEAD에도 붙는다 — count(head:true)가 이 경로다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)('https://x.test/a' as any, { method: 'HEAD' } as any);
    eq(s.last().init.cache, 'no-store', 'no-store');
  });

  test('소문자 method도 읽기로 본다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)('https://x.test/a' as any, { method: 'get' } as any);
    eq(s.last().init.cache, 'no-store', 'no-store');
  });

  test('Request 객체로 와도 method를 읽는다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)({ url: 'https://x.test/a', method: 'GET' } as any);
    eq(s.last().init.cache, 'no-store', 'no-store');
  });

  // ── 2. 쓰기는 그대로 ──
  test('POST에는 cache를 붙이지 않는다 — 쓰기 의미를 바꾸지 않는다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)('https://x.test/a' as any, { method: 'POST', body: '{"a":1}' } as any);
    assert(s.last().init.cache === undefined, 'POST에 cache가 붙었다');
    eq(s.last().init.method, 'POST', 'method 보존');
    eq(s.last().init.body, '{"a":1}', 'body 보존');
  });

  test('PATCH · DELETE도 그대로 간다', async () => {
    for (const m of ['PATCH', 'DELETE', 'PUT']) {
      const s = spy();
      await noStoreServerFetch(s.f)('https://x.test/a' as any, { method: m } as any);
      assert(s.last().init.cache === undefined, `${m}에 cache가 붙었다`);
    }
  });

  // ── 3. 나머지 옵션 보존 ──
  test('headers · signal · 그 밖의 옵션을 보존한다', async () => {
    const s = spy();
    const signal = { aborted: false } as any;
    await noStoreServerFetch(s.f)('https://x.test/a' as any,
      { headers: { apikey: 'K', Prefer: 'count=exact' }, signal, redirect: 'follow' } as any);
    const init = s.last().init;
    eq(init.headers.apikey, 'K', 'apikey 보존');
    eq(init.headers.Prefer, 'count=exact', 'Prefer 보존');
    eq(init.signal, signal, 'signal 보존');
    eq(init.redirect, 'follow', '그 밖의 옵션 보존');
    eq(init.cache, 'no-store', 'no-store도 붙는다');
  });

  test('init이 없어도 던지지 않고 URL을 그대로 넘긴다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)('https://x.test/rest/v1/kill_switch' as any);
    eq(s.last().input, 'https://x.test/rest/v1/kill_switch', 'input 보존');
    eq(s.last().init.cache, 'no-store', 'no-store');
  });

  // ── 4. 이미 정한 것을 덮지 않는다 ──
  test('호출부가 cache를 정했으면 덮지 않는다', async () => {
    const s = spy();
    await noStoreServerFetch(s.f)('https://x.test/a' as any, { cache: 'force-cache' } as any);
    eq(s.last().init.cache, 'force-cache', '남의 결정을 덮지 않는다');
  });

  // ── 5. client 옵션에 실제로 들어간다 ──
  test('adminClientOptions가 그 fetch를 물린다', async () => {
    const s = spy();
    const opts = adminClientOptions(s.f);
    eq(opts.auth.persistSession, false, '서버에는 세션을 남기지 않는다');
    eq(opts.auth.autoRefreshToken, false, '자동 갱신 없음');
    assert(typeof opts.global.fetch === 'function', 'fetch가 물려 있어야 한다');
    await (opts.global.fetch as any)('https://x.test/rest/v1/worker_heartbeat');
    eq(s.last().init.cache, 'no-store', '그 fetch가 no-store를 붙인다');
  });

  // ── 이번 고장 그대로 ──
  test('worker_heartbeat 최신 1줄 조회가 캐시를 타지 않는다', async () => {
    // 실제로 굳어 있던 조회의 모양 그대로.
    const s = spy();
    const url = 'https://x.test/rest/v1/worker_heartbeat'
      + '?select=worker_id%2Clast_seen%2Cstatus%2Ccurrent_task%2Cversion&order=last_seen.desc&limit=1';
    await (adminClientOptions(s.f).global.fetch as any)(url);
    eq(s.last().init.cache, 'no-store', '이 URL이 8/20에 굳어 있었다');
    eq(s.last().input, url, 'URL은 그대로 — 컬럼 모양을 바꿔 증상을 숨기지 않는다');
  });

  test('schema_migrations 조회도 같은 fetch를 탄다 — pendingCount가 굳지 않는다', async () => {
    const s = spy();
    const url = 'https://x.test/rest/v1/schema_migrations?select=filename%2Cchecksum%2Cstatus%2Cverified';
    await (adminClientOptions(s.f).global.fetch as any)(url);
    eq(s.last().init.cache, 'no-store', 'migrationGate도 같은 client를 쓴다');
  });
}
