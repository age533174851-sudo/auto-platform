// 뉴스 공급자 전체 장애를 HTTP 200 / ok:true로 숨기지 않는지
// 실제 GET 핸들러를 오프라인 fetch + Fake Supabase로 확인한다.
// 인증·외부 API·운영 DB는 모두 가짜이며 실제 호출은 없다.
import { test, eq } from '../harness';

const SECRET = 'offline-news-cron-secret';
const ROUTE = '../../app/api/cron/news-sync/route';
const ENV_KEYS = ['CRON_SECRET', 'FINNHUB_API_KEY', 'FMP_API_KEY', 'NEWS_API_KEY'] as const;

type ProviderResponse = 'failed' | 'empty' | 'article';

export async function runNewsProviderOutageRouteTests(): Promise<void> {
  console.log('[통합 — 뉴스 공급자 전체 장애 (실제 라우트 · 오프라인)]');
  const routePath = require.resolve(ROUTE);
  const serverPath = require.resolve('../../lib/supabase/server');

  async function invoke(responses: Record<string, ProviderResponse>) {
    const oldEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    const oldFetch = globalThis.fetch;
    const oldServer = require.cache[serverPath];
    const oldRoute = require.cache[routePath];
    let fetchCalls = 0;
    let dbCalls = 0;

    try {
      process.env.CRON_SECRET = SECRET;
      for (const key of ['FINNHUB_API_KEY', 'FMP_API_KEY', 'NEWS_API_KEY']) {
        delete process.env[key];
      }
      if (responses.finnhub) process.env.FINNHUB_API_KEY = 'offline-key';
      if (responses.fmp) process.env.FMP_API_KEY = 'offline-key';
      if (responses.newsapi) process.env.NEWS_API_KEY = 'offline-key';

      // 목록이 비어 있는 경우에는 실제 DB를 읽을 이유가 없다.
      // .from 호출이 한 번이라도 나오면 테스트를 실패시킨다.
      require.cache[serverPath] = {
        id: serverPath, filename: serverPath, loaded: true,
        exports: { getSupabaseAdmin: () => ({
          from: () => { dbCalls++; throw new Error('unexpected DB access'); },
        }) },
      } as any;
      delete require.cache[routePath];

      globalThis.fetch = (async (url: any) => {
        fetchCalls++;
        const address = String(url);
        const provider = address.includes('finnhub.io') ? 'finnhub'
          : address.includes('financialmodelingprep.com') ? 'fmp' : 'newsapi';
        const response = responses[provider];
        if (response === 'failed') return { ok: false, status: 429 } as any;
        const article = {
          title: 'Offline fixture', url: 'https://example.test/news',
          publishedAt: '2026-10-26T00:00:00Z',
        };
        const items = response === 'article' ? [article] : [];
        return {
          ok: true,
          json: async () => provider === 'newsapi' ? { articles: items } : items,
        } as any;
      }) as typeof fetch;

      const mod = require(routePath);
      const url = new URL('https://offline.test/api/cron/news-sync');
      const req = {
        headers: { get: (key: string) =>
          key.toLowerCase() === 'authorization' ? `Bearer ${SECRET}` : null },
        nextUrl: url,
      };
      const res = await mod.GET(req);
      return { status: res.status, body: await res.json(), fetchCalls, dbCalls };
    } finally {
      globalThis.fetch = oldFetch;
      delete require.cache[routePath];
      if (oldRoute) require.cache[routePath] = oldRoute;
      if (oldServer) require.cache[serverPath] = oldServer;
      else delete require.cache[serverPath];
      for (const key of ENV_KEYS) {
        const previous = oldEnv[key];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  }

  const failed = await invoke({ finnhub: 'failed', newsapi: 'failed' });
  test('전체 공급자 429 → HTTP 503, ok:false, DB 접근 0', () => {
    eq(failed.status, 503);
    eq(failed.body.ok, false);
    eq(failed.body.error, 'news_providers_unavailable');
    eq(failed.fetchCalls, 2);
    eq(failed.dbCalls, 0);
  });

  const empty = await invoke({ finnhub: 'empty' });
  test('정상 빈 배열은 장애가 아니다 → HTTP 200, ok:true', () => {
    eq(empty.status, 200);
    eq(empty.body.ok, true);
    eq(empty.body.collected, 0);
    eq(empty.dbCalls, 0);
  });

  const partial = await invoke({ finnhub: 'failed', fmp: 'empty' });
  test('한 공급자 장애 + 다른 공급자 정상 0건 → 정상 처리', () => {
    eq(partial.status, 200);
    eq(partial.body.ok, true);
    eq(partial.fetchCalls, 2);
    eq(partial.dbCalls, 0);
  });
}
