// src/test/integration/orphansReadIntegration.test.ts
//
// **고아 주문 정리 도구가 "못 읽음"을 "0건"으로 적지 않는다.**
//
// 무엇이 실제로 있었나
// ────────────────────
// `smokeIds()`가 `const { data } = await …`로 **error를 받지 않았다.**
// 실패한 select는 예외를 던지지 않고 `{ data: null, error }`를 주므로
// `catch`에 걸리지 않는다. 그래서 장부 조회가 실패하면 조용히
//
//     rows: []  ·  ids: []  ·  error: null
//
// 이 됐다. 읽어 봤더니 없는 것과 구분이 안 되는 모양이다.
//
// 그 번호 목록은 **소유 증거의 1순위**다 — `classifyOrder`가 주문 번호
// 일치를 가장 먼저 본다. 비면 거래소가 식별자를 안 준 주문이 전부
// `UNKNOWN`("건드리지 않습니다")으로 떨어지고, 정리 도구가 조용히
// 아무것도 못 하게 된다. 화면에는 "DB 기록 0건"으로 보인다.
//
// 화면 쪽도 같이 고장나 있었다: 경고 줄이 `rows.length > 0` 블록
// **안**에 있어서, 장부를 못 읽은 바로 그때만 사라졌다.
//
// 여기서는 서버 쪽을 핸들러로 두드린다.

import { test, eq, assert } from '../harness';
import { FakeDb, FakeVenue, withCryptoEnv } from './venueHarness';
import { encryptSecret } from '../../lib/exchanges/crypto';

const BN_POS = '/fapi/v2/positionRisk';
const BN_OPEN = '/fapi/v1/openOrders';

function req(body: any, url: string): any {
  return {
    json: async () => body,
    headers: { get: () => null },
    nextUrl: new URL(url),
  };
}

const conn = () => ({
  id: 'c-testnet', user_id: 'u-1', exchange_id: 'binance',
  api_key: 'K'.repeat(64), api_secret_enc: encryptSecret('S'.repeat(64)),
  has_withdrawal: false, is_testnet: true, is_active: true,
});

/** 식별자가 없는 조건부 주문 — 소유 증거가 **주문 번호밖에 없는** 줄 */
const namelessStop = {
  orderId: '770001', symbol: 'BTCUSDT', type: 'STOP_MARKET',
  stopPrice: '90000', status: 'NEW', clientOrderId: '', reduceOnly: true,
};

/** 그 주문을 만든 스모크 줄 */
const smokeRow = {
  id: 's-1', user_id: 'u-1', symbol: 'BTCUSDT', side: 'LONG',
  state: 'DONE', verdict: 'PASS',
  sl_order_id: '770001', tp_order_id: null, entry_order_id: '770000',
  client_order_id: 'x', created_at: '2026-10-19T00:00:00Z', closed_at: null,
};

