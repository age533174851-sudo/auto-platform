// Authentic HTTP handler negative tests with a fake Supabase DB.
// No network, order, cancel, database mutation or production credentials.

import { test, eq, assert } from '../harness';
import { FakeDb, withCryptoEnv } from './venueHarness';
import { encryptSecret } from '../../lib/exchanges/crypto';

const GOOD = {
  connectionId: 'conn-test', symbol: 'BTCUSDT', clientAlgoId: 'prior_stable_algo_001',
};

function req(body: any, authorized = true): any {
  return {
    headers: { get: (name: string) =>
      name.toLowerCase() === 'authorization' && authorized ? 'Bearer fake.jwt' : null },
    json: async () => body,
  };
}

function conn(over: Record<string, any> = {}) {
  return {
    id: 'conn-test', user_id: 'owner-1',
    exchange_id: 'binance', is_testnet: true,
    has_withdrawal: false, api_key: 'K'.repeat(40),
    api_secret_enc: encryptSecret('S'.repeat(40)),
    ...over,
  };
}

export function runBinanceAlgoReadRouteTests() {
  console.log('[통합 — 바이낸스 TESTNET Algo 읽기 전용 실제 라우트]');

  // One asynchronous test: it serializes module-cache substitutions,
  // avoiding test-vs-test self-interference in our lightweight harness.
  test('JWT, ownership, withdrawal and LIVE gates block before any venue GET', async () => {
    const restoreCrypto = withCryptoEnv();
    const serverPath = require.resolve('../../lib/supabase/server');
    const adminPath = require.resolve('../../lib/supabase/admin');
    const routePath = require.resolve('../../app/api/binance/futures/algo-read/route');
    try {
      async function hit(body: any, owner: string | null,
        rows: any[] = []): Promise<{ status: number; code: string; writes: number }> {
        const db = new FakeDb();
        db.seed('exchange_connections', rows);
        const prevServer = require.cache[serverPath];
        const prevAdmin = require.cache[adminPath];
        const prevRoute = require.cache[routePath];
        try {
          require.cache[serverPath] = {
            id: serverPath, filename: serverPath, loaded: true,
            exports: {
              getSupabaseAdmin: () => db,
              resolveUserId: async () => owner,
              getUserIdFromRequest: async () => owner,
              serviceRoleKeyRole: () => 'service_role',
            },
          } as any;
          delete require.cache[adminPath];
          delete require.cache[routePath];
          const { POST } = require(routePath);
          const response = await POST(req(body, owner != null));
          const json = await response.json();
          return { status: response.status, code: json.code,
            writes: db.writes.length };
        } finally {
          delete require.cache[routePath];
          delete require.cache[adminPath];
          if (prevServer) require.cache[serverPath] = prevServer;
          else delete require.cache[serverPath];
          if (prevAdmin) require.cache[adminPath] = prevAdmin;
          if (prevRoute) require.cache[routePath] = prevRoute;
        }
      }
      const cases = [
        [GOOD, null, [], 401, 'AUTH_REQUIRED'],
        [{ ...GOOD, clientAlgoId: 'bad id' }, 'owner-1', [], 400, 'INVALID_SCOPE'],
        [{ ...GOOD, symbol: 'ETHUSDT!' }, 'owner-1', [], 400, 'INVALID_SCOPE'],
        [{ ...GOOD, connectionId: '' }, 'owner-1', [], 400, 'INVALID_SCOPE'],
        [GOOD, 'owner-1', [], 409, 'VERIFIED_TESTNET_CONNECTION_REQUIRED'],
        [GOOD, 'owner-1', [conn({ user_id: 'another-owner' })],
          409, 'VERIFIED_TESTNET_CONNECTION_REQUIRED'],
        [GOOD, 'owner-1', [conn({ is_testnet: false })],
          409, 'VERIFIED_TESTNET_CONNECTION_REQUIRED'],
        [GOOD, 'owner-1', [conn({ is_testnet: null })],
          409, 'VERIFIED_TESTNET_CONNECTION_REQUIRED'],
        [GOOD, 'owner-1', [conn({ has_withdrawal: true })],
          409, 'VERIFIED_TESTNET_CONNECTION_REQUIRED'],
        [GOOD, 'owner-1', [conn({ exchange_id: 'gate' })],
          409, 'VERIFIED_TESTNET_CONNECTION_REQUIRED'],
      ] as Array<[any, string|null, any[], number, string]>;
      for (const [body, owner, rows, status, code] of cases) {
        const res = await hit(body, owner, rows);
        eq(res.status, status, JSON.stringify({ body, owner, code }));
        eq(res.code, code);
        eq(res.writes, 0, 'READ ONLY route wrote an operational row');
      }
      assert(cases.length >= 10);
    } finally { restoreCrypto(); }
  });
}
