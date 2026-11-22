// src/test/integration/reconcileUnresolvedIntegration.test.ts
//
// **미확정 주문을 못 읽었을 때 관문이 열리는가.**
//
// `gatherAndReconcile`은 거래소 스냅샷과 함께 "우리가 보냈는데 결과를
// 모르는 주문"(live_orders.status = 'UNKNOWN')을 센다. 그 수가 0이면
// 거래 전 점검의 UNRESOLVED_ORDERS 항목이 **pass '없음'**으로 적힌다.
//
// 그런데 그 조회가 실패해도 0이 됐다. 실패를 0으로 적으면 "확인했고
// 없다"가 되고, 그 위에 새 주문을 얹으면 **같은 자리에 두 번 들어간다** —
// reconcileCheck.ts의 주석이 직접 경고하는 그 사고가 한 칸 옆에 그대로
// 남아 있었다.
//
// 가짜로 바꾸는 것은 두 경계뿐이다: `fetch` 한 겹과 Supabase 한 겹.
// 조회 조립·응답 파싱·판정(`reconcileState`)은 실제 코드가 돈다.
//
// ★ **시나리오는 순차로 돌리고 판정만 `test()`에 넣는다.**
//   `test()`는 async 본문을 pending에 넣고 바로 돌아오므로, 여러
//   시나리오를 `test()`로 띄우면 서로의 fetch 스텁을 덮어쓴다
//   (orderPathIntegration.test.ts 87행 주석과 같은 이유).
import { test, eq, assert } from '../harness';
import { FakeVenue, withCryptoEnv } from './venueHarness';
import { gatherAndReconcile } from '../../lib/engine/reconcileCheck';
import { encryptSecret } from '../../lib/exchanges/crypto';

const BN_POS = '/fapi/v2/positionRisk';
const BN_OPEN = '/fapi/v1/openOrders';

type Query = { cols: string; status: string[] };

/**
 * reconcileCheck가 쓰는 만큼만 흉내 내는 Supabase 한 겹.
 *
 * `live_orders` 조회는 세 축으로 일어난다(보유 행 · 미체결 행 · 미확정 행).
 * 어느 것이 실패하는지 가려서 재현해야 하므로, 요청한 컬럼과 걸린 status
 * 필터를 보고 실패를 결정한다.
 */
class ReconcileDb {
  readonly queries: Query[] = [];

  constructor(
    private conn: any,
    private rows: Record<string, any[]>,
    /** true면 그 질의는 error를 돌려준다 */
    private failWhen: (q: Query) => boolean = () => false,
    private nullResult = false,
    /** true면 `exchange_connections` 조회가 error를 돌려준다 */
    private connFails = false,
  ) {}

  /** 미확정(UNKNOWN) 질의를 몇 번 시도했는가 */
  unknownTries(): number {
    return this.queries.filter((q) => q.status.includes('UNKNOWN')).length;
  }

  from(table: string): any {
    const db = this;
    let cols = '';
    const filters: { col: string; vals: any[] }[] = [];

    const builder: any = {
      select(c?: string) { cols = String(c ?? ''); return builder; },
      eq(col: string, val: any) { filters.push({ col, vals: [val] }); return builder; },
      in(col: string, vals: any[]) { filters.push({ col, vals: [...vals] }); return builder; },
      order() { return builder; },
      limit() { return builder; },
      async maybeSingle() {
        if (table === 'exchange_connections') {
          if (db.connFails) return { data: null, error: { message: '연결 조회 실패' } };
          return { data: db.conn, error: null };
        }
        return { data: null, error: null };
      },
      then(resolve: any, reject?: any) {
        const run = async () => {
          const f = filters.find((x) => x.col === 'status');
          const q: Query = { cols, status: f ? f.vals.map(String) : [] };
          if (table === 'live_orders') {
            db.queries.push(q);
            if (db.failWhen(q)) return { data: null, error: { message: '조회 실패' } };
            if (db.nullResult) return { data: null, error: null };
          }
          let out = db.rows[table] ?? [];
          for (const x of filters) out = out.filter((r: any) => x.vals.includes(r[x.col]));
          // **요청한 컬럼만 돌려준다.** 전부 돌려주면 "018이 없는 DB"를
          // 흉내 낼 수 없다 — 폴백이 부가 컬럼 없이도 사실을 읽는지가
          // 이 시험의 절반이다.
          const want = q.cols.split(',').map((c) => c.trim()).filter(Boolean);
          return {
            data: out.map((r: any) => {
              if (want.length === 0) return { ...r };
              const o: any = {};
              for (const c of want) if (c in r) o[c] = r[c];
              return o;
            }),
            error: null,
          };
        };
        return run().then(resolve, reject);
      },
    };
    return builder;
  }
}

