// src/lib/engine/lifecycleSweep.test.ts
//
// **한 회차를 가짜 거래소·가짜 장부로 실제로 돌려서 센다.**
//
// 정규식 검사기와 뮤테이션 스윕은 "그 줄이 소스에 있는가"를 본다. 그건
// 배선 검증이다. 이 파일은 다른 것을 본다 — **돌렸을 때 몇 번 무슨 순서로
// 거래소를 부르는가.** 두 검사는 서로를 대신하지 못한다:
//
//   · 검사기가 잡는 것:  `readAfter` 호출이 소스에서 사라졌다
//   · 이 시험이 잡는 것: 호출이 있는데 청산이 **두 번** 나간다
//
// 여기서 세는 것
// ──────────────
//   ① 청산 호출 횟수 (같은 자리를 두 줄이 가리킬 때 1회)
//   ② 호출 순서 (권한 → 청산 → 재조회)
//   ③ 임차를 잃은 뒤 **다음 후보로 넘어가지 않는다**
//   ④ 장부 조회 실패가 "후보 없음"이 되지 않는다
//   ⑤ 점검 모드에서 거래소를 **한 번도** 부르지 않는다
import { test, eq, assert } from '../../test/harness';
import { runLifecycleSweepCore } from './lifecycleSweep';

const NOW = Date.parse('2026-08-27T21:00:00.000Z');
/** scalp의 검증용 보유 한도는 6시간이다 — 그보다 오래 잡은 줄을 만든다 */
const OLD = new Date(NOW - 8 * 3_600_000).toISOString();

function row(o: any = {}) {
  return {
    id: o.id ?? 'ord-1',
    connection_id: 'conn-bn', exchange: 'binance',
    symbol: 'BTCUSDT', side: 'BUY',
    avg_price: 100, stop_loss: null, stop_policy: 'NO_FIXED_SL',
    status: 'FILLED', reduce_only: false,
    acked_at: OLD, created_at: OLD,
    strategy_id: 'scalp', signal_id: '[s:scalp]sig-1',
    sl_order_id: null, tp_order_id: null,
    ...o,
  };
}

/** 부르는 것을 전부 기록하는 가짜 거래소 + 가짜 장부 */
function harness(o: {
  rows?: any[];
  readErr?: string | null;
  mine?: boolean | (() => boolean);
  closeOk?: boolean;
  afterFound?: boolean;
  afterOk?: boolean;
  dryRun?: boolean;
} = {}) {
  const calls: string[] = [];
  let closes = 0, reads = 0, mines = 0;
  // 청산을 보낸 뒤부터는 재조회가 0을 봐야 한다 — 가짜 거래소가 그렇게 움직인다
  let closed = false;
  const deps = {
    dryRun: o.dryRun === true,
    nowMs: () => NOW,
    readRows: async () => {
      calls.push('readRows');
      if (o.readErr) return { rows: [], error: o.readErr };
      return { rows: o.rows ?? [row()], error: null };
    },
    venueOf: async (_id: string) => ({ exchange: 'binance', testnet: true }),
    highWater: async () => ({ highWaterR: 0, lastPrice: 100 }),
    recordStopOrderId: async () => ({ ok: true }),
    stillMine: o.mine === undefined ? undefined : async () => {
      calls.push('stillMine'); mines += 1;
      return typeof o.mine === 'function' ? o.mine() : !!o.mine;
    },
    ops: {
      readOpenPosition: async (_v: any, _s: string) => {
        calls.push(closed ? 'readAfter' : 'readOpenPosition'); reads += 1;
        if (closed) return { ok: o.afterOk !== false, found: o.afterFound === true };
        return { ok: true, found: true, entryPrice: 100, qty: 1 };
      },
      closeSymbolPosition: async (_v: any, _s: string, _side: any) => {
        calls.push('close'); closes += 1;
        if (o.closeOk === false) return { attempted: true, ok: false, error: '거부' };
        closed = true;
        return { attempted: true, ok: true, error: null };
      },
      liveStopPrice: async () => { calls.push('liveStopPrice'); return null; },
      placeStop: async () => { calls.push('placeStop'); return { ok: true, orderId: 'sl-9' }; },
      cancelOtherStops: async () => { calls.push('cancelOtherStops'); return { cancelled: 0 }; },
    },
  };
  return { calls, deps, counts: () => ({ closes, reads, mines }) };
}

