// src/test/integration/smokePreflightRouteIntegration.test.ts
//
// **사전 점검이 주문을 내지 않는다는 것을 실제 핸들러로 확인한다.**
//
// 왜 정적 검사로는 부족한가
// ─────────────────────────
// "이 라우트는 조회만 한다"는 주석이고, 주석은 변이에 안 걸린다.
// 어느 날 누가 "막혔으니 치워 주자"를 한 줄 넣으면 점검이 **치우는
// 도구**가 되고, 그 순간 점검은 상태를 바꾼 뒤에 "통과"라고 적는다.
//
// 그래서 모든 실패 상황을 한 번씩 돌려 보고, 매번 두 가지를 센다:
//
//   · 거래소에 **쓰기 요청이 0건**인가 (POST · PUT · DELETE)
//   · 장부에 **쓰기가 0건**인가 (insert · update)
//
// 그리고 **UNKNOWN·SKIPPED가 PASS로 세어지지 않는가**를 본다.
// 모르는 것을 통과로 적으면 사람은 그대로 실주문을 누른다.
//
// 거래소는 가짜다. 이 시험은 실제 Binance 호출이 아니다.

import { test, eq, assert } from '../harness';
import { FakeDb, FakeVenue, withCryptoEnv } from './venueHarness';
import { encryptSecret } from '../../lib/exchanges/crypto';

const ADMIN = 'preflight-admin-secret-0123456789';
const BN_POS = '/fapi/v2/positionRisk';
const BN_OPEN = '/fapi/v1/openOrders';

/** 헤더와 본문만 있는 요청 */
function req(body: any, headers: Record<string, string> = {}): any {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    json: async () => body,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    nextUrl: new URL('https://x.test/api/autotrade/smoke-test/preflight'),
  };
}

function conn(over: Partial<Record<string, any>> = {}) {
  return {
    id: 'c-testnet', user_id: 'u-1', exchange_id: 'binance',
    api_key: 'K'.repeat(64), api_secret_enc: encryptSecret('S'.repeat(64)),
    has_withdrawal: false, is_testnet: true, perm_trading: true, is_active: true,
    ...over,
  };
}

/** 포지션도 미체결도 없는, 조용한 거래소 */
const quiet = () => new FakeVenue().on(BN_POS, { json: [] }).on(BN_OPEN, { json: [] });

/** 끝난 회차 한 줄 (POSITION_ZERO·ORDERS_ZERO 모두 PASS) */
const cleanRow = (id: string) => ({
  id, user_id: 'u-1', connection_id: 'c-testnet', state: 'DONE',
  steps: { POSITION_ZERO: { state: 'PASS' }, ORDERS_ZERO: { state: 'PASS' } },
});

/** 노출이 남은 회차 한 줄 */
const dirtyRow = (id: string) => ({
  id, user_id: 'u-1', connection_id: 'c-testnet', state: 'HOLDING',
  steps: { POSITION_ZERO: { state: 'FAIL' }, ORDERS_ZERO: { state: 'PASS' } },
});

