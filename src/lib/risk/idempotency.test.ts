// src/lib/risk/idempotency.test.ts
//
// 막으려는 것:
//  1. **만료된 키가 영원히 막는 것.** `webhook_dedup.key`는 PRIMARY KEY이고
//     cleanupDedup은 호출하는 곳이 한 군데도 없었다. 그래서 알림 본문에
//     고정 id를 적어 두면 그 알림은 평생 한 번만 실행되고, 두 번째부터는
//     "⚠️ 중복 신호 무시됨"이 뜬다 — 사용자는 잘 막고 있다고 읽는다.
//  2. **버킷 경계에서 둘 다 통과하는 것.** 14.999초와 15.001초에 온 같은
//     신호가 다른 키가 되어 둘 다 주문을 낸다. 재발사가 몰리는 자리가
//     정확히 그 자리다.
//  3. **표가 없는데 막았다고 적는 것.** 통과와 '검사가 안 돌았음'은 다르다.
//  4. 조회 실패 한 번에 진짜 중복이 뚫리는 것.
import { test, assert, eq } from '../../test/harness';
import { signalKey, signalKeySet, claimSignal, cleanupDedup } from './idempotency';

/** webhook_dedup을 흉내내는 최소 저장소. UNIQUE(key)를 그대로 지킨다. */
function fakeDb(rows: Array<{ key: string; created_at: string; expires_at: string }> = [], opts: {
  failRead?: boolean; missingTable?: boolean;
} = {}) {
  const store = [...rows];
  const err = (code: string, message: string) => ({ code, message });
  const api = {
    rows: store,
    from(_t: string) {
      return {
        insert(row: any) {
          if (opts.missingTable) {
            return Promise.resolve({ error: err('42P01', 'relation "webhook_dedup" does not exist') });
          }
          if (store.some(r => r.key === row.key)) {
            return Promise.resolve({ error: err('23505', 'duplicate key value violates unique constraint') });
          }
          store.push({ ...row });
          return Promise.resolve({ error: null });
        },
        select(_c: string) {
          const q: any = { _eq: null as string | null, _in: null as string[] | null, _gt: null as string | null };
          q.eq = (_col: string, v: string) => { q._eq = v; return q; };
          q.in = (_col: string, v: string[]) => { q._in = v; return q; };
          q.gt = (_col: string, v: string) => { q._gt = v; return q; };
          q.maybeSingle = () => {
            if (opts.failRead) return Promise.resolve({ data: null, error: err('08006', 'connection failure') });
            return Promise.resolve({ data: store.find(r => r.key === q._eq) ?? null, error: null });
          };
          q.then = (res: any) => {
            let out = store;
            if (q._in) out = out.filter(r => q._in.includes(r.key));
            if (q._gt) out = out.filter(r => r.expires_at > q._gt);
            return Promise.resolve({ data: out, error: null }).then(res);
          };
          return q;
        },
        delete() {
          const d: any = { _eq: null as string | null, _lte: null as string | null, _lt: null as string | null };
          d.eq = (_c: string, v: string) => { d._eq = v; return d; };
          d.lte = (_c: string, v: string) => { d._lte = v; return d; };
          d.lt = (_c: string, v: string) => { d._lt = v; return d; };
          d.then = (res: any) => {
            for (let i = store.length - 1; i >= 0; i--) {
              const r = store[i];
              if (d._eq != null && r.key !== d._eq) continue;
              if (d._lte != null && !(r.expires_at <= d._lte)) continue;
              if (d._lt != null && !(r.expires_at < d._lt)) continue;
              store.splice(i, 1);
            }
            return Promise.resolve({ error: null }).then(res);
          };
          return d;
        },
      };
    },
  };
  return api;
}

const T0 = 1_800_000_000_000;   // 고정 시각. 벽시계를 쓰면 경계 시험을 못 한다
const iso = (ms: number) => new Date(ms).toISOString();