export function runLifecycleSweepTests() {
  console.log('\n🔁 생명주기 한 회차 (가짜 거래소로 실제 실행)');

  test('★ 시간 청산 대상 하나 — 청산을 **한 번** 보내고 0을 확인한다', async () => {
    const h = harness({ mine: true });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(out.candidates, 1, '후보 1건');
    eq(h.counts().closes, 1, `★ 청산을 ${h.counts().closes}번 보냈습니다`);
    eq(out.acted, 1);
    const r = out.results[0];
    eq(r.code, 'TIME_EXIT');
    eq(r.ok, true);
    eq(r.flatVerified, true);
    eq(r.stopPolicy, 'NO_FIXED_SL', '무손절 계약이 감시를 통과했다는 증거');
    eq(r.policySource, 'LIFECYCLE_TESTNET_V1', '6시간의 출처를 같이 적는다');
  });

  test('★ 순서: 권한 → 청산 → 재조회', async () => {
    const h = harness({ mine: true });
    await runLifecycleSweepCore(h.deps as any);
    const seq = h.calls.filter(c => ['stillMine', 'close', 'readAfter'].includes(c)).join('→');
    eq(seq, 'stillMine→close→readAfter', `순서가 다릅니다: ${h.calls.join('→')}`);
  });

  test('★ 같은 전략의 낡은 줄이 같이 있어도 청산은 **한 번만** 나간다', async () => {
    // 이것이 실제로 일어나는 중복이다: 같은 자리를 같은 전략의 옛 줄과 새
    // 줄이 함께 가리킨다. 후보 만들기가 새 줄만 남기고(STALE_DUPLICATE),
    // 회차 안 중복 방지가 마지막 방어선이다.
    const OLDER = new Date(NOW - 20 * 3_600_000).toISOString();
    const h = harness({ rows: [
      row({ id: 'new', acked_at: OLD }),
      row({ id: 'old', acked_at: OLDER }),
    ], mine: true });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(out.candidates, 1, '낡은 줄은 후보에서 빠진다');
    eq(h.counts().closes, 1, `★ 같은 자리에 청산이 ${h.counts().closes}번 나갔습니다`);
    assert(out.skipped.some((x: any) => x.code === 'STALE_DUPLICATE'),
      '왜 뺐는지 남는다');
  });

  test('★ 같은 계좌·종목·방향을 두 전략이 가리키면 청산을 내지 않는다', async () => {
    // 다른 전략이 같은 자리를 주장하면 둘 다 후보에 오른다. 그 상태에서
    // 청산을 내면 남의 포지션을 닫는 것이 된다.
    const h = harness({ rows: [
      row({ id: 'a', strategy_id: 'scalp', signal_id: '[s:scalp]s1' }),
      row({ id: 'b', strategy_id: 'my-original-v1', signal_id: '[s:my-original-v1]s2' }),
    ], mine: true });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(h.counts().closes, 0,
      `★ 주인을 증명 못 한 자리에 청산이 ${h.counts().closes}번 나갔습니다`);
    // 거래소 선물은 net position이다. 하나뿐인 포지션을 둘이 주장하면
    // 어느 쪽 것인지 증명할 수 없다 — 그때는 손대지 않는 것이 맞다.
    assert(out.results.every((r: any) => r.ok === true && r.code !== 'TIME_EXIT'),
      `주문을 내지 않고 사유만 남아야 합니다: ${JSON.stringify(out.results)}`);
  });

  test('★ 임차를 잃으면 청산을 보내지 않고 **회차를 끊는다**', async () => {
    const h = harness({ rows: [
      row({ id: 'a', symbol: 'BTCUSDT' }),
      row({ id: 'b', symbol: 'ETHUSDT' }),
    ], mine: false });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(h.counts().closes, 0, '★ 권한이 없는데 청산을 보냈습니다');
    const lost = out.results.filter((r: any) => r.code === 'LEASE_LOST');
    eq(lost.length, 1, '끊은 자리 하나만 남는다');
    assert(out.results.length === 1,
      `★ 임차를 잃은 뒤 다음 후보로 넘어갔습니다 (${out.results.length}건)`);
  });

  test('★ 첫 청산 뒤 임차가 넘어가면 두 번째에는 보내지 않는다', async () => {
    let n = 0;
    const h = harness({ rows: [
      row({ id: 'a', symbol: 'BTCUSDT' }),
      row({ id: 'b', symbol: 'ETHUSDT' }),
    ], mine: () => { n += 1; return n === 1; } });
    await runLifecycleSweepCore(h.deps as any);
    eq(h.counts().closes, 1, `★ 임차를 잃은 뒤에도 청산이 ${h.counts().closes}번 나갔습니다`);
  });

  test('★ 장부를 못 읽으면 "후보 없음"이 아니라 error다', async () => {
    const h = harness({ readErr: 'connection reset' });
    const out = await runLifecycleSweepCore(h.deps as any);
    assert(out.error != null, '★ 못 읽은 것을 통과로 적었습니다');
    eq(out.candidates, 0);
    eq(h.counts().closes, 0, '못 읽고 청산을 보내지 않는다');
    assert(!/후보가 없습니다/.test(out.summary), `요약이 "없음"으로 읽힙니다: ${out.summary}`);
  });

  test('★ 점검 모드는 거래소를 바꾸지 않는다', async () => {
    const h = harness({ mine: true, dryRun: true });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(h.counts().closes, 0, '★ 점검 모드에서 청산을 보냈습니다');
    eq(h.counts().mines, 0, '보내지 않으므로 권한도 묻지 않는다');
    eq(out.acted, 0);
    eq(out.results[0].dryRun, true);
  });

  test('★ 종료 후 재조회 실패를 "닫혔다"로 적지 않는다', async () => {
    const h = harness({ mine: true, afterOk: false });
    const out = await runLifecycleSweepCore(h.deps as any);
    const r = out.results[0];
    eq(r.flatVerified, null, '★ 못 읽은 것을 boolean으로 적었습니다');
    eq(r.ok, false);
    eq(r.accepted, true, '접수 사실은 남는다');
  });

  test('★ 접수됐지만 포지션이 남아 있으면 ok가 아니다 (부분 종료)', async () => {
    const h = harness({ mine: true, afterFound: true });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(out.results[0].ok, false);
    eq(out.results[0].flatVerified, false);
  });

  test('청산이 거부되면 재조회하지 않고 거부로 적는다', async () => {
    const h = harness({ mine: true, closeOk: false });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(out.results[0].accepted, false);
    eq(out.results[0].attempted, true, '보낸 사실은 남는다');
    eq(h.calls.filter(c => c === 'readAfter').length, 0);
  });

  test('연결을 못 읽으면 그 줄은 손대지 않는다', async () => {
    const h = harness({ mine: true });
    (h.deps as any).venueOf = async () => null;
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(out.results[0].code, 'NO_VENUE');
    eq(h.counts().closes, 0);
  });

  test('줄의 거래소와 연결의 거래소가 다르면 손대지 않는다', async () => {
    const h = harness({ mine: true });
    (h.deps as any).venueOf = async () => ({ exchange: 'gate', testnet: true });
    const out = await runLifecycleSweepCore(h.deps as any);
    eq(out.results[0].code, 'VENUE_MISMATCH');
    eq(h.counts().closes, 0, '★ 다른 거래소에 청산을 보냈습니다');
  });

  test('무손절 계약에는 1R이 없으므로 최고 도달 R을 구하지 않는다', async () => {
    // 분모 없는 비율을 만들지 않는다. 손절이 없으면 1R이 정의되지 않는다.
    let hw = 0;
    const h = harness({ mine: true });
    (h.deps as any).highWater = async () => { hw += 1; return { highWaterR: 0, lastPrice: 100 }; };
    await runLifecycleSweepCore(h.deps as any);
    eq(hw, 0, '★ 손절 없는 계약에서 R을 계산했습니다');
  });
}