const conn = () => ({
  id: 'fixture-connection',
  exchange_id: 'binance',
  api_key: 'K'.repeat(64),
  api_secret_enc: encryptSecret('S'.repeat(64)),
  has_withdrawal: false,
});

/** 포지션도 미체결도 없는, 조용한 거래소 */
function quietVenue(): FakeVenue {
  return new FakeVenue().on(BN_POS, { json: [] }).on(BN_OPEN, { json: [] });
}

const unknownRow = (id: string) => ({
  user_id: 'u1', client_order_id: id, symbol: 'BTCUSDT', status: 'UNKNOWN',
  connection_id: 'fixture-connection',
  error_message: '응답 없음', needs_attention: true,
});

/** 한 시나리오를 끝까지 돌리고 결과만 돌려준다 */
async function run(
  venue: FakeVenue,
  rows: Record<string, any[]>,
  failWhen?: (q: Query) => boolean,
): Promise<{ g: any; db: ReconcileDb }> {
  const unenv = withCryptoEnv();
  const c = conn();
  const restore = venue.install();
  try {
    const db = new ReconcileDb(c, rows, failWhen);
    const g: any = await gatherAndReconcile(db as any, 'u1', true);
    return { g, db };
  } finally { restore(); unenv(); }
}

async function checkReconcileListRoute(): Promise<void> {
  const adminPath = require.resolve('../../lib/supabase/admin');
  const guardPath = require.resolve('../../lib/auth/isAdmin');
  const routePath = require.resolve('../../app/api/orders/reconcile/route');
  const savedAdmin = require.cache[adminPath];
  const savedGuard = require.cache[guardPath];
  const savedRoute = require.cache[routePath];
  let db: ReconcileDb;
  require.cache[adminPath] = { exports: {
    getSupabaseAdmin: () => db,
    resolveUserId: async () => 'u1',
  } } as NodeModule;
  require.cache[guardPath] = { exports: {
    requireAdmin: async () => new Response(null, { status: 403 }),
  } } as NodeModule;
  delete require.cache[routePath];

  try {
    const { GET } = await import('../../app/api/orders/reconcile/route');
    const ordersByConnection = [
      unknownRow('selected'),
      { ...unknownRow('other-connection'), connection_id: 'other-connection' },
      { ...unknownRow('unassigned'), connection_id: null },
      { ...unknownRow('other-user'), user_id: 'u2' },
    ];
    for (const scenario of [
      { name: '확인된 빈 목록', rows: [], count: 0, status: 200 },
      { name: '접수만 된 주문', rows: [{ ...unknownRow('c-1'), status: 'ACKED' }], count: 1, status: 200 },
      {
        name: '미리보기는 선택한 연결의 주문만 표시',
        rows: ordersByConnection, search: '?dry=1&connectionId=fixture-connection',
        count: 1, status: 200, orderId: 'selected',
      },
      {
        name: '선택한 연결에 대조할 주문이 없으면 0건',
        rows: ordersByConnection, search: '?dry=1&connectionId=empty-connection',
        count: 0, status: 200,
      },
      { name: '연결을 지정하지 않으면 본인 주문 전체', rows: ordersByConnection, count: 3, status: 200 },
      { name: '조회 실패', rows: [], fails: true, status: 503 },
      { name: '잘못된 조회 응답', rows: [], nullResult: true, status: 503 },
      { name: '연결을 지정하지 않은 조회 실패', rows: [], fails: true, search: '', status: 503 },
    ] as any[]) {
      db = new ReconcileDb(null, { live_orders: scenario.rows }, () => scenario.fails === true, scenario.nullResult);
      const response = await GET(new Request(
        'http://localhost/api/orders/reconcile' + (scenario.search ?? '?dry=1'),
      ) as Parameters<typeof GET>[0]);
      const body = await response.json();
      test(`대조 목록 · ${scenario.name}`, () => {
        eq(response.status, scenario.status);
        eq(body.ok, scenario.status === 200);
        eq(body.pendingCount, scenario.count);
        if (scenario.orderId) eq(body.pending[0]?.client_order_id, scenario.orderId);
        if (scenario.status === 503) eq(body.error, 'pending_orders_unreadable');
      });
    }
  } finally {
    if (savedAdmin) require.cache[adminPath] = savedAdmin;
    else delete require.cache[adminPath];
    if (savedGuard) require.cache[guardPath] = savedGuard;
    else delete require.cache[guardPath];
    if (savedRoute) require.cache[routePath] = savedRoute;
    else delete require.cache[routePath];
  }
}

