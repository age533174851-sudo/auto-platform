// src/test/integration/unresolvedGateScopeIntegration.test.ts
//
// **미확정 주문이 "누구의, 어느 연결의" 것일 때 진입을 막는가.**
//
// 왜 이 시험이 필요한가
// ─────────────────────
// 운영에 UNKNOWN 주문 32건이 8월부터 남아 있다. 거기서 곧바로 "그래서
// 100배 진입이 막힌다"로 넘어가면 틀릴 수 있다 — 진입 관문이 세는 범위가
// 전체가 아니기 때문이다. `gatherAndReconcile`은 이렇게 좁힌다:
//
//     .eq('user_id', userId).eq('status', 'UNKNOWN')
//     + connectionId가 있으면 .eq('connection_id', connectionId)
//     + .order(created_at desc).limit(20)
//
// 그래서 **다른 연결의 UNKNOWN은 이 진입과 무관하다.** 그 사실이 코드에
// 주석으로만 있으면, 어느 날 `scope()`가 빠져도 아무도 모른다 — 그러면
// 테스트넷에서 만든 옛 기록이 실전 진입을 영원히 막는다(그 사고가 실제로
// 있었고 주석에 적혀 있다).
//
// 이 시험이 고정하는 것
// ─────────────────────
//   ① 연결을 주면 **그 연결의** UNKNOWN만 센다
//   ② 사용자도 함께 좁힌다
//   ③ 상한은 20이다 — 관문은 "정확한 수"가 아니라 "0인가"로 판단한다
//   ④ 연결을 모르면 좁히지 않는다 (과하게 막는 쪽이 맞는 방향이다)
//
// 읽기 전용 운영 감사(`audit-production-autotrade-blockers`)의 2번 절이
// **같은 범위**로 세는 근거가 이 시험이다. 숫자가 갈리면 둘 중 하나가
// 틀린 것이고, 그때 로그만 보고 판단하면 과대평가한다.
//
// 거래소는 가짜다. 주문도, 장부 쓰기도 없다.

import { test, eq, assert } from '../harness';
import { FakeVenue, withCryptoEnv } from './venueHarness';
import { encryptSecret } from '../../lib/exchanges/crypto';
import { gatherAndReconcile } from '../../lib/engine/reconcileCheck';

const USER = 'u-1';
const CONN = 'c-binance-testnet';
const OTHER_CONN = 'c-other';

interface Recorded {
  table: string;
  filters: Array<[string, any]>;
  ins: Array<[string, any[]]>;
  limit: number | null;
  cols: string;
}

/**
 * 질의를 **기록하면서** 필터와 상한을 실제로 적용하는 가짜 DB.
 *
 * 범위를 묻는 시험이라 "무엇으로 걸렀는가"가 결과만큼 중요하다.
 */
function recordingDb(rows: Record<string, any[]>) {
  const calls: Recorded[] = [];
  const from = (table: string) => {
    const rec: Recorded = { table, filters: [], ins: [], limit: null, cols: '' };
    calls.push(rec);
    const apply = () => {
      let out = (rows[table] ?? []).slice();
      for (const [c, v] of rec.filters) out = out.filter(r => r[c] === v);
      for (const [c, vs] of rec.ins) out = out.filter(r => vs.includes(r[c]));
      if (rec.limit != null) out = out.slice(0, rec.limit);
      return out.map(r => ({ ...r }));
    };
    const q: any = {
      select(cols?: string) { rec.cols = String(cols ?? ''); return q; },
      eq(col: string, val: any) { rec.filters.push([col, val]); return q; },
      in(col: string, vals: any[]) { rec.ins.push([col, [...vals]]); return q; },
      order() { return q; },
      limit(n: number) { rec.limit = n; return q; },
      maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
      then: (res: any) => Promise.resolve({ data: apply(), error: null }).then(res),
    };
    return q;
  };
  return { sb: { from }, calls };
}

/** 미확정 주문 한 줄 */
const unknownRow = (over: Record<string, any> = {}) => ({
  id: `o-${Math.random().toString(36).slice(2, 8)}`,
  user_id: USER, connection_id: CONN, status: 'UNKNOWN',
  client_order_id: 'COID', symbol: 'BTCUSDT', side: 'BUY',
  filled_qty: 0, reduce_only: false, error_message: null, needs_attention: false,
  created_at: '2026-08-21T00:00:00Z',
  ...over,
});

/**
 * 연결 한 줄. **암호화 키가 깔린 뒤에** 만든다 —
 * 모듈 적재 시점에 `encryptSecret`을 부르면 키가 없어 던진다.
 */
const connRow = () => ({
  id: CONN, user_id: USER, exchange_id: 'binance',
  api_key: 'K'.repeat(64), api_secret_enc: encryptSecret('S'.repeat(64)),
  has_withdrawal: false, is_active: true, is_testnet: true,
});

