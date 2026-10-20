// src/test/integration/smokeStartRouteIntegration.test.ts
//
// **무인 시작을 실제 라우트 핸들러로 두드린다.**
//
// 왜 정적 검사로는 부족한가
// ─────────────────────────
// `check-admin-auth-contract`의 ⑧은 "거절 분기가 있는가"를 모양으로
// 본다. 그런데 그 분기를 `&& false`로 무력화하면 모양은 그대로다 —
// 음성 시험 N6이 그렇게 빠져나갔다. 모양을 보는 검사로는 막을 수
// 없는 변이라서, **핸들러를 불러서 응답과 장부를 본다.**
//
// 여기서 보는 것
// ──────────────
//   · 관리자 인증이 **우회되지 않는가** (틀린 시크릿 · 없는 시크릿)
//   · 확인 문구·대상이 없을 때 **장부에 아무것도 안 적히는가**
//     (400을 돌려주는 것만으로는 부족하다 — 400을 주고도 그 전에
//      줄을 만들었다면 다음 회차가 열릴 수 있다)
//   · **TESTNET 연결만** 주문을 낼 수 있는가
//   · **남의 연결 id**로는 열리지 않는가
//
// 거래소는 가짜다. 이 시험은 **실제 Binance 주문이 아니다.**

import { test, eq, assert, flushAsync } from '../harness';
import { FakeDb, FakeVenue, withCryptoEnv } from './venueHarness';
import { encryptSecret } from '../../lib/exchanges/crypto';

const ADMIN = 'test-admin-secret-0123456789';

/** 헤더와 본문만 있는 요청. 라우트가 쓰는 것이 그 둘이다 */
function req(body: any, headers: Record<string, string> = {}, url?: string): any {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const u = new URL(url ?? 'https://x.test/api/autotrade/smoke-test');
  return {
    json: async () => body,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    nextUrl: u,
  };
}

/** 연결 한 줄. `is_testnet`만 바꿔 LIVE/TESTNET을 만든다 */
function conn(over: Partial<Record<string, any>> = {}) {
  return {
    id: 'c-testnet', user_id: 'u-1', exchange_id: 'binance',
    api_key: 'K'.repeat(64), api_secret_enc: encryptSecret('S'.repeat(64)),
    has_withdrawal: false, is_testnet: true, perm_trading: true, is_active: true,
    ...over,
  };
}