/**
 * **호출부가 실제로 쓰는 갈래도 본다.**
 *
 * 앱에서 이 라우트를 fetch하는 곳은 세 군데이고
 * (`OrderPane.tsx` · `AutotradeControl.tsx` 두 곳) **전부
 * `?connectionId=…`를 붙이고 `dry=1`은 쓰지 않는다.** 즉 위
 * `checkReconcileListRoute`의 목록 시나리오는 **한 군데도 지나가지
 * 않는 갈래**를 본다. 그래서 여기서 나머지 절반을 본다.
 *
 * 두 가지를 못박는다:
 *   ① 같은 조회 실패가 이 갈래에서는 **500으로 막힌다** —
 *      `orderExecutor.reconcilePendingOrders`가 스스로 throw한다.
 *      이미 fail-closed였고, 그 사실을 시험으로 고정한다.
 *   ② 라우트가 **이 갈래에서 목록 질의를 하지 않는다.** 하면 그
 *      결과와 error를 둘 다 버리게 된다. 질의를 갈래 밖으로 되돌리면
 *      이 시험이 빨개진다.
 */
async function checkReconcileRealPath(): Promise<void> {
  const adminPath = require.resolve('../../lib/supabase/admin');
  const guardPath = require.resolve('../../lib/auth/isAdmin');
  const adapterPath = require.resolve('../../lib/exchanges/futuresAdapter');
  const routePath = require.resolve('../../app/api/orders/reconcile/route');
  const saved: Record<string, NodeModule | undefined> = {};
  for (const k of [adminPath, guardPath, adapterPath, routePath]) saved[k] = require.cache[k];

  let db: ReconcileDb;
  require.cache[adminPath] = { exports: {
    getSupabaseAdmin: () => db,
    resolveUserId: async () => 'u1',
  } } as NodeModule;
  require.cache[guardPath] = { exports: {
    requireAdmin: async () => new Response(null, { status: 403 }),
  } } as NodeModule;
  // 거래소 어댑터만 가짜로 둔다. **executor는 실제 코드가 돈다** —
  // 그것이 막는지가 이 시험의 요점이다.
  require.cache[adapterPath] = { exports: { futuresExchangeOf: () => 'binance' } } as NodeModule;
  delete require.cache[routePath];

  try {
    const { GET } = await import('../../app/api/orders/reconcile/route');
    db = new ReconcileDb(conn(), { live_orders: [] }, () => true);
    const res = await GET(new Request(
      'http://localhost/api/orders/reconcile?connectionId=c-1',
    ) as Parameters<typeof GET>[0]);
    const body = await res.json();
    // 라우트 자신의 목록 질의는 이 긴 컬럼 목록으로 식별한다.
    // executor는 `select('*')`를 쓰므로 섞이지 않는다.
    const routeListCols = db.queries.filter(
      (q) => q.cols.includes('client_order_id') && q.cols.includes('error_message'));

    test('대조 실행 · 조회 실패는 이 갈래에서 500으로 막힌다', () => {
      eq(res.status, 500);
      eq(body.ok, false);
      assert(/미확정 주문 장부 조회 실패/.test(String(body.error || '')),
        `executor가 스스로 막아야 한다: ${String(body.error)}`);
    });
    // ── 연결 조회 실패와 "남의 연결"을 가른다 ──
    //
    //   Codex가 #724에서 찾은 자리다. `error`를 버리고 `!conn`만 보면
    //   DB가 답을 못 준 것이 "연결을 찾을 수 없거나 본인의 연결이
    //   아닙니다"(404)가 된다. 다음 할 일이 다른 둘이 같은 칸에 들어간다.
    db = new ReconcileDb(conn(), { live_orders: [] }, () => false, false, true);
    const resConnErr = await GET(new Request(
      'http://localhost/api/orders/reconcile?connectionId=c-1',
    ) as Parameters<typeof GET>[0]);
    const bodyConnErr = await resConnErr.json();

    // 조회는 됐는데 그 사용자의 연결이 아니면 404는 그대로다.
    db = new ReconcileDb(null, { live_orders: [] }, () => false, false, false);
    const resNoConn = await GET(new Request(
      'http://localhost/api/orders/reconcile?connectionId=c-1',
    ) as Parameters<typeof GET>[0]);
    const bodyNoConn = await resNoConn.json();

    test('연결 조회 실패는 404가 아니라 503이다', () => {
      eq(resConnErr.status, 503);
      eq(bodyConnErr.ok, false);
      eq(bodyConnErr.error, 'connection_unreadable');
    });
    test('조회는 됐고 내 연결이 아니면 404 그대로다', () => {
      eq(resNoConn.status, 404);
      eq(bodyNoConn.ok, false);
      assert(!/connection_unreadable/.test(String(bodyNoConn.error || '')),
        '읽기 실패와 섞지 않는다');
    });
    test('대조 실행 · 라우트는 쓰지 않을 목록 질의를 하지 않는다', () => {
      eq(routeListCols.length, 0,
        '질의를 갈래 밖에 두면 결과와 error를 둘 다 버린다');
    });
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k]) require.cache[k] = saved[k] as NodeModule;
      else delete require.cache[k];
    }
  }
}