export async function runSmokePreflightRouteTests(): Promise<void> {
  console.log('[통합 — 스모크 사전 점검 (실제 핸들러 · 주문 0 · DB 쓰기 0)]');

  const serverPath = require.resolve('../../lib/supabase/server');
  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/autotrade/smoke-test/preflight/route');

  /** 라우트를 가짜 DB에 붙여 새로 불러온다 */
  function loadRoute(db: FakeDb, jwtUser: string | null) {
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
    delete require.cache[routePath];
    const mod = require(routePath);
    return {
      POST: mod.POST as (r: any) => Promise<any>,
      restore: () => {
        delete require.cache[routePath];
        delete require.cache[adminPath];
        if (prevServer) require.cache[serverPath] = prevServer; else delete require.cache[serverPath];
        if (prevAdmin) require.cache[adminPath] = prevAdmin;
      },
    };
  }

  const good = { userId: 'u-1', connectionId: 'c-testnet', symbol: 'BTCUSDT', leverage: 10 };
  const auth = { 'x-admin-secret': ADMIN };

  /**
   * 한 번 두드리고 응답 · 장부 쓰기 · 거래소 호출을 돌려준다.
   *
   * **시나리오는 순차로 돌린다.** `test()`는 async 본문을 pending에
   * 넣고 바로 돌아오므로, 여러 시나리오를 `test()`로 띄우면 서로의
   * fetch 스텁을 덮어쓴다(orderPathIntegration.test.ts 87행 주석).
   */
  async function hit(body: any, headers: Record<string, string>, opts: {
    jwtUser?: string | null; seedConn?: any | null; seedSmoke?: any[];
    failSelectsOn?: string; venue?: FakeVenue; noAdminSecret?: boolean;
  } = {}) {
    const prevAdminSecret = process.env.ADMIN_SECRET;
    if (opts.noAdminSecret) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = ADMIN;
    const restoreCrypto = withCryptoEnv();
    const venue = opts.venue ?? quiet();
    const restoreVenue = venue.install();
    const db = new FakeDb(opts.failSelectsOn ? { failSelectsOn: opts.failSelectsOn } : {});
    if (opts.seedConn !== null) db.seed('exchange_connections', [opts.seedConn ?? conn()]);
    db.seed('smoke_tests', opts.seedSmoke ?? []);
    const r = loadRoute(db, opts.jwtUser ?? null);
    try {
      const res = await r.POST(req(body, headers));
      const json = await res.json();
      return { status: res.status, json, db, venue };
    } finally {
      r.restore(); restoreVenue(); restoreCrypto();
      if (prevAdminSecret === undefined) delete process.env.ADMIN_SECRET;
      else process.env.ADMIN_SECRET = prevAdminSecret;
    }
  }

  /** 거래소에 상태를 바꾸는 요청이 하나라도 있었는가 */
  const venueWrites = (v: FakeVenue) =>
    v.calls.filter((c) => c.method !== 'GET');

  const stateOf = (json: any, id: string) =>
    (json.checks || []).find((c: any) => c.id === id)?.state;

  /** 모든 경우에 공통으로 참이어야 하는 것 */
  function neverWrites(label: string, r: { db: FakeDb; venue: FakeVenue }) {
    eq(r.db.writes.length, 0, `${label}: 장부에 썼습니다 — 점검은 읽기만 합니다`);
    eq(venueWrites(r.venue).length, 0,
      `${label}: 거래소에 쓰기 요청을 보냈습니다 — 점검은 주문을 내지 않습니다`);
    eq(r.venue.orderSends().length, 0, `${label}: 주문을 보냈습니다`);
  }

  // ══════════ ① 인증 ══════════
  {
    const noAuth = await hit(good, {});
    const wrongSecret = await hit(good, { 'x-admin-secret': 'wrong-secret-0000000000000000' });
    const noSecretConfigured = await hit(good, auth, { noAdminSecret: true });

    test('① 시크릿도 로그인도 없으면 401 — 주문 0 · DB 쓰기 0', () => {
      eq(noAuth.status, 401);
      eq(noAuth.json.error, 'auth_required');
      neverWrites('인증 없음', noAuth);
    });

    test('① 틀린 시크릿은 통과하지 못한다', () => {
      eq(wrongSecret.status, 401, '길이가 달라도 같아도 통과하면 안 된다');
      neverWrites('틀린 시크릿', wrongSecret);
    });

    // **서버에 ADMIN_SECRET이 없으면 어떤 헤더도 관리자가 아니다.**
    // 빈 값끼리 비교가 참이 되는 길을 열면 시크릿을 안 넣은 배포가
    // 통째로 열린다.
    test('① 서버에 시크릿이 설정돼 있지 않으면 헤더가 있어도 401', () => {
      eq(noSecretConfigured.status, 401);
      neverWrites('서버 시크릿 없음', noSecretConfigured);
    });
  }

  // ══════════ ② 대상이 비어 있으면 보지 않는다 ══════════
  {
    const noUser = await hit({ ...good, userId: '' }, auth);
    const noConn = await hit({ ...good, connectionId: '  ' }, auth);

    test('② userId·connectionId가 비면 400 — "전체"가 되는 자리를 열지 않는다', () => {
      eq(noUser.status, 400); eq(noUser.json.error, 'user_required');
      eq(noConn.status, 400); eq(noConn.json.error, 'connection_required');
      neverWrites('userId 없음', noUser);
      neverWrites('connectionId 없음', noConn);
    });
  }

  // ══════════ ③ 소유권 불일치 ══════════
  //
  // 남의 연결 id를 적으면 자격증명 자체를 못 읽는다
  // (`loadFuturesCreds`가 `id`와 `user_id`를 함께 건다).
  {
    const other = await hit({ ...good, userId: 'u-다른사람' }, auth);

    test('③ 남의 연결 id로는 열리지 않고, 뒤 항목은 SKIPPED다', () => {
      eq(other.status, 200, '점검 자체는 성공했다 — 결과가 "준비 안 됨"일 뿐이다');
      eq(other.json.ready, false);
      eq(stateOf(other.json, 'CONNECTION_OWNED'), 'FAIL');
      eq(stateOf(other.json, 'TESTNET_VERIFIED'), 'SKIPPED', '못 본 것은 SKIPPED다');
      eq(stateOf(other.json, 'SYMBOL_CLEAR'), 'SKIPPED');
      eq(other.venue.calls.length, 0, '연결을 못 읽었으면 거래소를 부르지도 않는다');
      neverWrites('소유권 불일치', other);
    });
  }

  // ══════════ ④ LIVE 연결 · 미확인 환경 ══════════
  {
    const live = await hit(good, { ...auth }, { seedConn: conn({ is_testnet: false }) });
    const unverified = await hit(good, { ...auth }, { seedConn: conn({ is_testnet: null }) });

    test('④ LIVE 연결은 FAIL이고 **거래소를 건드리지 않는다**', () => {
      eq(live.json.ready, false);
      eq(stateOf(live.json, 'TESTNET_VERIFIED'), 'FAIL');
      eq(stateOf(live.json, 'SYMBOL_CLEAR'), 'SKIPPED',
        '실전 연결의 거래소를 조회하지 않는다');
      eq(live.venue.calls.length, 0, 'LIVE 계좌에는 조회조차 보내지 않는다');
      neverWrites('LIVE 연결', live);
    });

    test('④ 테스트넷이 **확인되지 않은**(null) 연결도 통과하지 못한다', () => {
      eq(unverified.json.ready, false);
      eq(stateOf(unverified.json, 'TESTNET_VERIFIED'), 'FAIL',
        '확인되지 않음은 실전이라는 뜻은 아니지만 통과도 아니다');
      eq(unverified.venue.calls.length, 0);
      neverWrites('환경 미확인', unverified);
    });
  }

  // ══════════ ⑤ 미해결 노출이 남아 있다 ══════════
  {
    const dirty = await hit(good, auth, { seedSmoke: [cleanRow('s-1'), dirtyRow('s-2')] });

    test('⑤ 정리되지 않은 노출이 있으면 FAIL이고 ready가 아니다', () => {
      eq(dirty.json.ready, false);
      eq(stateOf(dirty.json, 'LEDGER_READABLE'), 'PASS', '장부는 읽혔다');
      eq(stateOf(dirty.json, 'NO_UNRESOLVED_EXPOSURE'), 'FAIL');
      assert((dirty.json.blockers || []).some((b: string) => b.includes('s-2')),
        '어느 줄이 문제인지 적어야 한다');
      neverWrites('미해결 노출', dirty);
    });
  }

  // ══════════ ⑥ 장부(DB) 조회 실패 ══════════
  //
  // **못 읽은 것을 "없음"으로 보지 않는다.** 장부 항목은 FAIL,
  // 노출 항목은 UNKNOWN이다 — 둘 다 통과는 아니지만 할 일이 다르다.
  {
    const dbFail = await hit(good, auth, { failSelectsOn: 'smoke_tests' });

    test('⑥ 장부 조회가 실패하면 FAIL + 노출은 UNKNOWN (PASS 아님)', () => {
      eq(dbFail.json.ready, false);
      eq(stateOf(dbFail.json, 'LEDGER_READABLE'), 'FAIL');
      eq(stateOf(dbFail.json, 'NO_UNRESOLVED_EXPOSURE'), 'UNKNOWN',
        '못 읽은 것을 "남아 있다"로도 "없다"로도 적지 않는다');
      neverWrites('장부 조회 실패', dbFail);
    });
  }

  // ══════════ ⑦ 묶음 표가 없다 (마이그레이션 미적용) ══════════
  {
    const noTable = await hit(good, auth, { failSelectsOn: 'smoke_runs' });

    test('⑦ 묶음 표를 확인하지 못하면 ready가 아니다', () => {
      eq(noTable.json.ready, false);
      eq(stateOf(noTable.json, 'RUN_TABLE_PRESENT'), 'FAIL',
        '시작이 503으로 끝날 상태를 실주문 전에 알려야 한다');
      neverWrites('묶음 표 없음', noTable);
    });
  }

  // ══════════ ⑧ 킬스위치를 확인하지 못했다 ══════════
  {
    const ksUnknown = await hit(good, auth, { failSelectsOn: 'kill_switch_state' });

    test('⑧ 킬스위치를 확인하지 못하면 FAIL — 확인 못 한 것은 꺼진 것이 아니다', () => {
      eq(ksUnknown.json.ready, false);
      eq(stateOf(ksUnknown.json, 'KILL_SWITCH_OFF'), 'FAIL');
      neverWrites('킬스위치 미확인', ksUnknown);
    });
  }

  // ══════════ ⑨ 거래소 조회 실패 ══════════
  {
    const down = new FakeVenue()
      .on(BN_POS, { status: 500, json: { code: -1001, msg: 'down' } })
      .on(BN_OPEN, { status: 500, json: { code: -1001, msg: 'down' } });
    const venueDown = await hit(good, auth, { venue: down });

    test('⑨ 거래소 조회가 실패하면 UNKNOWN이지 "깨끗함"이 아니다', () => {
      eq(venueDown.json.ready, false);
      eq(stateOf(venueDown.json, 'SYMBOL_CLEAR'), 'UNKNOWN');
      neverWrites('거래소 조회 실패', venueDown);
    });
  }

  // ══════════ ⑩ 기존 포지션이 남아 있다 ══════════
  {
    const held = new FakeVenue()
      .on(BN_POS, { json: [{
        symbol: 'BTCUSDT', positionAmt: '0.010', entryPrice: '100000',
        markPrice: '100000', unRealizedProfit: '0', leverage: '10',
        liquidationPrice: '90000', marginType: 'isolated',
      }] })
      .on(BN_OPEN, { json: [] });
    const open = await hit(good, auth, { venue: held });

    test('⑩ 기존 포지션 위에 스모크를 열지 않는다', () => {
      eq(open.json.ready, false);
      eq(stateOf(open.json, 'SYMBOL_CLEAR'), 'FAIL');
      neverWrites('기존 포지션', open);
    });
  }

  // ══════════ ⑪ 전부 정상 ══════════
  //
  // **정상 경로에서도 주문 0 · DB 쓰기 0이어야 한다.** 점검이
  // 상태를 바꾸면 "점검했더니 통과"가 점검이 만든 결과가 된다.
  {
    const ok = await hit(good, auth, { seedSmoke: [cleanRow('s-1')] });

    test('⑪ 전부 통과하면 ready — 그래도 주문 0 · DB 쓰기 0', () => {
      eq(ok.status, 200);
      eq(ok.json.ready, true, `막힌 항목: ${JSON.stringify(ok.json.blockers)}`);
      eq((ok.json.checks || []).length, 8, '항목이 빠지면 안 본 것을 통과로 세는 것이다');
      eq((ok.json.checks || []).filter((c: any) => c.state !== 'PASS').length, 0);
      neverWrites('정상', ok);
      assert(ok.venue.calls.length > 0, '정상 경로에서는 거래소를 실제로 조회해야 한다');
      assert(ok.venue.calls.every((c) => c.method === 'GET'), '조회만 해야 한다');
    });

    // **id를 통째로 응답에 적지 않는다.** 응답은 작업 로그에 그대로 남는다.
    test('⑫ 응답에 연결 id 전체가 들어가지 않는다', () => {
      const s = JSON.stringify(ok.json);
      assert(!s.includes('c-testnet'),
        `응답 어디에도 연결 id 전체가 있으면 안 됩니다: ${s.slice(0, 200)}`);
      eq(ok.json.connection, 'c-testne', '앞 8자만 적는다');
    });
  }
}
