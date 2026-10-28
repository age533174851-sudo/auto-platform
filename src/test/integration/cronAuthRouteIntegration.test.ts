// src/test/integration/cronAuthRouteIntegration.test.ts
//
// **다섯 크론의 실제 GET 핸들러를 두드린다.**
//
// 왜 유닛 시험으로는 부족한가
// ───────────────────────────
// `cronAuthVerdict`가 옳아도 **라우트가 그걸 안 부르면** 아무 소용이
// 없다. 예전 코드는 다섯 곳에 각자 적고 있었고, 그래서 다섯 벌이
// 같이 틀렸다 — 판정을 한 곳에 모았다는 사실 자체를 확인해야 한다.
//
// 그리고 더 중요한 것:
//
//   **인증에 실패한 호출이 DB와 외부 API를 건드리지 않는가.**
//
// 401을 돌려주는 것만으로는 부족하다. 401을 주기 **전에** 행을 지웠거나
// 유료 AI를 불렀으면, 막은 것이 아니라 막은 척한 것이다. cleanup은
// 행을 지우고, news-sync·calendar-sync는 외부 한도를 태우고,
// ai-enrichment·ai-scoring은 돈이 나간다.
//
// 그래서 두 경계를 **건드리면 터지게** 바꿔 놓고 부른다:
//   · Supabase — 어떤 속성에 손대도 던지는 Proxy
//   · fetch    — 규칙 없는 FakeVenue (호출 자체가 예외) + 호출 수 0 확인

import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';

const SECRET = 'cron-secret-0123456789abcdef';

/** 손대는 순간 시험이 실패하는 가짜 DB */
function forbiddenDb(touched: string[]): any {
  return new Proxy({}, {
    get(_t, prop) {
      const name = String(prop);
      // 런타임이 들여다보는 몇 가지는 조용히 넘긴다 — 그건 접근이 아니다.
      if (name === 'then' || name === Symbol.toStringTag.toString()) return undefined;
      touched.push(name);
      throw new Error(`인증 전에 DB에 손댔습니다: .${name}`);
    },
  });
}

const ROUTES = [
  { name: 'cleanup', path: '../../app/api/cron/cleanup/route' },
  { name: 'news-sync', path: '../../app/api/cron/news-sync/route' },
  { name: 'calendar-sync', path: '../../app/api/cron/calendar-sync/route' },
  { name: 'ai-enrichment', path: '../../app/api/cron/ai-enrichment/route' },
  { name: 'ai-scoring', path: '../../app/api/cron/ai-scoring/route' },
];

function req(authorization: string | null, querySecret: string | null = null): any {
  const u = new URL('https://x.test/api/cron/x');
  if (querySecret != null) u.searchParams.set('secret', querySecret);
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? authorization : null) },
    nextUrl: u,
    url: u.toString(),
    json: async () => ({}),
  };
}