export async function runReconcileUnresolvedTests(): Promise<void> {
  console.log('[통합 — 미확정 주문 조회 실패 (실제 gatherAndReconcile)]');

  // ══════════ ① 미확정 조회가 두 번 다 실패하면 관문을 열지 않는다 ══════════
  //
  // 018 마이그레이션이 없을 때를 대비한 컬럼 폴백이 이미 있었는데, 그
  // 폴백의 error가 버려졌다. DB가 통째로 안 되는 날(연결 끊김 · RLS ·
  // 테이블 없음)에는 둘 다 실패하고 `unresolvedRows`가 null로 와서
  // `[]`로 접힌다 — 그러면 "미확정 0건"이 되어 관문이 열린다.
  {
    const { g, db } = await run(quietVenue(), { live_orders: [] },
      (q) => q.status.includes('UNKNOWN'));
    const tries = db.unknownTries();

    test('① 미확정 주문 조회가 모두 실패하면 reachable=false로 막는다', () => {
      // 폴백을 지우는 변이를 잡는다 — 한 번만 시도하면 018 회귀다
      eq(tries, 2, '미확정 조회를 컬럼 폴백까지 두 번 시도해야 한다');
      eq(g.reachable, false, '미확정 주문을 못 읽었으면 판정 불가로 막아야 한다');
      eq(g.unresolvedOrderCount, null, '못 읽은 것을 0건으로 적지 않는다');
      assert(String(g.error || '').includes('미확정'),
        `사유에 무엇을 못 읽었는지 적어야 한다 (받은 값: ${g.error})`);
    });
  }

  // ══════════ ② 018 폴백은 그대로 산다 ══════════
  //
  // 첫 조회만 실패하고 둘째가 성공하면, 부가 컬럼 없이도 "미확정 주문이
  // 있다"는 사실은 읽어야 한다. 위 ①을 통과시키려고 폴백을 없애면 여기서
  // 걸린다.
  {
    const { g } = await run(quietVenue(), { live_orders: [unknownRow('c-1')] },
      (q) => q.status.includes('UNKNOWN') && q.cols.includes('needs_attention'));

    test('② needs_attention 컬럼이 없어도 미확정 주문을 읽는다', () => {
      eq(g.reachable, true, '폴백이 성공했으면 막지 않는다');
      eq(g.unresolvedOrderCount, 1, '미확정 1건을 세어야 한다');
      eq(g.unresolvedOrders.length, 1, '목록도 1건이어야 한다');
      eq(g.unresolvedOrders[0].needsAttention, false,
        '부가 컬럼이 없으면 needsAttention은 false로 둔다');
    });
  }

  // ══════════ ③ 정상 경로는 막히지 않는다 ══════════
  //
  // 미확정이 **정말** 0건이면 0건이다. 위 수정이 "의심스러우면 다 막는다"로
  // 번지면 아무도 거래할 수 없다.
  {
    const { g } = await run(quietVenue(), { live_orders: [] });

    test('③ 미확정 주문이 정말 없으면 0건으로 통과한다', () => {
      eq(g.reachable, true, '정상 조회는 통과해야 한다');
      eq(g.unresolvedOrderCount, 0, '정말 없으면 0건이다');
      assert(g.verdict != null, '판정이 있어야 한다');
    });
  }

  // ══════════ ④ 거래소에 못 닿으면 미확정 수도 null이다 ══════════
  //
  // 예전에는 이때도 `unresolvedOrders`가 `[]`였고, 호출부가 그 `.length`를
  // 그대로 적으면 "확인했고 0건"이 됐다. 일일 사다리가 정확히 그 모양이었다
  // — 다른 세 경로는 `reachable`로 가리는데 거기만 빠져 있었다.
  {
    const venue = new FakeVenue()
      .on(BN_POS, { status: 500, json: { code: -1001, msg: 'down' } })
      .on(BN_OPEN, { json: [] });
    const { g } = await run(venue, { live_orders: [] });

    test('④ 거래소에 못 닿으면 미확정 수를 0으로 적지 않는다', () => {
      eq(g.reachable, false, '거래소 조회 실패는 판정 불가다');
      eq(g.unresolvedOrderCount, null, '못 물어봤으면 0건이 아니라 모름이다');
    });
  }

  {
    const sibling = { ...unknownRow('sibling'), connection_id: 'other-connection' };
    const { g } = await run(quietVenue(), { live_orders: [unknownRow('selected'), sibling] });

    test('연결 ID를 생략해도 선택한 연결의 미확정 주문만 센다', () => {
      eq(g.reachable, true);
      eq(g.unresolvedOrderCount, 1);
      eq(g.unresolvedOrders[0]?.clientOrderId, 'selected');
    });
  }

  // ══════════ ⑤ 연결이 기록되지 않은 미확정 주문 ══════════
  //
  // `live_orders.connection_id`는 012에서 nullable이고 백필 마이그레이션이
  // 없다. `orderExecutor.ts`는 지금도 `args.connectionId || null`로 **NULL을
  // 쓴다.** 그런 행은 "다른 연결 것"이 아니라 **어느 연결 것인지 모르는
  // 것**이다.
  //
  // 주문 직전 관문(`preflight.ts`)은 connectionId 없이 이 함수를 부른다.
  // 여기서 NULL 행을 빼면 미확정이 0건으로 보이고, `reachable`이 true이므로
  // 호출부에는 **"확인했고 없음"**으로 읽힌다 — 그 위로 새 주문이 나간다.
  {
    const unknownConn = { ...unknownRow('conn-unknown'), connection_id: null };
    const { g } = await run(quietVenue(), { live_orders: [unknownConn] });

    test('⑤ 연결이 기록되지 않은 미확정 주문을 0건으로 적지 않는다', () => {
      eq(g.reachable, true, '정상 조회다');
      eq(g.unresolvedOrderCount, 1, '어느 연결 것인지 모르는 것은 "없음"이 아니다');
      eq(g.unresolvedOrders[0]?.clientOrderId, 'conn-unknown');
    });
  }

  // 그래도 **다른 연결의** 미확정은 세지 않는다 — 좁히기를 되돌리지 않는다.
  {
    const other = { ...unknownRow('others'), connection_id: 'other-connection' };
    const nul = { ...unknownRow('conn-unknown-2'), connection_id: null };
    const mine = unknownRow('mine');
    const { g } = await run(quietVenue(), { live_orders: [other, nul, mine] });

    test('⑤-2 NULL과 고른 연결만 세고 다른 연결은 빼놓는다', () => {
      eq(g.unresolvedOrderCount, 2, 'NULL 1건 + 고른 연결 1건');
      const ids = (g.unresolvedOrders as any[]).map((o: any) => o.clientOrderId).sort();
      eq(ids.join('·'), ['conn-unknown-2', 'mine'].sort().join('·'), ids.join('·'));
    });
  }

  // 한도까지 읽혔으면 더 있는지 모른다 — 건수를 적지 않는다.
  {
    const many = Array.from({ length: 60 }, (_, i) =>
      ({ ...unknownRow('bulk-' + i), connection_id: 'other-connection' }));
    const { g } = await run(quietVenue(), { live_orders: many });

    test('⑤-3 미확정이 한도만큼 읽히면 건수가 아니라 "모름"이다', () => {
      eq(g.reachable, false, '전부 세지 못했으면 판정하지 않는다');
      eq(g.unresolvedOrderCount, null, '못 센 것을 숫자로 적지 않는다');
    });
  }

  await checkReconcileListRoute();
  await checkReconcileRealPath();
}
