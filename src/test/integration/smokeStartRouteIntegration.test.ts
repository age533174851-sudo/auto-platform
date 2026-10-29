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

import { test, eq, assert } from '../harness';
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
  const attestRoutePath = require.resolve('../../app/api/autotrade/smoke-test/attest-exposure/route');
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


  // ══════════ #344 노출 사후 확인 — 막은 것을 푸는 경로 ══════════
  //
  // 여기서는 거래소까지 간다. FakeVenue가 `fetch`를 가로채므로 실제
  // Binance 호출은 0건이다. 보는 것은 **GET만 나가는가**, **못 읽었을 때
  // 비었다고 적지 않는가**, **장부에 정확히 한 줄을 썼는가**다.
  //
  // 주의: 이 하네스의 `test(async)`는 **동시에** 돈다. FakeVenue는
  // `globalThis.fetch`를 갈아 끼우므로 시험 안에서 설치하면 서로 엉킨다
  // (실제로 엉켜서 다른 시험의 거래소 응답을 받았다). 그래서 관측은
  // 여기서 **순차로 미리** 돌리고, 시험에는 단언만 둔다.
  {
    const ATT = '22222222-2222-4222-8222-222222222222';
    const attReq = (auth = true) =>
      req({ testId: ATT }, auth ? { authorization: 'Bearer fake.jwt' } : {});

    const legacySmoke = (over: Record<string, any> = {}) => ({
      id: ATT, user_id: 'u-1', connection_id: 'c-testnet',
      symbol: 'BTCUSDT', state: 'UNKNOWN', mode: 'TESTNET',
      steps: {
        PREFLIGHT: { state: 'PASS' },
        ENTRY: { state: 'FAIL', note: '[-1111] Precision is over the maximum' },
        POSITION_ZERO: { state: 'PASS' },
      },
      created_at: '2026-10-16T04:22:40.000Z',
      ...over,
    });

    /** 비어 있는 거래소 — 세 조회 모두 빈 배열 */
    const emptyVenue = () => new FakeVenue()
      .on('/fapi/v2/positionRisk', { json: [] })
      .on('/fapi/v1/openOrders', { json: [] })
      .on('/fapi/v1/openAlgoOrders', { json: [] });

    const pendingFirst = () => ({
      at: new Date(Date.now() - 11 * 60_000).toISOString(),
      code: 'OBSERVED_FLAT_NOW', positions: 0, regular: 0, algo: 0,
    });

    async function attest(venue: FakeVenue, opts: {
      smoke?: any[]; jwt?: string | null; dbOpts?: any; conn?: any; auth?: boolean;
    } = {}) {
      const restoreCrypto = withCryptoEnv();
      const uninstall = venue.install();
      const db = new FakeDb(opts.dbOpts ?? {});
      db.seed('exchange_connections', [opts.conn ?? conn()]);
      db.seed('smoke_tests', opts.smoke ?? [legacySmoke()]);
      const r = loadRoute(db, opts.jwt === undefined ? 'u-1' : opts.jwt, attestRoutePath);
      try {
        const res = await r.POST(attReq(opts.auth !== false));
        return { status: res.status, json: await res.json(), db, venue };
      } finally { r.restore(); uninstall(); restoreCrypto(); }
    }

    const attOf = (db: FakeDb) => (db.row('smoke_tests', { id: ATT })?.steps as any)?._attestation ?? null;

    // ── 관측을 순차로 먼저 돌린다 ──
    const FIRST = await attest(emptyVenue());
    const DONE = await attest(emptyVenue(), {
      smoke: [legacySmoke({ steps: {
        PREFLIGHT: { state: 'PASS' }, ENTRY: { state: 'FAIL' },
        POSITION_ZERO: { state: 'PASS' },
        _attestation: { code: 'PENDING', first: pendingFirst(), method: 'm', env: 'TESTNET' },
      } })],
    });
    const ALGO_OPEN = await attest(new FakeVenue()
      .on('/fapi/v2/positionRisk', { json: [] })
      .on('/fapi/v1/openOrders', { json: [] })
      .on('/fapi/v1/openAlgoOrders', { json: [{ algoId: 9, symbol: 'BTCUSDT' }] }));
    const READ_FAIL = await attest(new FakeVenue()
      .on('/fapi/v2/positionRisk', { json: [] })
      .on('/fapi/v1/openOrders', { status: 503, json: { code: -1001, msg: 'Internal error' } })
      .on('/fapi/v1/openAlgoOrders', { json: [] }));
    const MALFORMED = await attest(new FakeVenue()
      .on('/fapi/v2/positionRisk', { json: [] })
      .on('/fapi/v1/openOrders', { json: { oops: true } })
      .on('/fapi/v1/openAlgoOrders', { json: [] }));
    const ZERO_ROWS = await attest(emptyVenue(), {
      dbOpts: { updateFailure: { table: 'smoke_tests', mode: 'zero-rows' } },
    });
    const WRITE_ERR = await attest(emptyVenue(), {
      dbOpts: { updateFailure: { table: 'smoke_tests', mode: 'error' } },
    });
    const RECORDED_FAIL = await attest(emptyVenue(), {
      smoke: [legacySmoke({ steps: {
        POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'FAIL', note: '손절 123 남음' },
      } })],
    });
    const OTHER_OWNER = await attest(emptyVenue(), { smoke: [legacySmoke({ user_id: 'someone-else' })] });
    const LIVE_CONN = await attest(emptyVenue(), { conn: conn({ is_testnet: false }) });
    const NO_AUTH = await attest(emptyVenue(), { jwt: null, auth: false });

    test('★★ #344 비어 있으면 첫 관측을 적는다 — 읽고 끝나지 않는다', () => {
      eq(FIRST.status, 200, `응답 ${FIRST.status}: ${JSON.stringify(FIRST.json).slice(0, 200)}`);
      eq(FIRST.json.phase, 'FIRST', `단계가 ${FIRST.json.phase}다`);
      eq(FIRST.json.code, 'OBSERVED_FLAT_NOW', `관측이 ${FIRST.json.code}다`);
      assert(attOf(FIRST.db) != null,
        '관측을 장부에 적지 않았다 — 읽고 끝나면 사람이 DB를 고치게 된다');
      eq(attOf(FIRST.db).code, 'PENDING', '한 번 보고 완료로 적었다');
      eq(FIRST.venue.orderSends().length, 0, '주문을 보냈다');
      eq(FIRST.venue.calls.filter((c: any) => c.method !== 'GET').length, 0, 'GET이 아닌 요청이 나갔다');
      eq(FIRST.venue.calls.length, 3, `거래소 조회가 ${FIRST.venue.calls.length}번이다 — 셋 다 읽어야 한다`);
    });

    test('★★ #344 과거 판정은 그대로다 — state·verdict·ENTRY를 고치지 않는다', () => {
      const row = FIRST.db.row('smoke_tests', { id: ATT });
      eq(row.state, 'UNKNOWN', '과거 판정을 바꿨다');
      eq((row.steps as any).ENTRY.state, 'FAIL', '과거 ENTRY 실패를 덮었다');
      eq((row.steps as any).ORDERS_ZERO, undefined, 'ORDERS_ZERO를 증거 없이 적었다');
    });

    test('★★ #344 간격을 채운 두 번째 관측에서 완료되고 차단이 풀린다', () => {
      eq(DONE.json.phase, 'COMPLETED', `단계가 ${DONE.json.phase}다`);
      eq(attOf(DONE.db).code, 'ATTESTED_FLAT', '완료인데 PENDING으로 적었다');
      const { unresolvedExposureBlock } = require('../../lib/smoke/smokePlan');
      const blk = unresolvedExposureBlock({
        rows: [DONE.db.row('smoke_tests', { id: ATT })], connectionId: 'c-testnet',
      });
      eq(blk.blocked, false, `적어 놓고도 막힌다 (${blk.code}) — 배선이 안 됐다`);
    });

    test('★★ #344 사후 확인은 진입 허가가 아니다 — mayStartSmoke는 항상 false', () => {
      eq(DONE.json.mayStartSmoke, false, '사후 확인이 진입을 허가했다');
      eq(DONE.json.priorSmokeVerdictUnchanged, true, '과거 판정을 바꿨다고 적었다');
    });

    test('★★ #344 조건부(Algo) 주문이 남아 있으면 비었다고 적지 않는다', () => {
      eq(ALGO_OPEN.json.code, 'EXPOSURE_OPEN', `관측이 ${ALGO_OPEN.json.code}다`);
      assert(ALGO_OPEN.json.phase !== 'COMPLETED', `남아 있는데 ${ALGO_OPEN.json.phase}로 끝냈다`);
      eq(attOf(ALGO_OPEN.db), null, '노출이 보이는데 관측을 남겼다');
    });

    test('★★ #344 서명 GET이 실패하면 비었다고 적지 않는다 (못 읽음 ≠ 0건)', () => {
      eq(READ_FAIL.json.code, 'UNKNOWN', `조회 실패를 ${READ_FAIL.json.code}로 읽었다`);
      eq(attOf(READ_FAIL.db), null, '못 읽었는데 관측을 적었다');
    });

    test('★★ #344 HTTP 200인데 배열이 아니면 0건으로 적지 않는다', () => {
      eq(MALFORMED.json.code, 'UNKNOWN', `깨진 200을 ${MALFORMED.json.code}로 읽었다`);
      eq(attOf(MALFORMED.db), null, '깨진 응답으로 관측을 적었다');
    });

    test('★★ #344 장부 UPDATE가 0행이면 성공으로 적지 않는다', () => {
      eq(ZERO_ROWS.status, 409, `응답이 ${ZERO_ROWS.status}다`);
      eq(ZERO_ROWS.json.code, 'ATTESTATION_WRITE_UNCONFIRMED', `코드가 ${ZERO_ROWS.json.code}다`);
    });

    test('★★ #344 장부 UPDATE가 오류면 성공으로 적지 않는다', () => {
      eq(WRITE_ERR.status, 503, `응답이 ${WRITE_ERR.status}다`);
      eq(WRITE_ERR.json.code, 'ATTESTATION_WRITE_FAILED', `코드가 ${WRITE_ERR.json.code}다`);
    });

    test('★★ #344 기록된 ORDERS_ZERO=FAIL은 사후 확인 대상이 아니다', () => {
      eq(RECORDED_FAIL.status, 409, `응답이 ${RECORDED_FAIL.status}다`);
      eq(RECORDED_FAIL.json.code, 'RECORDED_FAILURE_NOT_ATTESTABLE', `코드가 ${RECORDED_FAIL.json.code}다`);
      eq(RECORDED_FAIL.db.writes.length, 0, '본 적 있는 FAIL 위에 뭔가 썼다');
      eq(RECORDED_FAIL.venue.calls.length, 0, 'FAIL 줄인데 거래소를 불렀다');
    });

    test('#344 타인의 회차는 보이지 않는다', () => {
      eq(OTHER_OWNER.status, 404, `응답이 ${OTHER_OWNER.status}다`);
      eq(OTHER_OWNER.json.code, 'NOT_FOUND');
      eq(OTHER_OWNER.db.writes.length, 0, '남의 줄을 건드렸다');
    });

    test('#344 LIVE 연결로는 사후 확인을 하지 않는다', () => {
      eq(LIVE_CONN.status, 409, `응답이 ${LIVE_CONN.status}다`);
      eq(LIVE_CONN.json.code, 'VERIFIED_TESTNET_REQUIRED', `코드가 ${LIVE_CONN.json.code}다`);
      eq(LIVE_CONN.db.writes.length, 0, 'LIVE 연결로 장부를 건드렸다');
      eq(LIVE_CONN.venue.calls.length, 0, 'LIVE 연결인데 거래소를 불렀다');
    });

    test('#344 비인증 요청은 401이고 거래소를 부르지 않는다', () => {
      eq(NO_AUTH.status, 401, `응답이 ${NO_AUTH.status}다`);
      eq(NO_AUTH.venue.calls.length, 0, '인증 전에 거래소를 불렀다');
      eq(NO_AUTH.db.writes.length, 0, '인증 전에 장부를 건드렸다');
    });
  }

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
}