/** 거래소 자격 복호화에 쓰는 키. 이 suite 안에서만 깔고 되돌린다 */
function withExchangeKey(): () => void {
  const prev = process.env.EXCHANGE_ENCRYPTION_KEY;
  process.env.EXCHANGE_ENCRYPTION_KEY = 'traigo-gate-scope-test-key-0123456789abcdef';
  return () => {
    if (prev === undefined) delete process.env.EXCHANGE_ENCRYPTION_KEY;
    else process.env.EXCHANGE_ENCRYPTION_KEY = prev;
  };
}

function venue(): FakeVenue {
  return new FakeVenue()
    .on('/fapi/v2/positionRisk', { json: [] })
    .on('/fapi/v3/positionRisk', { json: [] })
    .on('/fapi/v1/openOrders', { json: [] })
    .on('/fapi/v2/account', { json: { positions: [], assets: [] } })
    .on('/fapi/v1/account', { json: { positions: [], assets: [] } });
}

/** UNKNOWN을 세는 질의를 찾는다 (status='UNKNOWN'으로 걸른 live_orders 조회) */
const unknownQuery = (calls: Recorded[]) => calls.find(c =>
  c.table === 'live_orders' && c.filters.some(([k, v]) => k === 'status' && v === 'UNKNOWN'));

export async function runUnresolvedGateScopeTests() {
  console.log('[통합 — 미확정 주문 관문의 범위 (실제 gatherAndReconcile)]');

  const unkey = withExchangeKey();

  // ── ①②③ 연결을 넘긴 경우 ──
  {
    const db = recordingDb({
      exchange_connections: [connRow()],
      live_orders: [
        unknownRow(),
        unknownRow({ connection_id: OTHER_CONN }),   // 다른 연결
        unknownRow({ user_id: 'u-2' }),              // 다른 사용자
      ],
    });
    const restore = venue().install();
    const unenv = withCryptoEnv();
    let g: any = null;
    try { g = await gatherAndReconcile(db.sb as any, USER, true, CONN); }
    finally { restore(); unenv(); }

    const q = unknownQuery(db.calls);

    test('★ ① 연결을 주면 그 연결의 UNKNOWN만 센다', () => {
      assert(q != null, 'UNKNOWN 조회가 아예 없었다');
      assert(q!.filters.some(([k, v]) => k === 'connection_id' && v === CONN),
        `★ 연결로 좁히지 않았다: ${JSON.stringify(q!.filters)}`);
      eq(g.unresolvedOrders.length, 1,
        `★ 다른 연결·다른 사용자의 UNKNOWN이 섞였다: ${JSON.stringify(g.unresolvedOrders)}`);
    });

    test('② 사용자도 함께 좁힌다', () => {
      assert(q!.filters.some(([k, v]) => k === 'user_id' && v === USER),
        '한 사람의 키로 모든 사용자의 주문을 세지 않는다');
    });

    test('③ 상한은 20이다 — 관문은 "정확한 수"가 아니라 "0인가"로 판단한다', () => {
      eq(q!.limit, 20, `상한이 ${q!.limit}이다 — 감사 SQL의 least(count,20)와 맞아야 한다`);
    });
  }

  // ── ③-b 20건을 넘으면 잘린다 (그래서 수를 숫자로 믿지 않는다) ──
  {
    const many = Array.from({ length: 32 }, (_, i) =>
      unknownRow({ id: `o-${i}`, client_order_id: `COID-${i}` }));
    const db = recordingDb({ exchange_connections: [connRow()], live_orders: many });
    const restore = venue().install();
    const unenv = withCryptoEnv();
    let g: any = null;
    try { g = await gatherAndReconcile(db.sb as any, USER, true, CONN); }
    finally { restore(); unenv(); }
    test('★ ③-b 32건이 있어도 관문이 보는 것은 20건이다 (0인가만 판단한다)', () => {
      eq(g.unresolvedOrders.length, 20,
        '상한을 넘은 수를 그대로 세면 화면의 숫자와 관문의 숫자가 갈린다');
      assert(g.unresolvedOrders.length > 0, '하나라도 있으면 막는다');
    });
  }

  // ── ④ 연결을 모르면 좁히지 않는다 ──
  {
    const db = recordingDb({
      exchange_connections: [connRow()],
      live_orders: [unknownRow(), unknownRow({ connection_id: OTHER_CONN })],
    });
    const restore = venue().install();
    const unenv = withCryptoEnv();
    let g: any = null;
    try { g = await gatherAndReconcile(db.sb as any, USER, true, null); }
    finally { restore(); unenv(); }

    const q = unknownQuery(db.calls);
    test('④ 연결을 모르면 좁히지 않는다 — 과하게 막는 쪽이 맞는 방향이다', () => {
      assert(q != null, 'UNKNOWN 조회가 없었다');
      assert(!q!.filters.some(([k]) => k === 'connection_id'),
        '모르는 연결로 좁히면 봐야 할 줄을 놓친다');
      eq(g.unresolvedOrders.length, 2, '그 사용자의 UNKNOWN을 전부 센다');
    });
  }

  unkey();
}
