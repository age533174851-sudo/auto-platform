// src/test/integration/reconcileCronAuthIntegration.test.ts
//
// Issue #509: reconcile cron must never authenticate via URL query parameters.
// Actual GET handler + FakeSupabase/FakeVenue; no real DB, credentials, or orders.
import { test, eq, assert } from '../harness';
import { FakeVenue } from './venueHarness';

const SECRET = 'fake-reconcile-secret-for-tests-only';

type AuthCase = {
  label: string;
  configured: boolean;
  authorization?: string | null;
  adminHeader?: string | null;
  querySecret?: string | null;
  expectedStatus: number;
  expectedDb: boolean;
};

export async function runReconcileCronAuthIntegrationTests(): Promise<void> {
  console.log('[통합 — reconcile 크론 URL 시크릿 인증 거부 (#509)]');

  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/cron/reconcile/route');

  async function hit(c: AuthCase) {
    const oldCron = process.env.CRON_SECRET;
    const oldAdmin = process.env.ADMIN_SECRET;
    const oldAdminModule = require.cache[adminPath];
    const oldRouteModule = require.cache[routePath];
    const venue = new FakeVenue();
    const restoreVenue = venue.install();
    let adminCalls = 0;
    let dbCalls = 0;
    const fakeDb = {
      from(_table: string) {
        dbCalls++;
        return {
          select(_columns: string) { return this; },
          in(_column: string, _statuses: string[]) { return this; },
          order(_column: string, _opts: any) { return this; },
          limit(_count: number) { return Promise.resolve({ data: [], error: null }); },
        };
      },
    };

    if (c.configured) process.env.CRON_SECRET = SECRET;
    else delete process.env.CRON_SECRET;
    delete process.env.ADMIN_SECRET;
    require.cache[adminPath] = {
      id: adminPath, filename: adminPath, loaded: true,
      exports: { getSupabaseAdmin: () => { adminCalls++; return fakeDb; } },
    } as any;
    delete require.cache[routePath];

    const url = new URL('https://example.test/api/cron/reconcile');
    url.searchParams.set('dry', '1');
    if (c.querySecret != null) url.searchParams.set('secret', c.querySecret);
    const request: any = {
      nextUrl: url,
      url: url.toString(),
      headers: {
        get(name: string) {
          if (name.toLowerCase() === 'authorization') return c.authorization ?? null;
          if (name.toLowerCase() === 'x-admin-secret') return c.adminHeader ?? null;
          return null;
        },
      },
    };

    try {
      const { GET } = require(routePath);
      const response = await GET(request);
      return {
        status: response.status,
        body: await response.json(),
        adminCalls,
        dbCalls,
        venueCalls: venue.calls.length,
      };
    } finally {
      delete require.cache[routePath];
      if (oldRouteModule) require.cache[routePath] = oldRouteModule;
      if (oldAdminModule) require.cache[adminPath] = oldAdminModule;
      else delete require.cache[adminPath];
      if (oldCron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = oldCron;
      if (oldAdmin === undefined) delete process.env.ADMIN_SECRET;
      else process.env.ADMIN_SECRET = oldAdmin;
      restoreVenue();
    }
  }

  const cases: AuthCase[] = [
    { label: 'valid query secret alone must be 401', configured: true,
      querySecret: SECRET, expectedStatus: 401, expectedDb: false },
    { label: 'blank authorization + valid query secret must be 401', configured: true,
      authorization: '', querySecret: SECRET, expectedStatus: 401, expectedDb: false },
    { label: 'invalid bearer cannot be rescued by valid query secret', configured: true,
      authorization: 'Bearer invalid', querySecret: SECRET, expectedStatus: 401, expectedDb: false },
    { label: 'valid bearer still authenticates', configured: true,
      authorization: 'Bearer ' + SECRET, expectedStatus: 200, expectedDb: true },
    { label: 'valid x-admin-secret still authenticates', configured: true,
      adminHeader: SECRET, expectedStatus: 200, expectedDb: true },
    { label: 'valid bearer with invalid query still authenticates', configured: true,
      authorization: 'Bearer ' + SECRET, querySecret: 'invalid',
      expectedStatus: 200, expectedDb: true },
    { label: 'missing both configured secrets fails closed', configured: false,
      authorization: 'Bearer ' + SECRET, querySecret: SECRET,
      expectedStatus: 503, expectedDb: false },
  ];

  // Sequential: each scenario temporarily replaces the same module cache and fetch.
  for (const c of cases) {
    const got = await hit(c);
    test('#509 ' + c.label, () => {
      eq(got.status, c.expectedStatus, 'unexpected reconcile cron auth verdict');
      eq(got.adminCalls, c.expectedDb ? 1 : 0,
        'unauthenticated request reached Supabase admin boundary');
      eq(got.dbCalls, c.expectedDb ? 1 : 0,
        'unauthenticated request queried DB');
      eq(got.venueCalls, 0, 'auth test must not contact an exchange');
      assert(!JSON.stringify(got.body).includes(SECRET), 'secret leaked in response');
      if (!c.expectedDb) {
        eq(got.body.error, c.expectedStatus === 503 ? 'not_configured' : 'unauthorized');
      } else {
        eq(got.body.ok, true, 'valid header must still reach empty-result success');
        eq(got.body.targets, 0);
      }
    });
  }
}