export async function runOrphansReadTests(): Promise<void> {
  console.log('[통합 — 고아 주문 정리 (장부를 못 읽으면 0건이 아니다)]');

  const serverPath = require.resolve('../../lib/supabase/server');
  const adminPath = require.resolve('../../lib/supabase/admin');
  const routePath = require.resolve('../../app/api/autotrade/smoke-test/orphans/route');

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
      GET: mod.GET as (r: any) => Promise<any>,
      POST: mod.POST as (r: any) => Promise<any>,
      restore: () => {
        delete require.cache[routePath];
        delete require.cache[adminPath];
        if (prevServer) require.cache[serverPath] = prevServer; else delete require.cache[serverPath];
        if (prevAdmin) require.cache[adminPath] = prevAdmin;
      },
    };
  }

  /** 시나리오는 순차로 돌린다 — fetch 스텁이 전역이다 */
  async function hit(which: 'GET' | 'POST', opts: {
    body?: any; failSmoke?: boolean; seedSmoke?: any[]; orders?: any[];
  } = {}) {
    const restoreCrypto = withCryptoEnv();
    const venue = new FakeVenue()
      .on(BN_POS, { json: [] })
      // 취소는 **DELETE**다. 규칙을 붙여야 정상 경로가 끝까지 돈다 —
      // 안 붙이면 FakeVenue가 던져서 "취소를 시도했다"까지만 보게 되고,
      // 그건 ④가 보려는 것이 아니다.
      .on('/fapi/v1/order', { json: { orderId: 770001, status: 'CANCELED' } }, 'DELETE')
      .on(BN_OPEN, { json: opts.orders ?? [namelessStop] });
    const restoreVenue = venue.install();
    const db = new FakeDb(opts.failSmoke ? { failSelectsOn: 'smoke_tests' } : {});
    db.seed('exchange_connections', [conn()]);
    db.seed('smoke_tests', opts.seedSmoke ?? [smokeRow]);
    const r = loadRoute(db, 'u-1');
    try {
      const res = which === 'GET'
        ? await r.GET(req(null,
            'https://x.test/api/autotrade/smoke-test/orphans?connectionId=c-testnet&symbol=BTCUSDT'))
        : await r.POST(req(opts.body ?? { connectionId: 'c-testnet', symbol: 'BTCUSDT', ids: ['770001'] },
            'https://x.test/api/autotrade/smoke-test/orphans'));
      return { status: res.status ?? 200, json: await res.json(), db, venue };
    } finally { r.restore(); restoreVenue(); restoreCrypto(); }
  }

  const venueWrites = (v: FakeVenue) => v.calls.filter((c) => c.method !== 'GET');

  // ══════════ ① 장부를 읽었을 때 — 번호로 내 것을 알아본다 ══════════
  //
  // 이 줄이 먼저 있어야 ②가 무엇을 잃는지가 분명해진다.
  {
    const okRead = await hit('GET');
    test('① 장부를 읽으면 식별자 없는 주문도 번호로 내 것이 된다', () => {
      eq(okRead.json.ok, true);
      eq(okRead.json.smokeReadable, true);
      eq(okRead.json.orders.length, 1);
      eq(okRead.json.orders[0].ownership, 'MINE',
        '주문 번호 일치가 소유 증거의 1순위다');
    });
  }

  // ══════════ ② 장부를 못 읽었다 ══════════
  {
    const bad = await hit('GET', { failSmoke: true });

    test('② 장부 조회가 실패하면 smokeReadable=false이고 error가 남는다', () => {
      eq(bad.json.ok, true, '조회 자체는 응답한다');
      eq(bad.json.smokeReadable, false, '못 읽은 것을 "읽었다"로 적지 않는다');
      assert(bad.json.smoke?.error != null,
        'error가 null이면 화면이 경고를 띄울 근거가 없다');
      eq(bad.json.smoke?.rows, null, '빈 배열이 아니라 null이다 — []는 "읽었고 없다"다');
      eq(bad.json.smoke?.ids, null);
      assert(String(bad.json.note || '').includes('장부'),
        `사유에 무엇을 못 읽었는지 적어야 한다: ${bad.json.note}`);
    });

    // **UNKNOWN은 "남의 것"이 아니다.** 번호를 못 썼을 뿐이다.
    test('② 번호를 못 쓰면 식별자 없는 주문이 UNKNOWN으로 떨어진다', () => {
      eq(bad.json.orders.length, 1);
      eq(bad.json.orders[0].ownership, 'UNKNOWN',
        '소유를 증명할 1순위를 잃었으면 MINE이라고 적지 않는다');
    });

    test('② 증거 조회는 거래소에 쓰기를 보내지 않는다', () => {
      eq(venueWrites(bad.venue).length, 0);
      eq(bad.db.writes.length, 0);
    });
  }

  // ══════════ ③ 취소 — 장부를 못 읽으면 보내지 않는다 ══════════
  //
  // `before == null`(주문 목록을 못 읽음)과 같은 규칙이다. 그쪽은
  // "무엇을 지우는지 모른다", 이쪽은 "그게 내 것인지 모른다"다.
  // 둘 중 하나만 막으면 나머지 절반으로 남의 손절이 사라진다.
  {
    const cancelBlind = await hit('POST', { failSmoke: true });

    // **수정 전에는 거절한 것이 아니라 실제로 취소를 보냈다.**
    //
    //   OLD: 409 · mutated: true · DELETE /fapi/v1/order 전송
    //
    // 장부를 못 읽으면 식별자 없는 주문이 UNKNOWN으로 떨어지는데,
    // 거절 분기는 `FOREIGN`만 본다. UNKNOWN은 그대로 통과해 `cancelExact`로
    // 갔다 — **내 것임을 증명하지 못한 주문에 취소를 보낸 것이다.**
    test('③ 장부를 못 읽으면 취소를 거절한다 (503) — DELETE 0건', () => {
      eq(cancelBlind.status, 503);
      eq(cancelBlind.json.ok, false);
      eq(cancelBlind.json.error, 'smoke_ledger_unreadable');
      eq(cancelBlind.json.mutated, undefined, '아무것도 바꾸지 않았다');
      eq(cancelBlind.venue.calls.filter((c) => c.method === 'DELETE').length, 0,
        '거래소에 취소를 하나도 보내면 안 된다');
      eq(venueWrites(cancelBlind.venue).length, 0);
      eq(cancelBlind.db.writes.length, 0);
    });
  }

  // ══════════ ④ 정상 취소 경로는 그대로 산다 ══════════
  //
  // 위 수정이 "의심스러우면 다 막는다"로 번지면 정리 도구가 쓸모없어진다.
  {
    const okCancel = await hit('POST');

    test('④ 장부를 읽었으면 내 주문 취소는 그대로 나간다', () => {
      assert(okCancel.json.error !== 'smoke_ledger_unreadable',
        '정상 경로까지 막으면 안 된다');
      eq(okCancel.json.mutated, true);
      const del = okCancel.venue.calls.filter((c) => c.method === 'DELETE');
      assert(del.length > 0, '취소 요청이 실제로 나가야 한다');
      eq(del[0].params.orderId ?? del[0].params.orderid, '770001',
        '요청한 번호만 취소한다');
    });
  }

  // ══════════ ⑤ 목록이 비었다 — 읽었고 정말 없는 경우 ══════════
  {
    const empty = await hit('GET', { seedSmoke: [], orders: [] });

    test('⑤ 읽었는데 정말 0건이면 smokeReadable=true다', () => {
      eq(empty.json.smokeReadable, true, '"읽었고 없다"와 "못 읽었다"는 다르다');
      eq(empty.json.smoke?.error, null);
      assert(Array.isArray(empty.json.smoke?.rows), '이때는 빈 배열이 맞다');
    });
  }
}
