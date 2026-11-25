// src/test/integration/walletLookupIntegration.test.ts
//
// **지갑·현물 읽기 경로가 "못 읽었다"를 "그런 연결 없다"로 답하지 않는다.**
//
// `readWallet.ts`는 머리에 자기 규칙을 적어 뒀다 —
// "못 읽은 값을 0으로 채우지 않는다. 0은 '돈이 없다'이고 조회 실패는
// '모른다'인데, 화면에서는 둘 다 0.00 USDT로 보인다."
//
// 그런데 **첫 단계에서 그 규칙을 어겼다**:
//
//   const { data: conn } = await sb.from('exchange_connections')…maybeSingle();
//   if (!conn) return fail(connectionId, 'connection_not_found', 404);
//
// `error`를 받지 않으므로 DB가 죽었든 권한이 막혔든 "그런 연결 없다"가
// 된다. 같은 모양이 네 라우트에도 그대로 있었다.
//
// 왜 `readWallet.ts`가 먼저인가: `/api/wallets` · `walletOverview` ·
// `walletRead` 셋이 그 한 곳을 지난다. 라우트만 고치면 개요 쪽이 자기
// 사본으로 남는다 — 그 파일 자신이 적어 둔 고장이다.
//
// 실제 핸들러·실제 모듈 + 가짜 Supabase. 실제 DB·거래소 호출 없음.
import { test, eq, assert } from '../harness';
import { NO_ROWS_CODE } from '../../lib/exchanges/connectionLookup';
import { readConnectionWallet } from '../../lib/markets/readWallet';

const FAKE_UID = '00000000-0000-4000-8000-0000000000c1';
const CONN_ID = '00000000-0000-4000-8000-0000000000c2';

type Reply = { data: unknown; error: unknown };

const FAIL: Reply = { data: null, error: { code: '08006', message: 'connection terminated' } };
const NO_ROWS: Reply = { data: null, error: { code: NO_ROWS_CODE, details: '0 rows' } };
const EMPTY: Reply = { data: null, error: null };

