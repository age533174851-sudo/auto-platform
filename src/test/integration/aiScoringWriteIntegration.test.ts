// 실제 AI 채점 라우트의 DB 쓰기 확인. 외부 거래소·운영 DB 호출은 전부 가짜다.
// 0행 UPDATE를 성공으로 세면 중복 크론 경합에서 거짓 채점 건수가 나온다.
import { test, eq } from '../harness';

const SECRET = 'scoring-write-ack-test-secret';

type WriteResult = { data: unknown; error: { message: string } | null };

async function runCase(writeResult: WriteResult) {
  const serverPath = require.resolve('../../lib/supabase/server');
  const routePath = require.resolve('../../app/api/cron/ai-scoring/route');
  const prevServer = require.cache[serverPath];
  const prevRoute = require.cache[routePath];
  const prevSecret = process.env.CRON_SECRET;
  const prevFetch = globalThis.fetch;
  let updateCalls = 0;
  let priceCalls = 0;
  const row = {
    id: 'prediction-1', symbol: 'BTCUSDT',
    decided_at: '2025-01-01T00:00:00.000Z',
    horizon_min: 1, entry_price: 100,
  };

  const fakeDb = {
    from(table: string) {
      if (table !== 'ai_predictions') throw new Error('unexpected table: ' + table);
      return {
        select(_fields: string) {
          return {
            is(_column: string, _value: unknown) {
              return {
                order(_sort: string, _options: unknown) {
                  return {
                    async limit(_n: number) { return { data: [row], error: null }; },
                  };
                },
              };
            },
          };
        },
        update(_value: unknown) {
          updateCalls++;
          return {
            eq(_column: string, _id: string) {
              return {
                is(_field: string, _value: unknown) {
                  // 구형 라우트는 .is() 뒤에서 바로 await 하므로, 이 객체를
                  // 반환해도 error=undefined로 보고 scored++ 한다 (RED).
                  return {
                    async select(_fields: string) { return writeResult; },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  process.env.CRON_SECRET = SECRET;
  (globalThis as any).fetch = async () => {
    priceCalls++;
    return { ok: true, json: async () => [[0, 0, 0, 0, '105']] };
  };
  require.cache[serverPath] = {
    id: serverPath, filename: serverPath, loaded: true,
    exports: { getSupabaseAdmin: () => fakeDb },
  } as any;
  delete require.cache[routePath];

  try {
    const route = require(routePath);
    const req = {
      headers: { get: (name: string) =>
        name.toLowerCase() === 'authorization' ? 'Bearer ' + SECRET : null },
      nextUrl: { searchParams: { get: (_name: string) => null } },
    };
    const response = await route.GET(req);
    return { status: response.status, body: await response.json(), updateCalls, priceCalls };
  } finally {
    if (prevRoute) require.cache[routePath] = prevRoute;
    else delete require.cache[routePath];
    if (prevServer) require.cache[serverPath] = prevServer;
    else delete require.cache[serverPath];
    (globalThis as any).fetch = prevFetch;
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
  }
}

export async function runAiScoringWriteIntegrationTests(): Promise<void> {
  console.log('[통합 — AI 채점 UPDATE 실제 반영 확인 · 오프라인]');

  // 이 테스트는 순차 실행한다. run-tests의 다른 통합 테스트가 끝난 뒤 호출.
  const raced = await runCase({ data: [], error: null });
  test('0행 UPDATE(이미 다른 크론이 채점) → scored=0', () => {
    eq(raced.status, 200);
    eq(raced.body.scored, 0, '0행 갱신을 성공 1건으로 세면 안 된다');
    eq(raced.updateCalls, 1);
    eq(raced.priceCalls, 1);
  });

  const saved = await runCase({ data: [{ id: 'prediction-1' }], error: null });
  test('반환된 정확한 ID 1행 → scored=1', () => {
    eq(saved.status, 200);
    eq(saved.body.scored, 1);
    eq(saved.body.failed, 0);
    eq(saved.updateCalls, 1);
  });

  const unknown = await runCase({ data: null, error: null });
  test('UPDATE 결과 확인 불가(null) → scored=0 · failed=1', () => {
    eq(unknown.status, 200);
    eq(unknown.body.scored, 0);
    eq(unknown.body.failed, 1);
  });
}
