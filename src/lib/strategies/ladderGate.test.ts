// src/lib/strategies/ladderGate.test.ts
//
// 이 테스트가 지키는 것 둘
// ────────────────────────
// 1. **중복 진입을 막는 것** — 예약을 select 없이 insert로 먼저 꽂고,
//    unique 제약(user_id, strategy_id, trade_date)에 걸린 쪽이 진다.
//    "오늘 거래했나?"를 select로 보고 insert하면 동시 요청 둘이 함께
//    통과한다. 그 순서를 바꾸면 안 된다.
//
// 2. **버려진 예약이 하루를 잡아먹지 않는 것** — 예약은 주문보다 먼저
//    꽂힌다. 그 사이에 함수가 죽으면(Vercel 실행 상한, 배포로 인한
//    인스턴스 교체) 예약만 남고 주문은 안 나간다. 그러면 unique 제약
//    때문에 **그날은 다시 시도할 수 없다.** 주문 한 건 없이 하루를 잃고,
//    화면에는 "오늘 이미 거래했습니다"로만 보인다.
//
//    하루 1회 크론일 때는 드물었다. 실행기를 15분마다로 바꾸면서 같은
//    창에 들어갈 확률이 96배가 됐다.
//
// 여기서 가장 위험한 것은 **치우다가 너무 많이 치우는 것**이다.
// entry_price가 있는 행은 주문이 나간 기록이다. 그걸 지우면 하루 1회
// 제약이 풀려 같은 날 두 번 들어간다 — 막으려던 사고보다 크다.

import { test, eq, assert } from '../../test/harness';
import { openLadderGate, confirmReservation } from './ladderGate';

/** delete 호출을 기록하는 최소 supabase 흉내 */
function makeSb(opts: { reserveError?: any } = {}) {
  const deletes: any[] = [];
  const chain = (table: string): any => {
    const filters: Record<string, any> = {};
    const c: any = {
      _table: table, _filters: filters,
      select: () => c,
      eq: (k: string, v: any) => { filters[k] = v; return c; },
      is: (k: string, v: any) => { filters[`is:${k}`] = v; return c; },
      lt: (k: string, v: any) => { filters[`lt:${k}`] = v; return c; },
      gte: () => c, order: () => c, limit: () => c,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: opts.reserveError ?? null }),
      insert: () => c,
      update: () => c,
      delete: () => { deletes.push({ table, filters }); return c; },
      then: (res: any) => res({ data: [], error: null }),
    };
    return c;
  };
  return { sb: { from: (t: string) => chain(t) } as any, deletes };
}