function fakeSb(reply: Reply) {
  return {
    from(table: string) {
      const q: any = {
        select() { return q; },
        eq() { return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle() {
          if (table === 'exchange_connections') return Promise.resolve(reply);
          return Promise.resolve({ data: null, error: null });
        },
        single() {
          if (table === 'exchange_connections') return Promise.resolve(reply);
          return Promise.resolve({ data: null, error: { code: NO_ROWS_CODE } });
        },
        then(res: any, rej: any) {
          return Promise.resolve({ data: [], error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

export async function runWalletLookupTests(): Promise<void> {
  console.log('\n[통합 — 지갑·현물 읽기가 연결 "못 읽음"을 "없음"으로 답하지 않는다]');

  // ── ① 공용 지점: readConnectionWallet ──
  //
  // 라우트를 올리지 않고 직접 부른다. 이 한 곳이 라우트·개요·walletRead
  // 셋을 덮으므로, 여기서 갈라지면 세 곳이 함께 갈라진다.
  test('★ readConnectionWallet: 조회 실패는 connection_unreadable / 503 이다', async () => {
    const r = await readConnectionWallet(fakeSb(FAIL), FAKE_UID, CONN_ID);
    eq(r.ok, false);
    eq(r.error, 'connection_unreadable', `받은 값 ${r.error} (status ${r.status})`);
    eq(r.status, 503);
    assert(r.error !== 'connection_not_found', '못 읽은 것을 "그런 연결 없다"로 적었다');
  });

  test('★ readConnectionWallet: 못 읽었으면 숫자를 0으로 채우지 않는다', async () => {
    const r = await readConnectionWallet(fakeSb(FAIL), FAKE_UID, CONN_ID);
    eq(r.spot, null); eq(r.futures, null); eq(r.tree, null); eq(r.allocation, null);
    eq(r.testnet, null, 'is_testnet 을 모르면 null — false(실전)로 떨어지지 않는다');
  });

  test('readConnectionWallet: 진짜 0행은 그대로 connection_not_found / 404 다', async () => {
    const r = await readConnectionWallet(fakeSb(NO_ROWS), FAKE_UID, CONN_ID);
    eq(r.error, 'connection_not_found');
    eq(r.status, 404);
  });

  test('readConnectionWallet: maybeSingle 의 빈 응답도 0행이다 (404)', async () => {
    const r = await readConnectionWallet(fakeSb(EMPTY), FAKE_UID, CONN_ID);
    eq(r.error, 'connection_not_found');
    eq(r.status, 404);
  });

  test('★ readConnectionWallet: 사유에 DB 오류 원문이 섞이지 않는다', async () => {
    const r = await readConnectionWallet(
      fakeSb({ data: null, error: { code: '08006', message: 'could not connect to postgres://u:pw@h/d' } }),
      FAKE_UID, CONN_ID);
    const s = JSON.stringify({ e: r.error, m: r.message });
    assert(!/postgres:\/\/|pw@|password|secret|key=/i.test(s), s);
  });

  // ── ② 라우트 네 곳 ──
  // 이 네 라우트는 `lib/supabase/server`에서 인증·DB를 가져온다
  // (킬스위치 쪽은 `lib/supabase/admin`이다 — 출처가 둘이다).
  const adminPath = require.resolve('../../lib/supabase/server');
  const routes = {
    wallets: require.resolve('../../app/api/wallets/route'),
    'spot/balance': require.resolve('../../app/api/binance/spot/balance/route'),
    'spot/trades': require.resolve('../../app/api/binance/spot/trades/route'),
    'spot/open-orders': require.resolve('../../app/api/binance/spot/open-orders/route'),
  } as const;

  let chain: Promise<unknown> = Promise.resolve();
  function call(which: keyof typeof routes, reply: Reply) {
    const run = chain.then(() => callOnce(which, reply));
    chain = run.catch(() => undefined);
    return run;
  }

  async function callOnce(which: keyof typeof routes, reply: Reply) {
    const routePath = routes[which];
    const oldAdmin = require.cache[adminPath];
    const oldRoute = require.cache[routePath];
    require.cache[adminPath] = {
      id: adminPath, filename: adminPath, loaded: true,
      exports: { getSupabaseAdmin: () => fakeSb(reply), resolveUserId: async () => FAKE_UID },
    } as any;
    delete require.cache[routePath];

    const url = new URL('https://example.test/api/' + which);
    url.searchParams.set('connectionId', CONN_ID);
    url.searchParams.set('symbol', 'BTCUSDT');
    const request: any = {
      nextUrl: url, url: url.toString(),
      headers: { get(n: string) { return n.toLowerCase() === 'authorization' ? 'Bearer fake' : null; } },
      json: async () => ({ connectionId: CONN_ID }),
    };
    try {
      const mod = require(routePath);
      const res = await mod.GET(request);
      let body: any = {};
      try { body = await res.json(); } catch { body = {}; }
      return { status: res.status as number, body, thrown: null as string | null };
    } catch (e) {
      // **삼키지 않는다.** 터진 것을 "404가 아니다"로 합격시키면 거짓 초록이다.
      return { status: 0, body: {}, thrown: String(e).slice(0, 120) };
    } finally {
      if (oldAdmin) require.cache[adminPath] = oldAdmin; else delete require.cache[adminPath];
      if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    }
  }

  for (const which of ['wallets', 'spot/balance', 'spot/trades', 'spot/open-orders'] as const) {
    test(`★ ${which}: 조회 실패는 503 connection_unreadable 이다`, async () => {
      const r = await call(which, FAIL);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 503, `상태 (body=${JSON.stringify(r.body)})`);
      eq(r.body?.error, 'connection_unreadable', `코드 (status=${r.status})`);
      assert(r.status !== 404, '못 읽은 것을 "그런 연결 없다"로 적었다');
    });

    test(`${which}: 진짜 0행은 그대로 404다 — 막기만 하지 않는다`, async () => {
      const r = await call(which, NO_ROWS);
      assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
      eq(r.status, 404, `body=${JSON.stringify(r.body)}`);
      eq(r.body?.error, 'connection_not_found');
    });
  }

  test('★ 라우트 응답에 DB 오류 원문이 섞이지 않는다', async () => {
    const r = await call('spot/balance', {
      data: null, error: { code: '08006', message: 'could not connect to postgres://u:pw@h/d' },
    });
    assert(!r.thrown, `핸들러가 던졌다: ${r.thrown}`);
    // **인증 단계에서 멈춘 응답으로 통과시키지 않는다.** 처음 쓴 판이
    // 그렇게 통과했다 — 스텁 경로가 틀려서 body가 `auth_required`였고,
    // 거기에는 당연히 접속 문자열이 없다. 조회까지 갔음을 먼저 고정한다.
    eq(r.status, 503, `조회 단계까지 가지 않았다 (body=${JSON.stringify(r.body)})`);
    const s = JSON.stringify(r.body);
    assert(!/postgres:\/\/|pw@|password|secret|key=/i.test(s), s);
  });
}
