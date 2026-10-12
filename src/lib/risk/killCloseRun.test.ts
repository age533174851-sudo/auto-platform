// src/lib/risk/killCloseRun.test.ts
//
// **순서와 호출 횟수를 센다.**
//
// "막혔다"는 말만으로는 부족하다 — 막혔으면 그 아래 deps가 **한 번도
// 불리지 않아야** 한다. 특히 `cancelOrders`가 불리면 보호주문이 벗겨진
// 것이고, 그게 이 묶음이 막으려는 단 하나의 상태다.
import { test, eq, assert } from '../../test/harness';
import { runKillClose, type KillCloseDeps, type KillCloseArgs } from './killCloseRun';
import type { KillModeVerdictLike } from './killClosePlan';

const ONE_WAY: KillModeVerdictLike = {
  ok: true, code: 'ONE_WAY', mode: 'ONE_WAY', message: '단방향 확인' };
const HEDGE: KillModeVerdictLike = {
  ok: false, code: 'HEDGE_UNVERIFIED', mode: 'HEDGE', message: '양방향 규격 미확정' };
const UNKNOWN_MODE: KillModeVerdictLike = {
  ok: false, code: 'UNKNOWN', mode: null, message: '모드를 읽지 못했습니다' };
const NO_DIR: KillModeVerdictLike = {
  ok: false, code: 'NO_DIRECTION', mode: 'ONE_WAY', message: '방향을 읽지 못했습니다' };

const ARGS: KillCloseArgs = {
  connectionId: 'conn-1', exchange: 'binance', actionMode: 'CLOSE_ALL',
};

interface RigOpts {
  mode?: KillModeVerdictLike;
  modeThrows?: boolean;
  positions?: { ok: boolean; rows?: any[] | null };
  openOrders?: { ok: boolean; rows?: any[] | null };
  /** closeOne 응답을 시도 순서대로 */
  closeReplies?: Array<{ ok: boolean; ambiguous?: boolean; error?: string | null }>;
  cancelOk?: boolean;
  findReplies?: Array<{ ok: boolean; found: boolean }>;
  noFind?: boolean;
  leftover?: { ok: boolean; positions?: number | null };
  stillMine?: boolean | 'throws';
  noLease?: boolean;
}

function rig(o: RigOpts = {}) {
  const calls: string[] = [];
  let closeIdx = 0;
  let findIdx = 0;
  const cancelled: string[][] = [];
  const sentIds: string[] = [];

  const deps: KillCloseDeps = {
    readMode: async () => {
      calls.push('readMode');
      if (o.modeThrows) throw new Error('mode read failed');
      return o.mode ?? ONE_WAY;
    },
    readPositions: async () => {
      calls.push('readPositions');
      return o.positions ?? { ok: true, rows: [{ symbol: 'BTCUSDT', amount: 0.01 }] };
    },
    readOpenOrders: async () => {
      calls.push('readOpenOrders');
      return o.openOrders ?? { ok: true, rows: [
        { id: '111', symbol: 'BTCUSDT' }, { id: '999', symbol: 'SOLUSDT' }] };
    },
    cancelOrders: async (ids) => {
      calls.push('cancelOrders');
      cancelled.push([...ids]);
      return { ok: o.cancelOk !== false, cancelled: ids.length };
    },
    closeOne: async (_t, cid) => {
      calls.push('closeOne');
      sentIds.push(cid);
      const r = o.closeReplies?.[closeIdx] ?? { ok: true };
      closeIdx += 1;
      return r;
    },
    readLeftover: async () => {
      calls.push('readLeftover');
      return o.leftover ?? { ok: true, positions: 0 };
    },
  };
  if (!o.noFind) {
    deps.findByClientId = async () => {
      calls.push('findByClientId');
      const r = o.findReplies?.[findIdx] ?? { ok: true, found: false };
      findIdx += 1;
      return r;
    };
  }
  if (!o.noLease) {
    deps.stillMine = async () => {
      calls.push('stillMine');
      if (o.stillMine === 'throws') throw new Error('db down');
      return o.stillMine !== false;
    };
  }
  return { deps, calls, cancelled, sentIds };
}