export function runIdempotencyTests() {
  console.log('[멱등 키 — 만료된 키가 영원히 막으면 안 된다]');

  test('만료된 키는 되찾아 쓴다 — 고정 id 알림이 평생 한 번만 돌면 안 된다', async () => {
    // 이게 이 파일이 있는 이유다. 사용자가 TradingView 알림 JSON에
    // `"id": "내전략"`을 적어 두면 키가 `cid:내전략` 하나로 고정된다.
    const db = fakeDb([{ key: 'cid:내전략', created_at: iso(T0 - 3600_000), expires_at: iso(T0 - 3599_985) }]);
    const r = await claimSignal(db, 'cid:내전략', 15, { nowMs: T0 });
    eq(r.duplicate, false, '한 시간 전에 만료된 키가 지금 신호를 막았다');
    eq(r.reclaimed, true);
    eq(db.rows.length, 1, '되찾았으면 행은 하나여야 한다');
  });

  test('아직 안 만료된 키는 막는다', async () => {
    const db = fakeDb([{ key: 'cid:x', created_at: iso(T0 - 5_000), expires_at: iso(T0 + 10_000) }]);
    const r = await claimSignal(db, 'cid:x', 15, { nowMs: T0 });
    eq(r.duplicate, true);
    assert((r.reason || '').includes('15초'), r.reason);
  });

  test('만료 시각을 못 읽으면 중복으로 본다', async () => {
    // 여기서 통과시키면 진짜 중복이 조회 실패 한 번에 뚫린다.
    const db = fakeDb([{ key: 'cid:x', created_at: iso(T0), expires_at: iso(T0 + 10_000) }], { failRead: true });
    const r = await claimSignal(db, 'cid:x', 15, { nowMs: T0 });
    eq(r.duplicate, true, '확인하지 못한 것을 통과로 읽었다');
  });

  console.log('[멱등 키 — 버킷 경계에서 둘 다 통과하면 안 된다]');

  test('1ms 차이로 버킷이 갈려도 같은 신호는 하나만 통과한다', async () => {
    // 15초 창의 경계: 첫 신호가 버킷 N의 끝자락, 재발사가 버킷 N+1의 시작.
    const win = 15;
    const edge = Math.ceil(T0 / (win * 1000)) * win * 1000;   // 버킷 경계 시각
    const args = {
      connectionId: 'c1', symbol: 'BTCUSDT', action: 'buy', side: 'BUY', windowSec: win,
    };
    const first = signalKeySet({ ...args, nowMs: edge - 1 });
    const second = signalKeySet({ ...args, nowMs: edge + 1 });
    assert(first.key !== second.key, '이 시험의 전제가 깨졌다 — 두 키가 같다');

    const db = fakeDb();
    const a = await claimSignal(db, first, win, { nowMs: edge - 1 });
    eq(a.duplicate, false, '첫 신호가 막혔다');
    const b = await claimSignal(db, second, win, { nowMs: edge + 1 });
    eq(b.duplicate, true, '1ms 차이로 재발사가 통과했다 — 이게 예전 동작이다');
    assert((b.reason || '').includes('경계'), b.reason);
  });

  test('창이 지난 뒤의 같은 신호는 새 신호다', async () => {
    const win = 15;
    const args = { connectionId: 'c1', symbol: 'BTCUSDT', action: 'buy', side: 'BUY', windowSec: win };
    const db = fakeDb();
    const a = await claimSignal(db, signalKeySet({ ...args, nowMs: T0 }), win, { nowMs: T0 });
    eq(a.duplicate, false);
    // 20초 뒤 — 앞의 것은 이미 만료됐다.
    const later = T0 + 20_000;
    const b = await claimSignal(db, signalKeySet({ ...args, nowMs: later }), win, { nowMs: later });
    eq(b.duplicate, false, '창이 지났는데 중복으로 버렸다 — 진짜 신호가 사라진다');
  });

  test('다른 심볼·방향은 서로를 막지 않는다', async () => {
    const win = 15;
    const db = fakeDb();
    const base = { connectionId: 'c1', action: 'buy', side: 'BUY', windowSec: win, nowMs: T0 };
    const a = await claimSignal(db, signalKeySet({ ...base, symbol: 'BTCUSDT' }), win, { nowMs: T0 });
    const b = await claimSignal(db, signalKeySet({ ...base, symbol: 'ETHUSDT' }), win, { nowMs: T0 });
    const c = await claimSignal(db, signalKeySet({ ...base, symbol: 'BTCUSDT', side: 'SELL' }), win, { nowMs: T0 });
    eq(a.duplicate, false); eq(b.duplicate, false); eq(c.duplicate, false);
  });

  test('Gate 심볼의 밑줄이 남의 신호를 긁어 오지 않는다', async () => {
    // 접두사 LIKE로 이웃을 찾으면 `BTC_USDT`의 `_`가 와일드카드라
    // `BTCXUSDT`까지 걸린다. 정확한 키 목록으로 물어야 한다.
    const set = signalKeySet({
      connectionId: 'c1', symbol: 'BTC_USDT', action: 'buy', side: 'BUY',
      windowSec: 15, nowMs: T0,
    });
    for (const n of set.neighbors) assert(n.includes('btc_usdt'), n);
    eq(set.neighbors.length, 2, '앞뒤 한 칸씩이어야 한다');
    assert(!set.key.includes('%'), set.key);
  });

  console.log('[멱등 키 — 안 돈 것을 돌았다고 적지 않는다]');

  test('표가 없으면 통과시키되 그렇다고 말한다', async () => {
    const db = fakeDb([], { missingTable: true });
    const r = await claimSignal(db, 'cid:x', 15, { nowMs: T0 });
    eq(r.duplicate, false, '표 하나 때문에 주문 경로 전체가 멎으면 안 된다');
    eq(r.installed, false, '검사가 안 돌았는데 돌았다고 적었다');
    assert((r.reason || '').includes('007'), '무엇을 실행해야 하는지 적어야 한다: ' + r.reason);
  });

  test('정상 경로에서는 installed가 참이다', async () => {
    const db = fakeDb();
    const r = await claimSignal(db, 'cid:new', 15, { nowMs: T0 });
    eq(r.duplicate, false);
    eq(r.installed, true);
    eq(r.reclaimed, undefined);
  });

  test('저장소가 던져도 주문 경로를 막지 않는다', async () => {
    const boom = { from() { throw new Error('네트워크'); } };
    const r = await claimSignal(boom, 'cid:x', 15, { nowMs: T0 });
    eq(r.duplicate, false);
    assert((r.error || '').includes('네트워크'), r.error);
  });

  console.log('[멱등 키 — 고유 id와 시간버킷]');

  test('고유 id가 있으면 그것만 쓴다 — 이웃 버킷을 안 본다', () => {
    const set = signalKeySet({
      clientId: 'abc', connectionId: 'c1', symbol: 'BTCUSDT', action: 'buy', side: 'BUY',
    });
    eq(set.key, 'cid:abc');
    eq(set.clientScoped, true);
    eq(set.neighbors.length, 0, '고유 id는 시간과 무관하다');
  });

  test('signalKey는 예전처럼 문자열 하나를 준다', () => {
    const k = signalKey({ clientId: 'abc', connectionId: 'c1', symbol: 'BTCUSDT', action: 'buy', side: 'BUY' });
    eq(k, 'cid:abc');
    const k2 = signalKey({ connectionId: 'c1', symbol: 'BTCUSDT', action: 'buy', side: 'BUY', nowMs: T0 });
    assert(k2.startsWith('c1:btcusdt:buy:buy:'), k2);
  });

  test('키는 소문자로 정규화된다 — 대소문자만 다른 재발사가 뚫리지 않게', () => {
    const a = signalKeySet({ connectionId: 'C1', symbol: 'BTCUSDT', action: 'Buy', side: 'BUY', nowMs: T0 });
    const b = signalKeySet({ connectionId: 'c1', symbol: 'btcusdt', action: 'buy', side: 'buy', nowMs: T0 });
    eq(a.key, b.key);
  });

  console.log('[멱등 키 — 청소]');

  test('만료된 행만 지운다', async () => {
    const db = fakeDb([
      { key: 'old', created_at: iso(T0 - 60_000), expires_at: iso(T0 - 45_000) },
      { key: 'live', created_at: iso(T0), expires_at: iso(T0 + 15_000) },
    ]);
    const r = await cleanupDedup(db, T0);
    eq(r.ok, true);
    eq(db.rows.length, 1);
    eq(db.rows[0].key, 'live', '살아 있는 키를 지웠다');
  });

  test('청소가 실패해도 던지지 않는다', async () => {
    const boom = { from() { throw new Error('x'); } };
    const r = await cleanupDedup(boom, T0);
    eq(r.ok, false);
  });
}
