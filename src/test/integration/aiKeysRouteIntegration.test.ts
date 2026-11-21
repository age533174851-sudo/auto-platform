// src/test/integration/aiKeysRouteIntegration.test.ts
//
// `/api/ai/keys` — 저장·삭제·조회 실패를 성공이나 "없음"으로 답하지 않는다.
//
// 예전 라우트는 Supabase가 돌려주는 `error`를 한 번도 읽지 않았다.
//   · POST  upsert 실패 → "개인 키가 등록되었습니다 … 일일 한도가 없습니다" (200)
//   · DELETE 실패        → "키가 삭제되었습니다" (200) — 키는 남아 계속 청구된다
//   · GET   조회 실패    → 키 0개 · 사용 0 · 남은 한도 전부 (200)
// supabase-js는 실패를 던지지 않고 `{ error }`로 돌려주므로 try/catch로는
// 하나도 잡히지 않았다.
//
// 실제 라우트 핸들러 + 가짜 Supabase. 실제 DB·키·외부 호출 없음.
import { test, eq, assert } from '../harness';

type Fail = { keys?: boolean; usage?: boolean; upsert?: boolean; del?: boolean };

const FAKE_UID = '00000000-0000-4000-8000-0000000000a1';
const FAKE_KEY = 'sk-' + 'x'.repeat(40);   // 형식만 맞춘 가짜 값

export async function runAiKeysRouteIntegrationTests(): Promise<void> {
  console.log('[통합 — /api/ai/keys 저장·삭제·조회 실패를 성공으로 답하지 않는다]');

  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/ai/keys/route');

  // **한 번에 하나씩 돈다.** 라우트는 `db()`에서 admin 모듈을 늦게 다시
  // 불러온다 — 시험이 겹치면 다른 시험의 가짜 DB를 집는다.
  let chain: Promise<unknown> = Promise.resolve();
  function call(method: 'GET' | 'POST' | 'DELETE', fail: Fail) {
    const run = chain.then(() => callOnce(method, fail));
    chain = run.catch(() => undefined);
    return run;
  }

  async function callOnce(method: 'GET' | 'POST' | 'DELETE', fail: Fail) {
    const oldAdmin = require.cache[adminPath];
    const oldRoute = require.cache[routePath];
    const oldKey = process.env.EXCHANGE_ENCRYPTION_KEY;
    process.env.EXCHANGE_ENCRYPTION_KEY = 'k'.repeat(64);   // 시험 전용 가짜 값

    const err = { message: 'fake db failure' };
    const writes: string[] = [];
    const fakeDb = {
      from(table: string) {
        const q: any = {
          select() { return q; },
          eq() { return q; },
          then(res: any, rej: any) {
            const bad = table === 'ai_keys' ? fail.keys : fail.usage;
            return Promise.resolve(bad ? { data: null, error: err } : { data: [], error: null })
              .then(res, rej);
          },
          upsert() {
            writes.push('upsert');
            return Promise.resolve(fail.upsert ? { data: null, error: err } : { data: null, error: null });
          },
          delete() {
            writes.push('delete');
            const d: any = {
              eq() { return d; },
              then(res: any, rej: any) {
                return Promise.resolve(fail.del ? { data: null, error: err } : { data: null, error: null })
                  .then(res, rej);
              },
            };
            return d;
          },
        };
        return q;
      },
    };
    require.cache[adminPath] = {
      id: adminPath, filename: adminPath, loaded: true,
      exports: {
        getSupabaseAdmin: () => fakeDb,
        resolveUserId: async () => FAKE_UID,
      },
    } as any;
    delete require.cache[routePath];

    const url = new URL('https://example.test/api/ai/keys');
    if (method === 'DELETE') url.searchParams.set('provider', 'openai');
    const request: any = {
      nextUrl: url, url: url.toString(),
      headers: { get(name: string) { return name.toLowerCase() === 'authorization' ? 'Bearer fake' : null; } },
      json: async () => ({ provider: 'openai', apiKey: FAKE_KEY }),
    };

    try {
      const mod = require(routePath);
      const res = await mod[method](request);
      return { status: res.status, body: await res.json(), writes };
    } finally {
      if (oldAdmin) require.cache[adminPath] = oldAdmin; else delete require.cache[adminPath];
      if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
      if (oldKey == null) delete process.env.EXCHANGE_ENCRYPTION_KEY;
      else process.env.EXCHANGE_ENCRYPTION_KEY = oldKey;
    }
  }

  // ── POST ──
  test('ai/keys POST: 저장 실패를 "등록되었습니다"로 답하지 않는다', async () => {
    const r = await call('POST', { upsert: true });
    eq(r.writes.join(','), 'upsert', '저장을 시도했다');
    eq(r.body.ok, false, 'ok:false');
    assert(r.status >= 500, `5xx여야 한다 (받은 값 ${r.status})`);
    assert(!String(r.body.message ?? '').includes('등록되었습니다'), '성공 문구가 없어야 한다');
    assert(!JSON.stringify(r.body).includes(FAKE_KEY), '키 원문이 응답에 없어야 한다');
  });
  test('ai/keys POST: 저장 성공은 그대로 성공이다', async () => {
    const r = await call('POST', {});
    eq(r.status, 200, '200');
    eq(r.body.ok, true, 'ok:true');
  });

  // ── DELETE ──
  test('ai/keys DELETE: 삭제 실패를 "삭제되었습니다"로 답하지 않는다', async () => {
    const r = await call('DELETE', { del: true });
    eq(r.writes.join(','), 'delete', '삭제를 시도했다');
    eq(r.body.ok, false, 'ok:false');
    assert(r.status >= 500, `5xx여야 한다 (받은 값 ${r.status})`);
    assert(!String(r.body.message ?? '').includes('삭제되었습니다'), '성공 문구가 없어야 한다');
  });
  test('ai/keys DELETE: 삭제 성공은 그대로 성공이다', async () => {
    const r = await call('DELETE', {});
    eq(r.status, 200, '200');
    eq(r.body.ok, true, 'ok:true');
  });

  // ── GET ──
  test('ai/keys GET: 키 조회 실패를 "키 없음 · 무료 플랜"으로 답하지 않는다', async () => {
    const r = await call('GET', { keys: true });
    eq(r.body.ok, false, 'ok:false');
    eq(r.status, 503, '503');
    eq(r.body.keys, undefined, '빈 키 목록을 싣지 않는다');
  });
  test('ai/keys GET: 사용량 조회 실패를 "사용 0 · 한도 전부 남음"으로 답하지 않는다', async () => {
    const r = await call('GET', { usage: true });
    eq(r.body.ok, false, 'ok:false');
    eq(r.status, 503, '503');
    eq(r.body.usage, undefined, '0 사용량을 싣지 않는다');
  });
  test('ai/keys GET: 조회 성공은 그대로 성공이다', async () => {
    const r = await call('GET', {});
    eq(r.status, 200, '200');
    eq(r.body.ok, true, 'ok:true');
    assert(Array.isArray(r.body.keys) && r.body.keys.length === 0, '키 0개 — 읽어서 확인한 0이다');
  });
}