export function runKillCloseRunTests() {
  // ══════════════════════════════════════════════════════════
  // 대조군
  // ══════════════════════════════════════════════════════════
  test('단방향 확인 → 대상 취소 → 축소 전용 종료 → 잔여 0 확인', async () => {
    const r0 = rig();
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r.cancelAttempted, true);
    eq(r.ordersSent, 1);
    eq(r.leftoverPositions, 0);
    eq(r.protection.code, 'CLOSED');
    eq(r.protection.unprotected, false);
  });

  test('★ 순서: 모드 → 포지션·주문 → 울타리 → 취소 → 종료 → 확인', async () => {
    const r0 = rig();
    await runKillClose(ARGS, r0.deps);
    const order = r0.calls.join(' ');
    assert(order.indexOf('readMode') === 0, `모드가 먼저여야 한다 — ${order}`);
    assert(r0.calls.indexOf('stillMine') < r0.calls.indexOf('cancelOrders'),
      '★ 울타리 재검증이 취소보다 앞이어야 한다');
    assert(r0.calls.indexOf('cancelOrders') < r0.calls.indexOf('closeOne'),
      '취소가 종료보다 앞이어야 한다');
    assert(r0.calls.indexOf('closeOne') < r0.calls.indexOf('readLeftover'),
      '확인이 마지막이어야 한다');
  });

  test('★ 취소는 대상 심볼의 주문만 — 다른 전략의 것은 넘기지 않는다', async () => {
    const r0 = rig();
    await runKillClose(ARGS, r0.deps);
    eq(r0.cancelled.length, 1);
    eq(r0.cancelled[0].join(','), '111');
    assert(!r0.cancelled[0].includes('999'), '★ SOLUSDT 주문을 지우면 안 된다');
  });

  test('★ 모든 종료 주문에 결정적 식별자가 실린다', async () => {
    const a = rig(); await runKillClose(ARGS, a.deps);
    const b = rig(); await runKillClose(ARGS, b.deps);
    eq(a.sentIds.length, 1);
    assert(a.sentIds[0].startsWith('k5t'), `긴급 종료 접두사여야 한다 — ${a.sentIds[0]}`);
    eq(a.sentIds[0], b.sentIds[0], '★ 두 실행자가 같은 값을 만들어야 중복을 알아본다');
  });

  // ══════════════════════════════════════════════════════════
  // ★ 핵심 — 닫을 수 없으면 취소하지 않는다 (호출 0회로 증명)
  // ══════════════════════════════════════════════════════════
  for (const [label, mode] of [
    ['양방향(HEDGE)', HEDGE], ['모드 UNKNOWN', UNKNOWN_MODE], ['방향 미확인', NO_DIR],
  ] as const) {
    test(`★ ${label}: cancelOrders·closeOne이 한 번도 불리지 않는다`, async () => {
      const r0 = rig({ mode });
      const r = await runKillClose(ARGS, r0.deps);
      eq(r.code, 'BLOCKED');
      eq(r0.calls.includes('cancelOrders'), false, '★ 보호주문을 건드리면 안 된다');
      eq(r0.calls.includes('closeOne'), false);
      eq(r.ordersSent, 0);
      eq(r.cancelAttempted, false);
      eq(r.plan.protectionRetained, true);
      eq(r.protection.unprotected, false);
      assert(r.plan.manualInterventionRequired, '수동 개입이 필요하다고 적어야 한다');
    });
  }

  test('★ 모드 조회가 던져도 막는다 (예외를 통과로 읽지 않는다)', async () => {
    const r0 = rig({ modeThrows: true });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'BLOCKED');
    eq(r0.calls.includes('cancelOrders'), false);
    eq(r0.calls.includes('closeOne'), false);
  });

  test('★ 막혔어도 포지션은 읽는다 — 무엇이 열려 있는지 적어야 한다', async () => {
    const r0 = rig({ mode: HEDGE });
    await runKillClose(ARGS, r0.deps);
    eq(r0.calls.includes('readPositions'), true, '조회는 주문이 아니다');
  });

  test('★ 포지션을 못 읽으면 취소도 종료도 하지 않는다', async () => {
    const r0 = rig({ positions: { ok: false, rows: null } });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.plan.code, 'BLOCKED_POSITIONS_UNREAD');
    eq(r0.calls.includes('cancelOrders'), false);
    eq(r0.calls.includes('closeOne'), false);
  });

  test('★ 미체결 주문을 못 읽으면 전체 취소 대신 취소를 건너뛰고 종료만 한다', async () => {
    const r0 = rig({ openOrders: { ok: false, rows: null } });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.plan.code, 'BLOCKED_ORDERS_UNREAD');
    eq(r0.calls.includes('cancelOrders'), false, '★ 임의 전체 취소 금지');
    eq(r.ordersSent, 1, '종료는 위험을 줄이는 방향이므로 계속한다');
    eq(r.plan.protectionRetained, true);
  });

  test('닫을 노출이 없으면 주문 0건이고 실패가 아니다', async () => {
    const r0 = rig({ positions: { ok: true, rows: [] } });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'NOTHING_TO_DO');
    eq(r.ordersSent, 0);
    eq(r0.calls.includes('cancelOrders'), false);
    eq(r.plan.manualInterventionRequired, false);
  });

  // ══════════════════════════════════════════════════════════
  // K-3 — 울타리
  // ══════════════════════════════════════════════════════════
  test('★ 쓰기 직전 울타리를 잃으면 주문 0건·취소 0건', async () => {
    const r0 = rig({ stillMine: false });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'LEASE_LOST');
    eq(r0.calls.includes('cancelOrders'), false, '★ 남의 보호주문을 지우면 안 된다');
    eq(r0.calls.includes('closeOne'), false);
    // 계획은 `PROCEED`였지만 **실제로는 취소를 보내지 않았다.** 실제 상태를
    // 말하는 칸은 `cancelAttempted`와 `protection`이다 — 계획과 구분한다.
    eq(r.cancelAttempted, false);
    eq(r.protection.unprotected, false, '보호주문이 그대로 남아 있다');
  });

  test('★ 울타리 조회가 던지면 쓰지 않는다 (fail-closed)', async () => {
    const r0 = rig({ stillMine: 'throws' });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'LEASE_LOST');
    eq(r0.calls.includes('closeOne'), false);
  });

  test('울타리 확인 수단이 없으면 예전처럼 돈다 (기존 배포 호환)', async () => {
    const r0 = rig({ noLease: true });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r0.calls.includes('stillMine'), false);
  });

  // ══════════════════════════════════════════════════════════
  // K-2 — 멱등성 · 타임아웃 · 재시도 · 중복
  // ══════════════════════════════════════════════════════════
  test('★ 타임아웃(모호)은 실패로 단정하지 않고 재전송하지 않는다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, ambiguous: true, error: 'timeout' }],
      leftover: { ok: true, positions: 1 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'CLOSE_UNKNOWN_RECONCILE_REQUIRED');
    eq(r.ordersSent, 1, '★ 모호한 뒤에 곧바로 또 보내지 않는다');
    eq(r.attempts[0].ambiguous, true);
    eq(r.attempts[0].ok, false);
  });

  test('★ 모호한 전송 뒤 잔여 0이면 대조로 닫힌 것이다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, ambiguous: true, error: 'timeout' }],
      leftover: { ok: true, positions: 0 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.code, 'CLOSED_VERIFIED');
    eq(r.protection.code, 'CLOSED');
  });

  test('★ 거부된 뒤 재시도 전에 거래소에 먼저 묻는다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, error: '-2010 insufficient' }, { ok: true }],
      findReplies: [{ ok: true, found: false }],
      leftover: { ok: true, positions: 0 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    assert(r0.calls.indexOf('findByClientId') > r0.calls.indexOf('closeOne'),
      '★ 재시도 전에 조회가 있어야 한다');
    eq(r.ordersSent, 2);
    eq(r.attempts[0].ok, true);
  });

  test('★ 이미 있다고 답하면 재전송하지 않는다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, error: '-2010' }],
      findReplies: [{ ok: true, found: true }],
      leftover: { ok: true, positions: 0 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.ordersSent, 1, '★ 중복 전송 0');
    eq(r.attempts[0].skippedExisting, true);
  });

  test('★ 조회 실패를 신규 주문 허가로 쓰지 않는다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, error: '-2010' }],
      findReplies: [{ ok: false, found: false }],
      leftover: { ok: true, positions: 1 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.ordersSent, 1, '★ 모르면 보내지 않는다');
    eq(r.attempts[0].skippedUnknown, true);
    assert(r.attempts[0].message.includes('조회 실패'), r.attempts[0].message);
  });

  test('★ 재시도 전 조회 수단이 없으면 재전송하지 않는다', async () => {
    const r0 = rig({
      noFind: true,
      closeReplies: [{ ok: false, error: '-2010' }],
      leftover: { ok: true, positions: 1 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.ordersSent, 1);
    eq(r.attempts[0].skippedUnknown, true);
  });

  test('★ 중복 식별자 거부는 실패가 아니다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, error: '-4116 DUPLICATED_CLIENT_ORDER_ID' }],
      leftover: { ok: true, positions: 0 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.attempts[0].ambiguous, true);
    eq(r.ordersSent, 1, '★ 중복 응답 뒤에 또 보내지 않는다');
    eq(r.code, 'CLOSED_VERIFIED');
  });

  test('★ 형식 오류(-4015)를 중복으로 읽지 않는다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, error: '-4015 INVALID_CL_ORD_ID_LEN' },
        { ok: false, error: '-4015 INVALID_CL_ORD_ID_LEN' },
        { ok: false, error: '-4015 INVALID_CL_ORD_ID_LEN' }],
      findReplies: [{ ok: true, found: false }, { ok: true, found: false }],
      leftover: { ok: true, positions: 1 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.attempts[0].ambiguous, false, '★ 보내지도 않은 것을 보낸 것으로 치지 않는다');
    eq(r.code, 'CLOSE_INCOMPLETE');
  });

  // ══════════════════════════════════════════════════════════
  // K-4 — 취소한 뒤 종료가 실패한 상태
  // ══════════════════════════════════════════════════════════
  test('★★ 보호주문을 취소한 뒤 포지션이 남으면 무방비로 적는다', async () => {
    const r0 = rig({
      closeReplies: [{ ok: false, error: '-2010 거부' },
        { ok: false, error: '-2010 거부' }, { ok: false, error: '-2010 거부' }],
      findReplies: [{ ok: true, found: false }, { ok: true, found: false }],
      leftover: { ok: true, positions: 1 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.cancelAttempted, true);
    eq(r.code, 'CLOSE_INCOMPLETE');
    eq(r.protection.code, 'UNPROTECTED_EXPOSURE');
    eq(r.protection.unprotected, true);
    eq(r.protection.manualInterventionRequired, true);
  });

  test('★ 잔여를 못 읽으면 0으로 적지 않는다', async () => {
    const r0 = rig({ leftover: { ok: false, positions: null } });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.leftoverPositions, null);
    eq(r.code, 'CLOSE_UNKNOWN_RECONCILE_REQUIRED');
    eq(r.protection.code, 'UNKNOWN');
    eq(r.protection.unprotected, true, '★ 취소했는데 모르면 무방비일 수 있다');
  });

  test('★ 취소를 안 했는데 포지션이 남으면 보호는 그대로다', async () => {
    const r0 = rig({
      openOrders: { ok: true, rows: [] },            // 취소할 것이 없다
      closeReplies: [{ ok: false, error: '거부' }, { ok: false, error: '거부' },
        { ok: false, error: '거부' }],
      findReplies: [{ ok: true, found: false }, { ok: true, found: false }],
      leftover: { ok: true, positions: 1 },
    });
    const r = await runKillClose(ARGS, r0.deps);
    eq(r.cancelAttempted, false);
    eq(r.protection.code, 'PROTECTION_INTACT');
    eq(r.protection.unprotected, false);
  });

  // ══════════════════════════════════════════════════════════
  // 부분 체결 · 재시작 · 표적 종료
  // ══════════════════════════════════════════════════════════
  test('★ 부분 체결로 남은 노출은 다음 회차가 지금 관측값으로 닫는다', async () => {
    // 1회차: 0.01을 닫으려다 0.006만 체결 → 잔여 0.004
    const first = rig({ leftover: { ok: true, positions: 1 } });
    const a = await runKillClose(ARGS, first.deps);
    eq(a.code, 'CLOSE_INCOMPLETE');
    // 2회차: **진입 수량이 아니라** 지금 관측한 0.004로 닫는다
    const second = rig({
      positions: { ok: true, rows: [{ symbol: 'BTCUSDT', amount: 0.004 }] },
      leftover: { ok: true, positions: 0 },
    });
    const b = await runKillClose(ARGS, second.deps);
    eq(b.plan.closes[0].qty, 0.004);
    eq(b.code, 'CLOSED_VERIFIED');
    assert(a.attempts[0].clientOrderId !== b.attempts[0].clientOrderId,
      '★ 다른 수량은 다른 의도다 — 정당한 재시도가 막히지 않아야 한다');
  });

  test('★ 재시작해도 같은 노출이면 같은 식별자다 (중복 종료 방지)', async () => {
    const a = rig(); await runKillClose(ARGS, a.deps);
    const b = rig(); await runKillClose(ARGS, b.deps);
    eq(a.sentIds[0], b.sentIds[0]);
  });

  test('표적 종료: 범위를 준 심볼만 닫고 그 심볼의 주문만 취소한다', async () => {
    const r0 = rig({
      positions: { ok: true, rows: [
        { symbol: 'BTCUSDT', amount: 0.01 }, { symbol: 'ETHUSDT', amount: -1 }] },
      openOrders: { ok: true, rows: [
        { id: '111', symbol: 'BTCUSDT' }, { id: '222', symbol: 'ETHUSDT' }] },
    });
    const r = await runKillClose({ ...ARGS, targetSymbols: ['ETHUSDT'] }, r0.deps);
    eq(r.plan.closes.length, 1);
    eq(r.plan.closes[0].symbol, 'ETHUSDT');
    eq(r0.cancelled[0].join(','), '222');
    eq(r.ordersSent, 1);
  });

  test('★ 단계가 달라지면 식별자도 달라진다', async () => {
    const a = rig(); await runKillClose({ ...ARGS, actionMode: 'CLOSE_ALL' }, a.deps);
    const b = rig(); await runKillClose({ ...ARGS, actionMode: 'REDUCE_RISK' }, b.deps);
    assert(a.sentIds[0] !== b.sentIds[0], '다른 단계는 다른 의도다');
  });
}
