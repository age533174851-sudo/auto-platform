import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function compile(relativePath) {
  const path = new URL(`../${relativePath}`, import.meta.url);
  return ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function load(source, modules = {}) {
  const exports = {};
  runInNewContext(source, {
    exports,
    require(id) {
      assert.ok(Object.hasOwn(modules, id), `Unexpected fixture import: ${id}`);
      return modules[id];
    },
  });
  return exports;
}

const route = compile('src/app/api/binance/futures/diagnose/route.ts');
const readiness = load(compile('src/lib/engine/testnetReadiness.ts'), {
  './riskObservationEligibility': {},
});
const verdict = load(compile('src/lib/engine/testnetDiagnoseVerdict.ts'));
const evidence = load(compile('src/lib/engine/testnetVenueEvidence.ts'));

function diagnose(storedPermission, testFuturesConnection) {
  const connection = {
    exchange_id: 'binance', is_testnet: true, is_active: true, has_withdrawal: false,
    api_key: 'fixture-key', api_secret_enc: 'fixture-ciphertext', perm_trading: storedPermission,
  };
  const db = {
    from: () => ({
      select() { return this; },
      eq() { return this; },
      async single() { return { data: connection, error: null }; },
      async maybeSingle() { return { data: connection, error: null }; },
    }),
  };
  const { POST } = load(route, {
    'next/server': { NextResponse: { json: Response.json.bind(Response) } },
    '@/lib/supabase/admin': { resolveUserId: async () => 'fixture-user', getSupabaseAdmin: () => db },
    '@/lib/exchanges/crypto': { decryptSecret: () => 'fixture-secret' },
    '@/lib/engine/testnetReadiness': readiness,
    '@/lib/engine/testnetDiagnoseVerdict': verdict,
    '@/lib/engine/testnetVenueEvidence': evidence,
    '@/lib/strategies/profilePreset': { overrideOf: () => ({ leverage: 100 }) },
    '@/lib/exchanges/binanceFutures': {
      testFuturesConnection: async (_key, _secret, testnet) => {
        assert.equal(testnet, true);
        return testFuturesConnection();
      },
      getFuturesBalance: async () => ({ success: true, message: 'Fixture' }),
      getFuturesPositions: async () => ({ success: true, positions: [] }),
      getFuturesOpenOrders: async () => ({ success: true, orders: [] }),
      getFuturesTicker: async () => 90000,
      getSymbolFilters: async () => ({}),
      diagnoseFutures: async () => ({ checks: [] }),
      FUTURES_HOSTS: { demo: 'fixture-demo' },
      futuresOrderTypes: async () => ({ ok: true, orderTypes: ['STOP_MARKET'] }),
      getFuturesPositionMode: async () => ({ mode: 'ONE_WAY' }),
      getFuturesSymbolSettings: async () => ({ ok: true, marginType: 'isolated', leverage: 100 }),
      getFuturesServerTime: async () => Date.now(),
    },
  });
  return POST(new Request('http://localhost/api/binance/futures/diagnose', {
    method: 'POST', body: JSON.stringify({ connectionId: 'fixture-connection' }),
  }));
}

for (const [name, stored, response, apiStatus, permission, detail] of [
  ['인증 거절과 권한 미확인을 구분한다', true, { success: false, message: 'Fixture rejection' },
    'FAIL', 'UNKNOWN', /거래소.*확인하지 못/],
  ['인증 조회 예외와 권한 미확인을 구분한다', true, new Error('Fixture timeout'),
    'UNKNOWN', 'UNKNOWN', /거래소.*확인하지 못/],
  ['인증돼도 어댑터의 false로 거래 권한 부재를 단정하지 않는다', true, { success: true, canTrade: false },
    'PASS', 'UNKNOWN', /거래소.*확인하지 못/],
  ['거래소 응답의 권한 필드가 비어 있으면 미확인이다', true, { success: true },
    'PASS', 'UNKNOWN', /거래소.*확인하지 못/],
  ['거래소가 허용해도 저장된 권한이 비어 있으면 미확인이다', null, { success: true, canTrade: true },
    'PASS', 'UNKNOWN', /저장된.*확인하지 못/],
  ['거래소가 허용하고 저장된 권한이 꺼져 있으면 실패다', false, { success: true, canTrade: true },
    'PASS', 'FAIL', /저장된.*꺼져/],
  ['거래소와 저장된 권한이 모두 허용이면 통과다', true, { success: true, canTrade: true },
    'PASS', 'PASS', /일치/],
]) {
  test(name, async () => {
    const result = await diagnose(stored, () => {
      if (response instanceof Error) throw response;
      return response;
    });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.checks.find(check => check.name === 'API 연결')?.status, apiStatus);
    const check = body.checks.find(check => check.code === 'TRADE_PERMISSION');
    assert.equal(check?.status, permission);
    assert.equal(check.ok, permission === 'PASS');
    assert.match(check.detail, detail);
    assert.equal(body.itemCodes.find(item => item.code === 'TRADE_PERMISSION')?.status, permission);
    if (permission !== 'PASS') assert.notEqual(body.readiness.verdict, 'READY');
  });
}