export async function runCronAuthRouteTests(): Promise<void> {
  console.log('[통합 — 크론 인증 (실제 핸들러 · DB 0 · 외부 호출 0)]');

  const serverPath = require.resolve('../../lib/supabase/server');
  const adminPath = require.resolve('../../lib/supabase/admin');

  // ── 임시 디렉터리에는 `node_modules`가 없다 ──
  //
  // `ai-enrichment`가 끌어오는 `@/lib/ai/providers`는 맨 위에서
  // `import Anthropic from '@anthropic-ai/sdk'`를 한다. 러너는 `src`만
  // 복사해 돌리므로 그 패키지를 찾지 못하고, **라우트를 올리는 것조차**
  // 못 한다 — 그러면 이 경로만 검증에서 빠진다. 비싼 호출이 나가는
  // 바로 그 경로다.
  //
  // 인증은 그 패키지를 쓰지 않는다. 모듈이 **올라가기만** 하면 되므로
  // 빈 껍데기로 바꿔 끼운다.
  const Module = require('module');
  const STUB_ID = '\u0000cron-auth-test-stub';
  require.cache[STUB_ID] = {
    id: STUB_ID, filename: STUB_ID, loaded: true,
    exports: { __esModule: true, default: class {}, },
  } as any;
  const STUBBED = ['@anthropic-ai/sdk', 'openai', '@google/generative-ai'];
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: any[]) {
    if (STUBBED.includes(request)) return STUB_ID;
    return origResolve.call(this, request, ...rest);
  };
  const restoreResolve = () => {
    Module._resolveFilename = origResolve;
    delete require.cache[STUB_ID];
  };

  /**
   * 라우트를 **가짜 경계에 붙여 새로** 불러온다.
   *
   * 시나리오는 순차로 돌린다 — `test()`는 async 본문을 pending에 넣고
   * 바로 돌아오므로, 여러 개를 띄우면 서로의 fetch 스텁을 덮어쓴다
   * (orderPathIntegration.test.ts 87행 주석과 같은 이유).
   */
  async function hit(routePath: string, opts: {
    secret?: string | undefined; authorization: string | null; querySecret?: string | null;
  }) {
    const prevSecret = process.env.CRON_SECRET;
    if (opts.secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = opts.secret;

    const touched: string[] = [];
    const venue = new FakeVenue();           // 규칙이 없다 — 부르면 던진다
    const restoreVenue = venue.install();

    const resolved = require.resolve(routePath);
    const prevServer = require.cache[serverPath];
    const prevAdmin = require.cache[adminPath];
    require.cache[serverPath] = {
      id: serverPath, filename: serverPath, loaded: true, exports: {
        getSupabaseAdmin: () => forbiddenDb(touched),
        resolveUserId: async () => null,
        getUserIdFromRequest: async () => null,
        serviceRoleKeyRole: () => 'service_role',
      },
    } as any;
    delete require.cache[adminPath];
    delete require.cache[resolved];

    try {
      const mod = require(resolved);
      const res = await mod.GET(req(opts.authorization, opts.querySecret ?? null));
      return { status: res.status, json: await res.json(), touched, venue };
    } finally {
      delete require.cache[resolved];
      delete require.cache[adminPath];
      if (prevServer) require.cache[serverPath] = prevServer; else delete require.cache[serverPath];
      if (prevAdmin) require.cache[adminPath] = prevAdmin;
      restoreVenue();
      if (prevSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevSecret;
    }
  }

  /** 모든 거절에서 참이어야 하는 것 */
  function noSideEffects(label: string, r: { touched: string[]; venue: FakeVenue }) {
    eq(r.touched.length, 0, `${label}: 인증 전에 DB에 손댔습니다 (${r.touched.join(', ')})`);
    eq(r.venue.calls.length, 0, `${label}: 인증 전에 외부를 호출했습니다`);
  }

  // ══════════ ① CRON_SECRET 미설정·빈 값·공백 → 503 ══════════
  for (const [label, secret] of [
    ['미설정', undefined], ['빈 값', ''], ['공백', '   '],
  ] as Array<[string, any]>) {
    for (const r of ROUTES) {
      const got = await hit(r.path, { secret, authorization: `Bearer ${SECRET}` });
      test(`① ${r.name}: CRON_SECRET ${label} → 503 · DB 0 · 외부 0`, () => {
        eq(got.status, 503,
          '비밀이 없는 것은 "아무나 통과"가 아니다 — 열려 있으면 익명 호출이 들어온다');
        eq(got.json.error, 'not_configured');
        noSideEffects(`${r.name}/${label}`, got);
      });
    }
  }

  // ══════════ ② 잘못된 인증 → 401 ══════════
  for (const [label, given] of [
    ['헤더 없음', null], ['틀린 값', 'Bearer wrong-value'], ['접두사만', 'Bearer '],
  ] as Array<[string, any]>) {
    for (const r of ROUTES) {
      const got = await hit(r.path, { secret: SECRET, authorization: given });
      test(`② ${r.name}: ${label} → 401 · DB 0 · 외부 0`, () => {
        eq(got.status, 401);
        eq(got.json.error, 'unauthorized');
        noSideEffects(`${r.name}/${label}`, got);
      });
    }
  }

  // ══════════ ③ 틀린 헤더를 맞는 질의로 우회할 수 없다 ══════════
  {
    const got = await hit(ROUTES[0].path,
      { secret: SECRET, authorization: 'Bearer wrong', querySecret: SECRET });
    test('③ 헤더가 틀렸으면 맞는 ?secret= 가 있어도 401이다', () => {
      eq(got.status, 401);
      noSideEffects('우회 시도', got);
    });
  }

  // ══════════ ④ 통과하면 인증에서 막히지 않는다 ══════════
  //
  // **과잉 차단 방지.** 위를 통과시키려고 전부 막으면 크론이 통째로 멎는다.
  //
  // 상태 코드만 보면 안 된다 — 인증을 통과한 뒤에도 503이 날 수 있다
  // (뉴스·달력은 공급자 키가 없고, ai-enrichment는 AI 키가 없다).
  // 그건 인증이 막은 것이 아니라 **그 다음 관문**이 막은 것이다.
  // 그래서 인증이 내는 두 표식으로 가른다: `unauthorized` ·
  // `not_configured`(CRON_SECRET 사유).
  for (const r of ROUTES) {
    let err: any = null; let msg = ''; let threw = false;
    try {
      const got = await hit(r.path, { secret: SECRET, authorization: `Bearer ${SECRET}` });
      err = got.json?.error ?? null;
      msg = String(got.json?.message ?? '');
    } catch { threw = true; }   // 가짜 DB·fetch가 던진 것 — 인증은 통과했다는 뜻
    test(`④ ${r.name}: 올바른 인증은 인증 단계에서 막히지 않는다`, () => {
      if (threw) { assert(true); return; }
      assert(err !== 'unauthorized', '올바른 인증이 401로 막혔습니다');
      assert(!msg.includes('CRON_SECRET'),
        `올바른 인증이 크론 인증 503으로 막혔습니다: ${msg}`);
    });
  }


  // ══════════ ⑤ cleanup: PostgREST count 미확인은 0건이 아니다 ══════════
  //
  // Supabase head:true count는 number | null이다. 기존 Number(null) || 0은
  // "세지 못함"을 "지울 것이 없음"으로 바꾸고 HTTP 200 성공으로 남겼다.
  // 전체 건수 null도 0으로 바꿔 checkDeleteSize의 전체 삭제 관문을 우회했다.
  // 실제 DB 대신 가짜 select/delete만 사용하며 어떤 운영 데이터도 건드리지 않는다.
  async function cleanupCountCase(eligibleCount: unknown, totalCount: unknown) {
    const prevSecret = process.env.CRON_SECRET;
    const resolved = require.resolve(ROUTES[0].path);
    const prevServer = require.cache[serverPath];
    let deleteCalls = 0;
    const fakeDb = {
      from(table: string) {
        const pk = table === 'news_articles' ? 'hash' : 'id';
        return {
          select(_column: string, opts?: { head?: boolean }) {
            if (opts?.head) {
              let eligibleQuery = false;
              return {
                lt() { eligibleQuery = true; return this; },
                then(resolve: any, reject: any) {
                  return Promise.resolve({
                    error: null, count: eligibleQuery ? eligibleCount : totalCount,
                  }).then(resolve, reject);
                },
              };
            }
            let cursor: string | null = null;
            let take = 200;
            return {
              lt() { return this; },
              order() { return this; },
              gt(_col: string, id: string) { cursor = id; return this; },
              limit(n: number) { take = n; return this; },
              then(resolve: any, reject: any) {
                const count = typeof eligibleCount === 'number' ? eligibleCount : 0;
                const ids = Array.from({ length: Math.max(0, count) },
                  (_, i) => String(i).padStart(6, '0'));
                return Promise.resolve({
                  error: null, data: ids.filter(id => cursor == null || id > cursor)
                    .slice(0, take).map(id => ({ [pk]: id })),
                }).then(resolve, reject);
              },
            };
          },
          delete() {
            let ids: string[] = [];
            return {
              in(_col: string, selected: string[]) { ids = selected; return this; },
              lt() { return this; },
              select() {
                deleteCalls++;
                return Promise.resolve({
                  error: null, data: ids.map(id => ({ [pk]: id })),
                });
              },
            };
          },
        };
      },
    };
    process.env.CRON_SECRET = SECRET;
    require.cache[serverPath] = {
      id: serverPath, filename: serverPath, loaded: true,
      exports: { getSupabaseAdmin: () => fakeDb },
    } as any;
    delete require.cache[resolved];
    try {
      const mod = require(resolved);
      const request = req(`Bearer ${SECRET}`);
      request.nextUrl.searchParams.set('apply', '1');
      const res = await mod.GET(request);
      return { status: res.status, json: await res.json(), deleteCalls };
    } finally {
      delete require.cache[resolved];
      if (prevServer) require.cache[serverPath] = prevServer;
      else delete require.cache[serverPath];
      if (prevSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevSecret;
    }
  }

  for (const [label, count] of [
    ['null', null], ['undefined', undefined], ['NaN', NaN],
    ['문자열 0', '0'], ['음수', -1], ['소수', 1.5],
  ] as Array<[string, unknown]>) {
    const got = await cleanupCountCase(count, 10);
    test(`⑤ cleanup eligible count ${label}: 삭제 0 · 미확인으로 보고`, () => {
      eq(got.deleteCalls, 0, '세지 못했는데 삭제했다');
      eq(got.json.ok, false, 'COUNT 미확인을 cleanup 성공으로 보고했다');
      eq(got.status, 207, 'COUNT 미확인은 부분 실패로 드러나야 한다');
      for (const table of got.json.tables) {
        eq(table.eligible, null, '미확인 count를 0건으로 바꾸면 안 된다');
        assert(table.skipped.includes('조회'), '미확인인데 지울 것 없음으로 보고했다');
      }
    });
  }

  for (const [label, count] of [
    ['null', null], ['undefined', undefined], ['NaN', NaN],
    ['문자열 0', '0'], ['음수', -1],
  ] as Array<[string, unknown]>) {
    const got = await cleanupCountCase(2, count);
    test(`⑤ cleanup total count ${label}: 전체 삭제 방어 우회 금지`, () => {
      eq(got.deleteCalls, 0, '전체 건수를 모른 채 삭제했다');
      eq(got.json.ok, false, '전체 COUNT 미확인을 cleanup 성공으로 보고했다');
      eq(got.status, 207);
      for (const table of got.json.tables) {
        eq(table.total, null, '전체 건수 미확인을 0으로 바꾸면 안 된다');
        assert(table.skipped.includes('조회'), '전체 건수 조회 실패를 드러내지 않았다');
      }
    });
  }

  const empty = await cleanupCountCase(0, 10);
  test('⑤ cleanup 정상 0건: 삭제 0 · 지울 것 없음', () => {
    eq(empty.deleteCalls, 0);
    eq(empty.json.ok, true, '정상 0건을 실패로 처리했다');
    eq(empty.status, 200);
    for (const table of empty.json.tables) {
      eq(table.eligible, 0);
      eq(table.skipped, '지울 것 없음');
    }
  });


  const safetyStop = await cleanupCountCase(5_001, 10_000);
  test('★★ cleanup 삭제 상한 거부는 HTTP 200 ok:true가 아니다', () => {
    eq(safetyStop.deleteCalls, 0);
    eq(safetyStop.json.ok, false);
    eq(safetyStop.status, 207);
    assert(safetyStop.json.tables.some((t: any) => t.skipped.includes('상한')));
  });

  const fullStop = await cleanupCountCase(10, 10);
  test('★★ cleanup 전체 삭제 차단은 완료로 보고하지 않는다', () => {
    eq(fullStop.deleteCalls, 0);
    eq(fullStop.json.ok, false);
    eq(fullStop.status, 207);
    assert(fullStop.json.tables.some((t: any) => t.skipped.includes('전체')));
  });

  const partial = await cleanupCountCase(2, 10);
  test('⑤ cleanup 정상 부분 삭제: 가짜 DB만 호출 · 과잉 차단 없음', () => {
    eq(partial.deleteCalls, 2, 'news_articles/ai_usage 두 표만 처리한다');
    eq(partial.json.totalDeleted, 4);
    eq(partial.json.ok, true);
    eq(partial.status, 200);
    for (const table of partial.json.tables) {
      eq(table.eligible, 2);
      eq(table.total, 10);
      eq(table.deleted, 2);
    }
  });


  // ══════════ ⑥ cleanup: COUNT와 DELETE 사이 동시 삽입 (Issue #471) ══════════
  // 실제 GET + 가짜 Supabase. COUNT 시점 4,999건, DELETE 시점 5,099건.
  // DELETE는 반드시 사전에 선택한 PK의 유한 집합으로만 수행해야 한다.
  async function cleanupConcurrentInsertCase(dropOne = false) {
    const prevSecret = process.env.CRON_SECRET;
    const resolved = require.resolve(ROUTES[0].path);
    const prevServer = require.cache[serverPath];
    const rows = Array.from({ length: 5_099 }, (_, i) => ({
      hash: `h${String(i).padStart(6, '0')}`, published_at: '2020-01-01T00:00:00Z',
    }));
    const calls: string[] = [];
    let deleted = 0;
    let dropped = false;
    const fakeDb = {
      from(table: string) {
        const pk = table === 'news_articles' ? 'hash' : table === 'ai_usage' ? 'id' : 'cache_key';
        const source = table === 'news_articles' ? rows : [];
        return {
          select(column: string, opts?: { head?: boolean }) {
            if (opts?.head) {
              let eligibleQuery = false;
              return {
                lt() { eligibleQuery = true; return this; },
                then(resolve: any, reject: any) {
                  return Promise.resolve({
                    error: null,
                    count: table === 'news_articles' ? (eligibleQuery ? 4_999 : 10_000)
                      : (eligibleQuery ? 0 : 10),
                  }).then(resolve, reject);
                },
              };
            }
            let cursor: string | null = null;
            let limit = 500;
            return {
              lt() { return this; },
              order() { return this; },
              gt(_column: string, value: string) { cursor = value; return this; },
              limit(n: number) { limit = n; return this; },
              then(resolve: any, reject: any) {
                calls.push('select_ids');
                const selected = source.filter(r => cursor == null || String((r as any)[pk]) > cursor!)
                  .slice(0, limit).map(r => ({ [pk]: (r as any)[pk] }));
                return Promise.resolve({ error: null, data: selected }).then(resolve, reject);
              },
            };
          },
          delete() {
            let selectedIds: string[] | null = null;
            return {
              in(_column: string, ids: string[]) { selectedIds = ids; return this; },
              lt() {
                if (selectedIds) return this;
                // 이전 코드의 무제한 .delete().lt() 경로.
                calls.push('unbounded_delete');
                deleted += source.length;
                source.splice(0, source.length);
                return Promise.resolve({ error: null });
              },
              select(_column: string) {
                calls.push('bounded_delete');
                const ids = new Set(selectedIds || []);
                if (dropOne && !dropped && ids.size > 0) {
                  const first = ids.values().next().value;
                  if (first) { ids.delete(first); dropped = true; } // DELETE 전에 1행이 다른 워커에 의해 삭제됨
                }
                const removed = source.filter(r => ids.has(String((r as any)[pk])));
                for (const r of removed) {
                  const at = source.indexOf(r);
                  if (at >= 0) source.splice(at, 1);
                }
                deleted += removed.length;
                return Promise.resolve({
                  error: null, data: removed.map(r => ({ [pk]: (r as any)[pk] })),
                });
              },
            };
          },
        };
      },
    };
    process.env.CRON_SECRET = SECRET;
    require.cache[serverPath] = {
      id: serverPath, filename: serverPath, loaded: true,
      exports: { getSupabaseAdmin: () => fakeDb },
    } as any;
    delete require.cache[resolved];
    try {
      const mod = require(resolved);
      const request = req(`Bearer ${SECRET}`);
      request.nextUrl.searchParams.set('apply', '1');
      const res = await mod.GET(request);
      return { status: res.status, json: await res.json(), deleted, calls };
    } finally {
      delete require.cache[resolved];
      if (prevServer) require.cache[serverPath] = prevServer;
      else delete require.cache[serverPath];
      if (prevSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevSecret;
    }
  }

  const race = await cleanupConcurrentInsertCase();
  test('★★ #471 COUNT 4999 뒤 100행 삽입되어도 DELETE 4999 이하 · PK 고정', () => {
    eq(race.deleted, 4_999, 'COUNT 뒤에 생긴 100행까지 삭제했다');
    assert(!race.calls.includes('unbounded_delete'), '삭제 대상 ID를 고정하지 않았다');
    eq(race.json.tables.find((t: any) => t.table === 'news_articles')?.deleted, 4_999);
    eq(race.json.totalDeleted, 4_999);
  });

  const raceDrop = await cleanupConcurrentInsertCase(true);
  test('★★ #471 실제 DELETE 결과가 4998이면 사전 COUNT 4999를 성공 건수로 기록하지 않는다', () => {
    eq(raceDrop.deleted, 4_998);
    eq(raceDrop.json.tables.find((t: any) => t.table === 'news_articles')?.deleted, 4_998);
    eq(raceDrop.json.totalDeleted, 4_998);
    eq(raceDrop.json.ok, false, '4999 대상 중 4998 삭제를 전체 성공으로 보고했다');
    eq(raceDrop.status, 207);
  });

  restoreResolve();
}