export function runLadderGateTests() {
  console.log('[계단식 예약 — 중복 진입과 버려진 예약]');

  test('사용자가 없으면 예약을 만들지 않는다', async () => {
    const { sb, deletes } = makeSb();
    const r = await openLadderGate(sb, { userId: null as any, realizedEquity: 1000 } as any);
    assert(!r.allowed, '사용자 없이 통과했다');
    eq(deletes.length, 0, '사용자도 모르면서 무언가를 지웠다');
  });

  // ── 버려진 예약 치우기 ──
  test('오늘의 버려진 예약을 치우고 나서 예약한다', async () => {
    const { sb, deletes } = makeSb();
    await openLadderGate(sb, { userId: 'u1', realizedEquity: 5_000_000, symbol: 'BTCUSDT' } as any);

    const d = deletes.find(x => x.table === 'ladder_daily_trades');
    assert(!!d, '버려진 예약을 치우지 않았다');

    // **너무 많이 치우면 안 된다.** 아래 네 조건이 전부 걸려 있어야 한다.
    eq(d.filters['user_id'], 'u1', '남의 예약까지 지운다');
    eq(d.filters['status'], 'RESERVED', 'RESERVED 아닌 것도 지운다');
    eq(d.filters['is:entry_price'], null, '진입한 기록까지 지운다 — 하루 1회 제약이 풀린다');
    assert(d.filters['lt:created_at'], '오래된 것만 지운다는 조건이 없다');
  });

  test('방금 만든 예약은 안 치운다 — 지금 도는 요청의 것일 수 있다', async () => {
    const { sb, deletes } = makeSb();
    const before = Date.now();
    await openLadderGate(sb, { userId: 'u1', realizedEquity: 5_000_000 } as any);
    const d = deletes.find(x => x.table === 'ladder_daily_trades');
    const cutoff = new Date(d.filters['lt:created_at']).getTime();

    assert(cutoff <= before, '기준 시각이 미래다 — 지금 것까지 지운다');
    // 실행 상한(60초)보다 넉넉해야 한다. 너무 짧으면 진행 중인 요청의
    // 예약을 지우고, 그러면 같은 날 두 번 들어갈 수 있다.
    const ageMs = before - cutoff;
    assert(ageMs >= 5 * 60_000, `기준이 너무 짧다 (${Math.round(ageMs / 1000)}초) — 진행 중인 예약을 지운다`);
  });

  // ── 중복 진입 ──
  //
  // unique 제약 위반(23505)은 "누가 먼저 예약했다"는 뜻이다.
  // 실패가 아니라 **막아야 할 것을 막은 것**이므로 그렇게 말해야 한다.
  test('예약이 unique에 걸리면 ALREADY_TRADED다', async () => {
    const { sb } = makeSb({ reserveError: { code: '23505', message: 'duplicate key' } });
    const r = await openLadderGate(sb, { userId: 'u1', realizedEquity: 5_000_000 } as any);
    if (r.rejectCode) {
      eq(r.allowed, false);
      if (r.rejectCode === 'ALREADY_TRADED') {
        assert(/하루 최대 1회|이미 거래/.test(r.reason || ''), r.reason);
      }
    }
  });

  // ── 붙잡아 둔 예약이 같은 날 재진입을 막는가 ──
  //
  // 진입 판정이 UNKNOWN이면 예약 행을 지우지 않고 상태만
  // `RECONCILE_REQUIRED`로 옮긴다(`holdReservation`). 그 행이 남아 있는
  // 동안 `(user_id, strategy_id, trade_date)` unique가 살아 있으므로
  // 같은 날 두 번째 예약은 ALREADY_TRADED로 막힌다.
  //
  // **여기서 지켜야 할 것은 묵은 예약 청소가 그 행을 건드리지 않는
  // 것이다.** 청소가 지우면 10분 뒤에 하루 잠금이 풀린다.
  test('붙잡아 둔 예약은 묵은 예약 청소가 건드리지 않는다', async () => {
    const { sb, deletes } = makeSb();
    await openLadderGate(sb, { userId: 'u1', realizedEquity: 5_000_000 } as any);
    const d = deletes.find(x => x.table === 'ladder_daily_trades');
    // 청소는 RESERVED만 지운다. RECONCILE_REQUIRED · UNPROTECTED · OPEN은
    // 이 조건에 걸리지 않는다.
    eq(d.filters['status'], 'RESERVED',
      '청소가 상태를 안 가린다 — 붙잡아 둔 예약까지 지워 하루 잠금이 풀린다');
  });

  test('붙잡아 둔 행이 있으면 같은 날 두 번째 예약은 막힌다', async () => {
    // 그 행이 남아 있으므로 insert가 unique에 걸린다.
    const { sb } = makeSb({ reserveError: { code: '23505', message: 'duplicate key' } });
    const r = await openLadderGate(sb, { userId: 'u1', realizedEquity: 5_000_000 } as any);
    eq(r.allowed, false, '미확정 주문이 있는데 같은 날 또 들어갔다');
  });

  test('unique 위반 문구를 duplicate/unique 문자열로도 잡는다', async () => {
    // 드라이버가 code를 안 주고 메시지만 줄 때가 있다. 그때 통과시키면
    // 같은 날 두 번 들어간다.
    const { sb } = makeSb({ reserveError: { message: 'duplicate key value violates unique constraint' } });
    const r = await openLadderGate(sb, { userId: 'u1', realizedEquity: 5_000_000 } as any);
    eq(r.allowed, false, 'code 없는 unique 위반을 통과시켰다');
  });

  // ── 진입 장부에 손절가와 연결을 적는가 ──
  //
  // **여기가 비어 있어서 청산 감시가 통째로 멈춰 있었다.**
  //
  // daily-ladder는 손절가를 계산해 거래소에는 걸었지만
  // `confirmReservation`에는 leverage · entryPrice · liquidationPrice만
  // 넘겼다. 그래서 `ladder_daily_trades.stop_loss`가 언제나 NULL이었고,
  // `decideExits`는 손절가가 없는 줄을 건너뛴다 — 트레일링도 본전
  // 이동도 시간 청산도 청산가 점검도 한 번도 안 돌았다.
  //
  // 연결도 같다. 없으면 감시가 사용자의 활성 연결 중 하나를 `.limit(1)`로
  // 골라서 찾는다.
  test('진입이 확정되면 손절가·익절가·연결을 함께 적는다', async () => {
    const writes: any[] = [];
    const sb: any = {
      from: () => ({
        update: (row: any) => ({ eq: async () => { writes.push(row); return { error: null }; } }),
      }),
    };
    await confirmReservation(sb, 'r1', {
      leverage: 32, entryPrice: 60000, liquidationPrice: 58000,
      stopLoss: 59000, takeProfit: 62000, connectionId: 'conn-a',
    });
    eq(writes.length, 1);
    eq(writes[0].status, 'OPEN');
    eq(writes[0].stop_loss, 59000, '손절가를 안 적으면 청산 감시가 이 거래를 못 본다');
    eq(writes[0].take_profit, 62000);
    eq(writes[0].connection_id, 'conn-a', '연결을 안 적으면 감시가 계좌를 추측한다');
    eq(writes[0].entry_price, 60000);
  });

  test('없는 값은 0이 아니라 null로 적는다', async () => {
    // 0으로 적으면 손절가 0인 포지션이 되고, 그건 1R이 진입가만큼이라는 뜻이다.
    const writes: any[] = [];
    const sb: any = {
      from: () => ({
        update: (row: any) => ({ eq: async () => { writes.push(row); return { error: null }; } }),
      }),
    };
    await confirmReservation(sb, 'r1', { leverage: 10, entryPrice: 100 });
    eq(writes[0].stop_loss, null);
    eq(writes[0].connection_id, null);
  });

  // **칸 하나 때문에 진입 기록을 통째로 잃지 않는다.**
  //
  // 065 이전 배포에는 `connection_id`가 없다. 그 칸 때문에 update가
  // 실패하면 status가 예약 상태로 남고, 그러면 거래소에는 포지션이
  // 있는데 장부에는 열린 거래가 없다 — 감시가 영원히 못 본다.
  test('connection_id 칸이 없는 배포에서는 그 칸만 빼고 다시 적는다', async () => {
    const writes: any[] = [];
    let first = true;
    const sb: any = {
      from: () => ({
        update: (row: any) => ({
          eq: async () => {
            writes.push(row);
            if (first) { first = false; return { error: { message: 'column "connection_id" does not exist' } }; }
            return { error: null };
          },
        }),
      }),
    };
    await confirmReservation(sb, 'r1', {
      leverage: 32, entryPrice: 60000, stopLoss: 59000, connectionId: 'conn-a',
    });
    eq(writes.length, 2, '한 칸 때문에 진입 기록을 통째로 잃었다');
    eq(writes[1].connection_id, undefined);
    eq(writes[1].status, 'OPEN', '두 번째 쓰기에서 OPEN이 빠지면 안 된다');
    eq(writes[1].stop_loss, 59000);
  });

  test('다른 이유로 실패하면 같은 쓰기를 반복하지 않는다', async () => {
    const writes: any[] = [];
    const sb: any = {
      from: () => ({
        update: (row: any) => ({
          eq: async () => { writes.push(row); return { error: { message: 'permission denied' } }; },
        }),
      }),
    };
    await confirmReservation(sb, 'r1', { leverage: 1, entryPrice: 1, connectionId: 'c' });
    eq(writes.length, 1, '같은 이유로 또 실패할 쓰기를 반복했다');
  });
}
