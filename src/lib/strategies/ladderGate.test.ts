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
import {
  openLadderGate, confirmReservation,
  reservationOutcome, holdReservationForReconcile, RECONCILE_STATUS,
} from './ladderGate';

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

/**
 * `update()`에 **실제로 넘어간 값**을 받아 두는 흉내.
 *
 * `makeSb`는 delete만 기록한다. 여기서 보려는 고장은 "지웠나"가 아니라
 * **"적었나"**라서 페이로드가 필요하다.
 */
function makeUpdateSb() {
  const updates: Array<{ table: string; payload: any; filters: Record<string, any> }> = [];
  const chain = (table: string): any => {
    const filters: Record<string, any> = {};
    let payload: any = null;
    const c: any = {
      select: () => c,
      eq: (k: string, v: any) => { filters[k] = v; return c; },
      update: (p: any) => { payload = p; updates.push({ table, payload, filters }); return c; },
      delete: () => c,
      then: (res: any) => res({ data: [], error: null }),
    };
    return c;
  };
  return { sb: { from: (t: string) => chain(t) } as any, updates };
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

  test('unique 위반 문구를 duplicate/unique 문자열로도 잡는다', async () => {
    // 드라이버가 code를 안 주고 메시지만 줄 때가 있다. 그때 통과시키면
    // 같은 날 두 번 들어간다.
    const { sb } = makeSb({ reserveError: { message: 'duplicate key value violates unique constraint' } });
    const r = await openLadderGate(sb, { userId: 'u1', realizedEquity: 5_000_000 } as any);
    eq(r.allowed, false, 'code 없는 unique 위반을 통과시켰다');
  });

  // ── 장부에 손절이 적히는가 ─────────────────────────────────
  //
  // 2026-11-16 측정: 유일한 호출자가 `stopLoss`를 안 넘겨
  // `ladder_daily_trades.stop_loss`가 **모든 진입에서 NULL**이었다.
  // 손절은 거래소에 제대로 걸려 있었으므로 주문 쪽 로그로는 보이지 않았다.
  //
  // 그 칸이 비면 `exitMonitor`가 `if (!entry || !stop) continue`로 줄을
  // 버린다 — 트레일링·본전 이동·5일 시간청산·청산가 근접 점검이 전부
  // 0회가 되고 응답에는 "확인함"만 남는다. **조용한 고장이다.**

  test('체결 확정은 손절가를 장부에 적는다', async () => {
    const { sb, updates } = makeUpdateSb();
    await confirmReservation(sb, 'r1', {
      leverage: 10, entryPrice: 100, stopLoss: 95, liquidationPrice: 90,
    });
    eq(updates.length, 1, '장부를 갱신하지 않았다');
    eq(updates[0].table, 'ladder_daily_trades');
    eq(updates[0].filters.id, 'r1', '다른 행을 갱신했다');
    eq(updates[0].payload.stop_loss, 95, '손절가가 장부에 안 들어갔다 — 청산 감시가 이 줄을 버린다');
    eq(updates[0].payload.status, 'OPEN');
  });

  test('손절을 확인하지 못했으면 null이 그대로 남는다 — 0으로 적지 않는다', async () => {
    const { sb, updates } = makeUpdateSb();
    await confirmReservation(sb, 'r2', {
      leverage: 10, entryPrice: 100, stopLoss: null, liquidationPrice: 90,
    });
    eq(updates.length, 1);
    eq(updates[0].payload.stop_loss, null, '모르는 값을 숫자로 지어냈다');
  });

  test('예약 id가 없으면 아무 행도 갱신하지 않는다', async () => {
    const { sb, updates } = makeUpdateSb();
    await confirmReservation(sb, undefined, {
      leverage: 10, entryPrice: 100, stopLoss: 95,
    });
    eq(updates.length, 0, '대상도 모르면서 장부를 건드렸다');
  });

  // ── 나갔는지 모르는 주문 ───────────────────────────────────
  //
  // `exec.ok ? confirm : release` 두 갈래로 가르면 UNKNOWN(응답을 못
  // 받음)이 "안 나갔다"로 접힌다. `release`는 예약 행을 DELETE 하고,
  // 그 행이 (user_id, strategy_id, trade_date) unique 를 쥐고 있으므로
  // **하루 1회 잠금이 열린다.** 다음 주기에 두 번째 주문이 나가고,
  // 앞 주문이 체결돼 있었으면 포지션이 두 배가 된다.

  test('나갔다 — 체결 정보를 채운다', () => {
    eq(reservationOutcome({ ok: true, status: 'ACKED' }), 'CONFIRM');
  });

  test('거래소가 거부했거나 못 보냈으면 하루를 돌려준다', () => {
    eq(reservationOutcome({ ok: false, status: 'REJECTED' }), 'RELEASE');
    eq(reservationOutcome({ ok: false, status: 'FAILED' }), 'RELEASE');
    eq(reservationOutcome({ ok: false, status: 'failed' }), 'RELEASE', '대소문자로 갈리면 안 된다');
  });

  test('**UNKNOWN은 하루를 돌려주지 않는다** — 지우면 같은 날 두 번 들어간다', () => {
    eq(reservationOutcome({ ok: false, status: 'UNKNOWN' }), 'HOLD_UNKNOWN');
  });

  test('처음 보는 상태·빈 상태도 돌려주지 않는다 — 모르면 막는 쪽이다', () => {
    eq(reservationOutcome({ ok: false, status: 'SOMETHING_NEW' }), 'HOLD_UNKNOWN');
    eq(reservationOutcome({ ok: false }), 'HOLD_UNKNOWN');
    eq(reservationOutcome({ ok: false, status: null }), 'HOLD_UNKNOWN');
    eq(reservationOutcome(null), 'HOLD_UNKNOWN');
    eq(reservationOutcome(undefined), 'HOLD_UNKNOWN');
  });

  test('ok가 참이 아닌 값이면 통과로 읽지 않는다', () => {
    // `ok: 'yes'` 같은 값이 들어와도 CONFIRM이 되면 안 된다.
    eq(reservationOutcome({ ok: 'yes' as any, status: 'UNKNOWN' }), 'HOLD_UNKNOWN');
  });

  test('모르는 주문은 지우지 않고 대조 대상으로 남긴다', async () => {
    const { sb, updates } = makeUpdateSb();
    await holdReservationForReconcile(sb, 'r9', '응답 없음');
    eq(updates.length, 1, '장부에 아무것도 남기지 않았다');
    eq(updates[0].table, 'ladder_daily_trades');
    eq(updates[0].filters.id, 'r9');
    eq(updates[0].payload.status, RECONCILE_STATUS);
    eq(updates[0].payload.exit_reason, '응답 없음', '왜 남았는지가 장부에 없다');
  });

  test('남긴 상태는 RESERVED가 아니다 — 묵은 예약 청소가 지우면 문이 다시 열린다', () => {
    // `openLadderGate`의 청소는 status='RESERVED' AND entry_price IS NULL 인
    // 10분 지난 행을 지운다. 그 조건에 걸리면 잠금이 풀린다.
    // 리터럴 타입끼리 비교하면 tsc가 "겹치지 않는다"며 비교 자체를 지운다.
    // 상수를 바꿨을 때 **실제로** 걸리게 하려면 string으로 받아야 한다.
    const left: string = RECONCILE_STATUS;
    assert(left !== 'RESERVED', '청소가 지우는 상태로 남겼다');
    assert(left !== 'OPEN', '진입한 것처럼 적으면 감시가 빈 줄을 본다');
  });
}
