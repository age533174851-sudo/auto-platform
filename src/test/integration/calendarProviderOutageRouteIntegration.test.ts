// 실제 calendar-sync GET 핸들러를 오프라인 가짜 공급자/DB로 검증한다.
// 외부 네트워크·운영 DB 접근 없이 실패/빈 응답/부분 성공을 구분한다.
import { test, eq } from '../harness';

type Feed = { ok: boolean; data?: unknown };
type Scenario = {
  te?: Feed;
  fred?: Feed;
  fmp?: Feed;
};

async function hit(s: Scenario) {
  const keys = ['CRON_SECRET', 'TRADING_ECONOMICS_API_KEY', 'FRED_API_KEY', 'FMP_API_KEY'] as const;
  const savedEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.CRON_SECRET = 'offline-calendar-cron-secret';
  for (const k of keys.slice(1)) delete process.env[k];
  if (s.te) process.env.TRADING_ECONOMICS_API_KEY = 'fake-te-key';
  if (s.fred) process.env.FRED_API_KEY = 'fake-fred-key';
  if (s.fmp) process.env.FMP_API_KEY = 'fake-fmp-key';

  const routePath = require.resolve('../../app/api/cron/calendar-sync/route');
  const serverPath = require.resolve('../../lib/supabase/server');
  const cronLogPath = require.resolve('../../lib/system/cronLog');
  const oldRoute = require.cache[routePath];
  const oldServer = require.cache[serverPath];
  const oldLog = require.cache[cronLogPath];
  const oldFetch = globalThis.fetch;
  let dbTouches = 0;
  const calls: string[] = [];
  const logs: string[] = [];

  require.cache[serverPath] = {
    id: serverPath, filename: serverPath, loaded: true,
    exports: {
      getSupabaseAdmin: () => ({
        from: () => { dbTouches++; throw new Error('오프라인 테스트에서 DB 접근 금지'); },
      }),
      resolveUserId: async () => null,
    },
  } as any;
  require.cache[cronLogPath] = {
    id: cronLogPath, filename: cronLogPath, loaded: true,
    exports: {
      recordCronRun: async (_sb: unknown, _name: string, status: string) => {
        logs.push(status);
        return { error: null };
      },
    },
  } as any;
  delete require.cache[routePath];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const feed = u.includes('tradingeconomics.com') ? s.te
      : u.includes('stlouisfed.org') ? s.fred
      : u.includes('financialmodelingprep.com') ? s.fmp : undefined;
    if (!feed) throw new Error('예상하지 못한 외부 호출');
    return { ok: feed.ok, json: async () => feed.data } as Response;
  }) as typeof fetch;

  try {
    const route = require(routePath);
    const req = {
      headers: { get: (name: string) => name.toLowerCase() === 'authorization'
        ? 'Bearer offline-calendar-cron-secret' : null },
      nextUrl: new URL('https://offline.test/api/cron/calendar-sync'),
    };
    const res = await route.GET(req);
    return { status: res.status, body: await res.json(), dbTouches, calls, logs };
  } finally {
    globalThis.fetch = oldFetch;
    delete require.cache[routePath];
    if (oldRoute) require.cache[routePath] = oldRoute;
    if (oldServer) require.cache[serverPath] = oldServer; else delete require.cache[serverPath];
    if (oldLog) require.cache[cronLogPath] = oldLog; else delete require.cache[cronLogPath];
    for (const k of keys) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

export async function runCalendarProviderOutageRouteTests(): Promise<void> {
  console.log('[통합 — 경제 캘린더 공급자 장애 / 정상 0건]');
  {
    const r = await hit({ te: { ok: false } });
    test('TE 503만 발생 → 503·ok:false·DB 접근 0', () => {
      eq(r.status, 503);
      eq(r.body.ok, false);
      eq(r.body.error, 'calendar_providers_unavailable');
      eq(r.dbTouches, 0);
      eq(r.calls.length, 1);
    });
  }
  {
    const r = await hit({ fred: { ok: false } });
    test('FRED 429만 발생 → 키 없음이 아니라 공급자 장애', () => {
      eq(r.status, 503);
      eq(r.body.error, 'calendar_providers_unavailable');
      eq(r.dbTouches, 0);
    });
  }
  {
    const r = await hit({ fred: { ok: true, data: { release_dates: [] } } });
    test('FRED 정상 빈 일정 → 200·ok:true·skipped 기록', () => {
      eq(r.status, 200);
      eq(r.body.ok, true);
      eq(r.body.saved, 0);
      eq(r.logs.join(','), 'skipped');
      eq(r.dbTouches, 0);
    });
  }
  {
    const r = await hit({ te: { ok: true, data: [] }, fmp: { ok: false } });
    test('TE 정상 빈 응답 + FMP 장애 → 정상 부분 성공', () => {
      eq(r.status, 200);
      eq(r.body.ok, true);
      eq(r.calls.length, 2);
      eq(r.dbTouches, 0);
    });
  }
  {
    const r = await hit({});
    test('공급자 키가 전혀 없음 → 설정 오류 503·외부 호출 0', () => {
      eq(r.status, 503);
      eq(r.body.ok, false);
      eq(r.calls.length, 0);
      eq(r.dbTouches, 0);
    });
  }
}
