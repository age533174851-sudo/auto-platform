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
const connLookup = load(compile('src/lib/exchanges/connectionLookup.ts'));

function diagnose(storedPermission, testFuturesConnection, getFuturesBalance =
  async () => ({ success: true, balances: [], message: '0개 자산' })) {
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
    '@/lib/exchanges/connectionLookup': connLookup,
    '@/lib/strategies/profilePreset': { overrideOf: () => ({ leverage: 100 }) },
    '@/lib/exchanges/binanceFutures': {
      testFuturesConnection: async (_key, _secret, testnet) => {
        assert.equal(testnet, true);
        return testFuturesConnection();
      },
      getFuturesBalance,
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

const balance = { asset: 'USDT', balance: 12, availableBalance: 5 };
const balanceRead = (balances) => ({ success: true, balances, message: '조회 성공' });
for (const [name, snapshot, expected, expectedCode] of [
  ['금액 누락으로 NaN이 된 잔고는 미확인이다',
    balanceRead([{ ...balance, availableBalance: NaN }]), 'UNKNOWN', 'BALANCE_UNREADABLE'],
  ['무한대 잔고는 미확인이다',
    balanceRead([{ ...balance, balance: Infinity }]), 'UNKNOWN', 'BALANCE_UNREADABLE'],
  ['자산 식별자가 누락된 잔고는 미확인이다',
    balanceRead([{ ...balance, asset: undefined }]), 'UNKNOWN', 'BALANCE_UNREADABLE'],
  ['잔고 목록이 없는 성공 응답은 미확인이다',
    balanceRead(undefined), 'UNKNOWN', 'BALANCE_UNREADABLE'],
  ['잔고 목록에 판독 불가 항목이 섞이면 미확인이다',
    balanceRead([balance, null]), 'UNKNOWN', 'BALANCE_UNREADABLE'],
  ['0 잔고가 생략돼 빈 목록이면 조회 성공이다',
    balanceRead([]), 'PASS', null],
  ['잔고와 사용 가능 잔고가 판독되면 사용 가능 잔고 0도 조회 성공이다',
    balanceRead([{ ...balance, availableBalance: 0 }]), 'PASS', null],
  ['거래소 조회 실패는 실패 사유를 보여 준다',
    { success: false, message: '모의 잔고 조회 실패' }, 'FAIL', null],
]) {
  test(name, async () => {
    const result = await diagnose(true, () => ({ success: true, canTrade: true }), async () => snapshot);
    assert.equal(result.status, 200);
    const body = await result.json();
    const check = body.checks.find(item => item.name === '잔고 조회');
    assert.equal(check?.status, expected);
    assert.equal(check.ok, expected === 'PASS');
    assert.equal(check.code ?? null, expectedCode);
    assert.equal(body.itemCodes.find(item => item.name === '잔고 조회')?.status, expected);
    if (expected === 'UNKNOWN') assert.match(check.detail, /잔고 응답.*확인하지 못/);
    else assert.equal(check.detail, snapshot.message);
  });
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
