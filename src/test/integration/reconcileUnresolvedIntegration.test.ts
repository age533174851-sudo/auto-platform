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
        if (table === 'exchange_connections') return { data: db.conn, error: null };
        return { data: null, error: null };
      },
      then(resolve: any, reject?: any) {
        const run = async () => {
          const f = filters.find((x) => x.col === 'status');
          const q: Query = { cols, status: f ? f.vals.map(String) : [] };
          if (table === 'live_orders') {
            db.queries.push(q);
            if (db.failWhen(q)) return { data: null, error: { message: '조회 실패' } };
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
}