export async function runSmokeStartRouteTests() {
  console.log('[통합 — 스모크 무인 시작 (실제 핸들러)]');

  const serverPath = require.resolve('../../lib/supabase/server');
  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/autotrade/smoke-test/route');
  const evidenceRoutePath = require.resolve('../../app/api/autotrade/smoke-test/legacy-evidence/route');

  /**
   * 라우트를 가짜 DB에 붙여 **새로** 불러온다.
   *
   * `admin`도 캐시에서 지운다 — 그쪽이 `server`를 다시 내보내므로
   * `server`만 바꿔 두면 옛 바인딩이 그대로 남는다.
   */
  function loadRoute(db: FakeDb, jwtUser: string | null, actualRoutePath = routePath) {
    const prevServer = require.cache[serverPath];
    const prevAdmin = require.cache[adminPath];
    require.cache[serverPath] = {
      id: serverPath, filename: serverPath, loaded: true, exports: {
        getSupabaseAdmin: () => db,
        resolveUserId: async () => jwtUser,
        getUserIdFromRequest: async () => jwtUser,
        serviceRoleKeyRole: () => 'service_role',
      },
    } as any;
    delete require.cache[adminPath];
    delete require.cache[actualRoutePath];
    const mod = require(actualRoutePath);
    return {
      POST: mod.POST as (r: any) => Promise<any>,
      GET: mod.GET as (r: any) => Promise<any>,
      restore: () => {
        delete require.cache[actualRoutePath];
        delete require.cache[adminPath];
        if (prevServer) require.cache[serverPath] = prevServer; else delete require.cache[serverPath];
        if (prevAdmin) require.cache[adminPath] = prevAdmin;
      },
    };
  }

  const good = {
    confirm: 'TESTNET-SMOKE-ORDER',
    userId: 'u-1', connectionId: 'c-testnet',
    symbol: 'BTCUSDT', side: 'LONG', directionMode: 'LONG',
    attempts: 1, holdMin: 1, marginUsd: 20, leverage: 10,
  };

  /** 한 번 두드리고 응답·장부를 돌려준다 */
  async function hit(body: any, headers: Record<string, string>, opts: {
    jwtUser?: string | null; seedConn?: any;
    seedSmoke?: any[]; failSmokeSelect?: boolean;
  } = {}) {
    const prevAdminSecret = process.env.ADMIN_SECRET;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.ADMIN_SECRET = ADMIN;
    const restoreCrypto = withCryptoEnv();
    const db = new FakeDb(opts.failSmokeSelect ? { failSelectsOn: 'smoke_tests' } : {});
    if (opts.seedConn) db.seed('exchange_connections', [opts.seedConn]);
    if (opts.seedSmoke) db.seed('smoke_tests', opts.seedSmoke);
    const r = loadRoute(db, opts.jwtUser ?? null);

    try {
      const res = await r.POST(req(body, headers));
      const json = await res.json();
      return { status: res.status, json, db };
    } finally {
      r.restore();
      restoreCrypto();
      if (prevAdminSecret === undefined) delete process.env.ADMIN_SECRET;
      else process.env.ADMIN_SECRET = prevAdminSecret;
      if (prevNodeEnv !== undefined) (process.env as any).NODE_ENV = prevNodeEnv;
    }
  }

  /** 주문을 낼 수 있는 쓰기가 하나도 없는가 */
  const noLedgerWrites = (db: FakeDb) =>
    db.writes.filter(w => w.table === 'smoke_runs' || w.table === 'smoke_tests');

  // ── 새 레거시 증거 조회 라우트: 실제 HTTP 핸들러의 음성 시험 ──
  // These stop BEFORE any Binance API GET. Fake DB and JWT; NO venue calls.
  const uuidLegacy = '11111111-1111-4111-8111-111111111111';
  const legacyReq = (id: string, token = 'simulated') =>
    req({ testId: id }, token === 'absent' ? {} : { authorization: 'Bearer fake.jwt' });

  test('⑥ 레거시 증거 조회는 비인증 요청을 401로 거부하고 DB를 읽지 않는다', async () => {
    const db = new FakeDb();
    const r = loadRoute(db, null, evidenceRoutePath);
    try {
      const res = await r.POST(legacyReq(uuidLegacy, 'absent'));
      eq(res.status, 401);
      const json = await res.json(); eq(json.code, 'AUTH_REQUIRED');
      eq(db.writes.length, 0);
    } finally { r.restore(); }
  });

  test('⑥ 레거시 증거 조회는 잘못된 UUID를 DB/거래소 호출 전에 거부한다', async () => {
    const db = new FakeDb();
    const r = loadRoute(db, 'u-1', evidenceRoutePath);
    try {
      const res = await r.POST(legacyReq('invalid'));
      eq(res.status, 400);
      const json = await res.json(); eq(json.code, 'BAD_TEST_ID');
      eq(db.writes.length, 0);
    } finally { r.restore(); }
  });

  test('⑥ 타인의 레거시 회차는 service-role에서도 보이지 않아야 한다', async () => {
    const db = new FakeDb();
    db.seed('smoke_tests', [{
      id: uuidLegacy, user_id: 'other-person', connection_id: 'c-testnet',
      symbol: 'BTCUSDT', state: 'UNKNOWN', mode: 'TESTNET',
      steps: { POSITION_ZERO: { state: 'PASS' } },
    }]);
    const r = loadRoute(db, 'u-1', evidenceRoutePath);
    try {
      const res = await r.POST(legacyReq(uuidLegacy));
      eq(res.status, 404);
      const json = await res.json(); eq(json.code, 'NOT_FOUND');
      eq(db.writes.length, 0);
    } finally { r.restore(); }
  });

  test('⑥ 이미 종료된 정상 회차를 레거시 UNKNOWN 재검증 대상으로 취급하지 않는다', async () => {
    const db = new FakeDb();
    db.seed('smoke_tests', [{
      id: uuidLegacy, user_id: 'u-1', connection_id: 'c-testnet',
      symbol: 'BTCUSDT', state: 'PASS', mode: 'TESTNET', steps: {},
    }]);
    const r = loadRoute(db, 'u-1', evidenceRoutePath);
    try {
      const res = await r.POST(legacyReq(uuidLegacy));
      eq(res.status, 409);
      const json = await res.json(); eq(json.code, 'NOT_LEGACY_TESTNET_UNKNOWN');
      eq(db.writes.length, 0);
    } finally { r.restore(); }
  });

  // ── ① 인증 우회가 없는가 ──

  test('① 시크릿도 로그인도 없으면 401 — 무인 경로가 인증을 열어 주지 않는다', async () => {
    const { status, json, db } = await hit(good, {});
    eq(status, 401);
    eq(json.error, 'auth_required');
    eq(noLedgerWrites(db).length, 0);
  });

  test('① 틀린 관리자 시크릿은 401 — 길이가 같아도 통과하지 않는다', async () => {
    // 길이가 같은 값으로 비교를 통과하는 구현(`length` 비교만 하는 것)을
    // 잡기 위해 **같은 길이**의 다른 값을 쓴다.
    const same = 'X'.repeat(ADMIN.length);
    eq(same.length, ADMIN.length);
    const { status, json, db } = await hit(good, { 'x-admin-secret': same });
    eq(status, 401);
    eq(json.error, 'auth_required');
    eq(noLedgerWrites(db).length, 0);
  });

  test('① 길이가 다른 시크릿도 401', async () => {
    const { status } = await hit(good, { 'x-admin-secret': ADMIN + 'tail' });
    eq(status, 401);
  });

  // ── ② 대상·문구가 없으면 **장부에 아무것도 남지 않는가** ──
  //
  // 400을 돌려주는 것만으로는 부족하다. 400을 주기 전에 줄을 만들었다면
  // 워커가 그 줄을 나중에 조용히 이어 간다.

  test('② 확인 문구가 없으면 400이고 장부가 비어 있다', async () => {
    const { confirm, ...noConfirm } = good;
    void confirm;
    const { status, json, db } = await hit(noConfirm, { 'x-admin-secret': ADMIN });
    eq(status, 400);
    eq(json.error, 'confirm_required');
    eq(noLedgerWrites(db).length, 0);
  });

  test('② 확인 문구가 다르면 400이고 장부가 비어 있다', async () => {
    const { status, json, db } = await hit({ ...good, confirm: 'yes' },
      { 'x-admin-secret': ADMIN });
    eq(status, 400);
    eq(json.error, 'confirm_required');
    eq(noLedgerWrites(db).length, 0);
  });

  test('② userId가 없으면 400이고 장부가 비어 있다', async () => {
    const { status, json, db } = await hit({ ...good, userId: '' },
      { 'x-admin-secret': ADMIN });
    eq(status, 400);
    eq(json.error, 'user_required');
    eq(noLedgerWrites(db).length, 0);
  });

  test('② connectionId가 없으면 400이고 장부가 비어 있다', async () => {
    const { status, json, db } = await hit({ ...good, connectionId: '' },
      { 'x-admin-secret': ADMIN });
    eq(status, 400);
    eq(json.error, 'connection_required');
    eq(noLedgerWrites(db).length, 0);
  });

  // ── ③ TESTNET 연결만 ──

  test('③ LIVE 연결로는 열리지 않는다 — 진짜 돈으로 배관을 확인하지 않는다', async () => {
    const { json, db } = await hit(good, { 'x-admin-secret': ADMIN },
      { seedConn: conn({ is_testnet: false }) });
    // **회차 줄이 아예 없어야 한다.** 줄이 남으면 워커가 나중에 잇는다.
    eq(db.table('smoke_tests').length, 0);
    assert(json.ok === false, `LIVE 연결로 ok:${json.ok}가 돌아왔습니다`);
    assert(/실전/.test(String(json.message)),
      `실전 거절 사유가 아닙니다: ${json.message}`);
    // 거래소에 가기 전에 막혔다는 **간접 증거**: 회차 줄이 없다.
    // `startAttempt`는 자격증명 → 테스트넷 판정 → 줄 생성 순서이고,
    // 줄이 0이면 그 판정에서 되돌아간 것이다. (호출 수를 직접 세려면
    // 전역 fetch를 바꿔야 하는데, 이 하네스는 구역을 **동시에** 돌려서
    // 전역을 바꾸면 남의 시험이 끊긴다 — 실제로 3건이 끊겼다.)
  });

  test('③ 확인되지 않은 환경(is_testnet이 비어 있음)은 주문을 내지 않는다', async () => {
    // **정책이 바뀐 자리다.**
    //
    // 저장소 전체 규칙은 `is_testnet !== false`를 테스트넷으로 읽고,
    // 읽기·조회에는 그걸로 맞다 — 빈 값을 실전으로 읽으면 모르는
    // 연결에 진짜 주문이 나간다.
    //
    // 그런데 스모크는 **없던 주문을 새로 만든다.** 테스트넷 호스트로
    // 나간다는 것과 그 계좌가 테스트넷임이 확인됐다는 것은 다른
    // 사실이고, 확인되지 않은 연결에까지 주문을 낼 이유가 없다.
    // 그래서 **스모크 주문 경로에서만** `=== true`를 요구한다.
    //
    // 거부하되 **실전이라고 부르지는 않는다** — 그렇게 적으면 없는
    // 실전 연결을 찾으러 가게 된다.
    for (const raw of [null, undefined]) {
      const { json, db } = await hit(good, { 'x-admin-secret': ADMIN },
        { seedConn: conn({ is_testnet: raw }) });
      assert(json.ok === false, `is_testnet=${String(raw)}인데 ok:${json.ok}가 돌아왔습니다`);
      assert(/확인되지 않았습니다/.test(String(json.message)),
        `환경 미확인 사유가 아닙니다: ${json.message}`);
      assert(!/실전 연결로는/.test(String(json.message)),
        `확인 안 된 것을 실전이라고 적었습니다: ${json.message}`);
      eq(db.table('smoke_tests').length, 0);
    }
  });

  // ── ③-b 과거 미해결 노출 / 장부 실패도 주문 전에 차단 ──

  test('③ 오래된 51번째 미결 주문도 차단한다 (기존 50개 조회 회귀)', async () => {
    const clean = Array.from({ length: 50 }, (_, n) => ({
      id: `clean-${n}`, user_id: 'u-1', connection_id: 'c-testnet',
      state: 'PASS', steps: { POSITION_ZERO: 'PASS', ORDERS_ZERO: 'PASS' },
    }));
    const old = { id: 'old-51', user_id: 'u-1', connection_id: 'c-testnet',
      state: 'FAIL', steps: { POSITION_ZERO: 'PASS', ORDERS_ZERO: 'UNKNOWN' } };
    const { json, db } = await hit(good, { 'x-admin-secret': ADMIN },
      { seedConn: conn(), seedSmoke: [...clean, old] });
    assert(json.ok === false, '오래된 미결 주문 위에 재진입했습니다');
    assert(/old-51|노출/.test(String(json.message)), String(json.message));
    eq(db.table('smoke_tests').length, 51);
  });

  test('③ 장부 조회 실패는 첫 실행으로 오인하지 않고 막는다', async () => {
    const { json, db } = await hit(good, { 'x-admin-secret': ADMIN },
      { seedConn: conn(), failSmokeSelect: true });
    assert(json.ok === false, '장부를 못 읽었는데 시작했습니다');
    eq(db.table('smoke_tests').length, 0);
  });

  test('③ 장부 1000건 조회 상한에 닿으면 미확인 과거 노출을 막는다', async () => {
    const rows = Array.from({ length: 1000 }, (_, n) => ({
      id: `historical-${n}`, user_id: 'u-1', connection_id: 'c-testnet',
      state: 'PASS', steps: { POSITION_ZERO: 'PASS', ORDERS_ZERO: 'PASS' },
    }));
    const { json, db } = await hit(good, { 'x-admin-secret': ADMIN },
      { seedConn: conn(), seedSmoke: rows });
    assert(json.ok === false, '장부 상한을 넘었는데 시작했습니다');
    assert(/1000/.test(String(json.message)), String(json.message));
    eq(db.table('smoke_tests').length, 1000);
  });

  // ── ④ 남의 연결로는 열리지 않는가 ──

  test('④ 남의 연결 id로는 열리지 않는다', async () => {
    // 연결은 다른 사용자(u-2)의 것이다. `loadFuturesCreds`가
    // `id = connectionId AND user_id = userId`로 읽으므로 비어야 한다.
    const { json, db } = await hit(good, { 'x-admin-secret': ADMIN },
      { seedConn: conn({ user_id: 'u-2' }) });
    assert(json.ok === false, `남의 연결인데 ok:${json.ok}가 돌아왔습니다`);
    eq(db.table('smoke_tests').length, 0);
  });

  test('④ 연결이 아예 없으면 열리지 않는다', async () => {
    const { json, db } = await hit(good, { 'x-admin-secret': ADMIN });
    assert(json.ok === false, `연결이 없는데 ok:${json.ok}가 돌아왔습니다`);
    eq(db.table('smoke_tests').length, 0);
  });

  // ── ⑤ 무인 조회는 대상을 비울 수 없다 ──

  test('⑤ 무인 조회에 userId가 없으면 400 — 비우면 전체 사용자의 장부가 된다', async () => {
    const prev = process.env.ADMIN_SECRET;
    process.env.ADMIN_SECRET = ADMIN;
    const db = new FakeDb();
    const r = loadRoute(db, null);
    try {
      const res = await r.GET(req({}, { 'x-admin-secret': ADMIN }));
      const json = await res.json();
      eq(res.status, 400);
      eq(json.error, 'user_required');
    } finally {
      r.restore();
      if (prev === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = prev;
    }
  });

  test('⑤ 무인 조회가 대상을 적으면 그 사용자 장부만 본다', async () => {
    const prev = process.env.ADMIN_SECRET;
    process.env.ADMIN_SECRET = ADMIN;
    const db = new FakeDb();
    db.seed('smoke_runs', [
      { id: 'r-mine', user_id: 'u-1', symbol: 'BTCUSDT', state: 'DONE', attempts: 1 },
      { id: 'r-other', user_id: 'u-2', symbol: 'ETHUSDT', state: 'DONE', attempts: 1 },
    ]);
    const r = loadRoute(db, null);
    try {
      const res = await r.GET(req({}, { 'x-admin-secret': ADMIN },
        'https://x.test/api/autotrade/smoke-test?userId=u-1'));
      const json = await res.json();
      eq(res.status, 200);
      const ids = (json.runs ?? []).map((x: any) => x.id);
      eq(ids.join(','), 'r-mine');
    } finally {
      r.restore();
      if (prev === undefined) delete process.env.ADMIN_SECRET; else process.env.ADMIN_SECRET = prev;
    }
  });

  test('⑤ 로그인도 시크릿도 없는 조회는 401', async () => {
    const db = new FakeDb();
    const r = loadRoute(db, null);
    try {
      const res = await r.GET(req({}, {}));
      const json = await res.json();
      eq(res.status, 401);
      eq(json.error, 'auth_required');
    } finally { r.restore(); }
  });

  // ── ⑦ 과거 UNKNOWN 회차 복구 — 가짜 거래소로 끝까지 돌린다 ──
  //
  // 여기서부터는 **전역 fetch를 바꾼다.** 이 하네스의 async 시험은
  // 서로 겹쳐 도므로(`pending`), 먼저 앞의 것들을 모두 끝낸 뒤
  // 한 번에 하나씩 순서대로 돌린다. 겹치면 남의 시험이 끊긴다.
  await flushAsync();

  const LEGACY_UNKNOWN = {
    id: 'legacy-unknown-1', user_id: 'u-1', connection_id: 'c-testnet',
    symbol: 'BTCUSDT', mode: 'TESTNET', state: 'UNKNOWN', verdict: 'UNKNOWN',
    steps: {},
  };

  /** 세 장부 응답을 정해 놓고 실제 라우트를 한 번 두드린다 */
  async function hitWithVenue(venueRules: (v: FakeVenue) => void) {
    const prevAdminSecret = process.env.ADMIN_SECRET;
    process.env.ADMIN_SECRET = ADMIN;
    const restoreCrypto = withCryptoEnv();
    const db = new FakeDb();
    db.seed('exchange_connections', [conn()]);
    db.seed('smoke_tests', [{ ...LEGACY_UNKNOWN }]);
    const venue = new FakeVenue();
    venueRules(venue);
    const restoreVenue = venue.install();
    const r = loadRoute(db, null);
    try {
      const res = await r.POST(req(good, { 'x-admin-secret': ADMIN }));
      const json = await res.json();
      return { json, db, venue, rows: db.table('smoke_tests') };
    } finally {
      r.restore();
      restoreVenue();
      restoreCrypto();
      if (prevAdminSecret === undefined) delete process.env.ADMIN_SECRET;
      else process.env.ADMIN_SECRET = prevAdminSecret;
    }
  }

  /** 진입 뒤 경로는 이 시험의 관심사가 아니다 — 규칙 없는 호출만 막는다 */
  const anyOtherCall = (v: FakeVenue) => {
    v.on('/fapi/v1/ticker', { json: { symbol: 'BTCUSDT', price: '60000' } });
    v.on('/fapi/', { json: { code: -1000, msg: 'not part of this test' } });
  };

  const flatVenue = (v: FakeVenue) => {
    v.on('/fapi/v2/positionRisk', { json: [] });
    v.on('/fapi/v1/openAlgoOrders', { json: [] });
    v.on('/fapi/v1/openOrders', { json: [] });
    anyOtherCall(v);
  };

  // ⑦-1 세 장부가 모두 0으로 읽히면 과거 UNKNOWN 위에서도 시작한다
  const cleared = await hitWithVenue(flatVenue);

  // ⑦-2 조건부(Algo) 주문이 남아 있으면 시작하지 않는다
  const algoLeft = await hitWithVenue((v) => {
    v.on('/fapi/v2/positionRisk', { json: [] });
    v.on('/fapi/v1/openAlgoOrders', { json: [{ algoId: '9001', symbol: 'ETHUSDT' }] });
    v.on('/fapi/v1/openOrders', { json: [] });
    anyOtherCall(v);
  });

  // ⑦-3 일반 주문이 남아 있으면 시작하지 않는다
  const regularLeft = await hitWithVenue((v) => {
    v.on('/fapi/v2/positionRisk', { json: [] });
    v.on('/fapi/v1/openAlgoOrders', { json: [] });
    v.on('/fapi/v1/openOrders', { json: [{ orderId: 1, symbol: 'ETHUSDT', type: 'LIMIT', side: 'BUY' }] });
    anyOtherCall(v);
  });

  // ⑦-4 다른 종목에 포지션이 남아 있으면 시작하지 않는다
  const positionLeft = await hitWithVenue((v) => {
    v.on('/fapi/v2/positionRisk', { json: [{
      symbol: 'ETHUSDT', positionAmt: '0.5', entryPrice: '3000', markPrice: '3000',
      unRealizedProfit: '0', leverage: '10', liquidationPrice: '0', marginType: 'isolated',
    }] });
    v.on('/fapi/v1/openAlgoOrders', { json: [] });
    v.on('/fapi/v1/openOrders', { json: [] });
    anyOtherCall(v);
  });

  // ⑦-5 Algo 장부 조회가 실패하면 "0건"이 아니라 미확인으로 막는다
  const algoUnread = await hitWithVenue((v) => {
    v.on('/fapi/v2/positionRisk', { json: [] });
    v.on('/fapi/v1/openAlgoOrders', { status: 500, json: { code: -1001, msg: 'internal' } });
    v.on('/fapi/v1/openOrders', { json: [] });
    anyOtherCall(v);
  });

  // ⑦-6 200인데 배열이 아닌 포지션 응답을 "비어 있음"으로 읽지 않는다
  const positionMalformed = await hitWithVenue((v) => {
    v.on('/fapi/v2/positionRisk', { json: { positions: [] } });
    v.on('/fapi/v1/openAlgoOrders', { json: [] });
    v.on('/fapi/v1/openOrders', { json: [] });
    anyOtherCall(v);
  });

  test('⑦ 세 장부가 모두 0으로 읽히면 과거 UNKNOWN 위에서도 새 회차가 열린다', () => {
    // 차단은 **거래소 증거**로만 풀린다. 줄이 하나 더 생겼다는 것이
    // 노출 관문을 지났다는 증거다 (그 뒤 진입 결과는 여기 관심사가 아니다).
    eq(cleared.rows.length, 2, String(cleared.json?.message));
    // 세 장부를 **실제로** 읽었는가
    assert(cleared.venue.countOf('/fapi/v2/positionRisk') > 0, '포지션을 읽지 않았습니다');
    assert(cleared.venue.countOf('/fapi/v1/openOrders') > 0, '일반 주문을 읽지 않았습니다');
    assert(cleared.venue.countOf('/fapi/v1/openAlgoOrders') > 0, '조건부 주문을 읽지 않았습니다');
  });

  test('⑦ 거래소 증거로 풀어도 옛 회차의 UNKNOWN 판정은 그대로다', () => {
    const old = cleared.rows.find((r: any) => r.id === 'legacy-unknown-1');
    eq(old?.state, 'UNKNOWN');
    eq(old?.verdict, 'UNKNOWN');
    eq(JSON.stringify(old?.steps ?? {}), '{}', '옛 회차의 단계를 고쳐서 풀었습니다');
  });

  test('⑦ 조건부(Algo) 주문이 남아 있으면 새 회차를 열지 않는다', () => {
    eq(algoLeft.rows.length, 1, String(algoLeft.json?.message));
    eq(algoLeft.json?.ok, false);
    assert(/남아 있습니다/.test(String(algoLeft.json?.message)), String(algoLeft.json?.message));
  });

  test('⑦ 일반 주문이 남아 있으면 새 회차를 열지 않는다', () => {
    eq(regularLeft.rows.length, 1, String(regularLeft.json?.message));
    eq(regularLeft.json?.ok, false);
  });

  test('⑦ 다른 종목의 포지션도 새 회차를 막는다 — 종목이 아니라 연결 단위다', () => {
    eq(positionLeft.rows.length, 1, String(positionLeft.json?.message));
    eq(positionLeft.json?.ok, false);
  });

  test('⑦ 조건부 주문 조회 실패를 0건으로 적지 않는다', () => {
    eq(algoUnread.rows.length, 1, String(algoUnread.json?.message));
    assert(/읽지 못했습니다/.test(String(algoUnread.json?.message)),
      String(algoUnread.json?.message));
  });

  test('⑦ 200이어도 배열이 아닌 포지션 응답은 "비어 있음"이 아니다', () => {
    eq(positionMalformed.rows.length, 1, String(positionMalformed.json?.message));
    assert(/읽지 못했습니다/.test(String(positionMalformed.json?.message)),
      String(positionMalformed.json?.message));
  });
}
