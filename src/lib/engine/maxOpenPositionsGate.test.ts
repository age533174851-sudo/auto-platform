// src/lib/engine/maxOpenPositionsGate.test.ts
import { test, eq, assert } from '../../test/harness';
import {
  maxOpenPositionsGate, UNRESOLVED_ENTRY_STATUSES, ACCEPTED_ENTRY_STATUSES,
  CAPACITY_WINDOW_SEC, type CapacityDeps,
} from './maxOpenPositionsGate';
import { ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from './orderExecutor';

const I = { maxOpenPositions: 1, mode: 'TESTNET' };
function fake(over: Partial<CapacityDeps> = {}) {
  const c = { reads: 0, pending: 0, claims: 0 };
  const deps: CapacityDeps = {
    observeExposure: async () => { c.reads++; return { positions: 0, openOrders: 0 }; },
    countPendingEntries: async () => { c.pending++; return 0; },
    countRecentAcceptedEntries: async () => 0,
    claimSlot: async () => { c.claims++; return { ok: true, duplicate: false, installed: true }; },
    ...over,
  };
  return { deps, c };
}
export function runMaxOpenPositionsGateTests() {
  // ── 상태 어휘 드리프트 ──
  //
  // 처음 배선은 `['INTENT','SENT','UNKNOWN']`만 셌다. `OrderStatus`에는
  // `ACKED`(거래소 접수)가 더 있었고, 빠진 방향이 **통과**였다.
  // 어휘가 늘면 여기서 터지게 해 분류를 강제한다.
  test('★ 진입 차단 상태 + 종결 상태가 OrderStatus 전체를 덮는다', () => {
    const classified = new Set<string>([
      ...UNRESOLVED_ENTRY_STATUSES, ...ACCEPTED_ENTRY_STATUSES, ...TERMINAL_ORDER_STATUSES,
    ]);
    const missing = ORDER_STATUSES.filter(x => !classified.has(x));
    if (missing.length > 0) {
      throw new Error(`분류되지 않은 주문 상태: ${missing.join(', ')}`
        + ' — 진입을 막는 상태인지 종결 상태인지 정해야 합니다');
    }
    eq(classified.size, ORDER_STATUSES.length);
    // 두 축이 겹치면 한쪽 규칙이 무의미해진다.
    for (const a of UNRESOLVED_ENTRY_STATUSES) {
      assert(!(ACCEPTED_ENTRY_STATUSES as readonly string[]).includes(a));
      assert(!(TERMINAL_ORDER_STATUSES as readonly string[]).includes(a));
    }
    for (const a of ACCEPTED_ENTRY_STATUSES) {
      assert(!(TERMINAL_ORDER_STATUSES as readonly string[]).includes(a));
    }
  });

  test('★ ACKED(거래소 접수) 진입이 창 안에 있으면 차단한다', async () => {
    const { deps } = fake({ countRecentAcceptedEntries: async () => 1 });
    const v = await maxOpenPositionsGate(I, deps);
    assert(!v.allowed);
    eq(v.code, 'CAPACITY_PENDING');
  });

  test('★ ACKED 조회 실패는 빈 장부로 보지 않는다 (fail-closed)', async () => {
    for (const bad of [null, -1, 1.5, NaN, undefined]) {
      const { deps } = fake({ countRecentAcceptedEntries: async () => bad as any });
      const v = await maxOpenPositionsGate(I, deps);
      assert(!v.allowed);
      eq(v.code, 'CAPACITY_UNKNOWN');
    }
    const { deps } = fake({ countRecentAcceptedEntries: async () => { throw new Error('db'); } });
    eq((await maxOpenPositionsGate(I, deps)).code, 'CAPACITY_UNKNOWN');
  });

  test('★ 창을 지난 ACKED는 진입을 영구 차단하지 않는다', async () => {
    // reconcile의 PENDING_STATUSES에 ACKED가 없어서 그 줄은 해소되지 않는다.
    // 나이 제한이 없으면 한 번 진입한 계정은 다시는 진입하지 못한다.
    // 창 밖의 것은 호출부가 0으로 세므로 통과해야 한다.
    const { deps } = fake({ countRecentAcceptedEntries: async () => 0 });
    assert((await maxOpenPositionsGate(I, deps)).allowed);
    assert(CAPACITY_WINDOW_SEC > 0);
  });

  test('★ ACKED 검사는 claim 이전에 끝난다 (잠금을 낭비하지 않는다)', async () => {
    let claims = 0;
    const { deps } = fake({
      countRecentAcceptedEntries: async () => 1,
      claimSlot: async () => { claims += 1; return { ok: true, duplicate: false, installed: true }; },
    });
    const v = await maxOpenPositionsGate(I, deps);
    assert(!v.allowed);
    eq(claims, 0);
  });

  test('100X 정상 진입: claim 앞/뒤 실계좌 조회 2회', async () => {
    const { deps, c } = fake();
    const v = await maxOpenPositionsGate(I, deps);
    assert(v.allowed);
    eq(v.code, 'CAPACITY_AVAILABLE');
    eq(c.reads, 2);
    eq(c.pending, 1);
    eq(c.claims, 1);
  });
  test('BTC 이미 보유: ETH 동시 진입도 계좌 전체 상한으로 차단', async () => {
    const { deps, c } = fake({ observeExposure: async () => ({ positions: 1, openOrders: 0 }) });
    eq((await maxOpenPositionsGate(I, deps)).code, 'CAPACITY_REACHED');
    eq(c.claims, 0);
  });
  test('거래소 미체결 주문은 0 포지션이어도 차단', async () => {
    const { deps } = fake({ observeExposure: async () => ({ positions: 0, openOrders: 1 }) });
    eq((await maxOpenPositionsGate(I, deps)).code, 'CAPACITY_PENDING');
  });
  test('DB 미확정 진입은 0 포지션이어도 차단', async () => {
    const { deps } = fake({ countPendingEntries: async () => 1 });
    eq((await maxOpenPositionsGate(I, deps)).code, 'CAPACITY_PENDING');
  });
  test('계좌 조회 실패와 DB 조회 실패는 fail-closed', async () => {
    for (const d of [
      fake({ observeExposure: async () => null }).deps,
      fake({ observeExposure: async () => { throw new Error('offline'); } }).deps,
      fake({ countPendingEntries: async () => null }).deps,
    ]) eq((await maxOpenPositionsGate(I, d)).code, 'CAPACITY_UNKNOWN');
  });
  test('동시 요청 2개는 원자적 claim에 의해 1개만 통과', async () => {
    let taken = false;
    const deps = () => fake({ claimSlot: async () => {
      if (taken) return { ok: false, duplicate: true, installed: true };
      taken = true;
      return { ok: true, duplicate: false, installed: true };
    }}).deps;
    const v = await Promise.all([maxOpenPositionsGate(I, deps()), maxOpenPositionsGate(I, deps())]);
    eq(v.filter(x => x.allowed).length, 1);
    eq(v.filter(x => x.code === 'CAPACITY_BUSY').length, 1);
  });
  test('범용 dedup의 fail-open 응답은 용납하지 않음', async () => {
    for (const r of [
      { ok: true, duplicate: false, installed: false },
      { ok: true, duplicate: false, installed: true, error: 'db failure' },
      { ok: false, duplicate: false, installed: true },
    ]) {
      eq((await maxOpenPositionsGate(I, fake({ claimSlot: async () => r }).deps)).code,
        'CAPACITY_CLAIM_FAILED');
    }
  });
  test('claim 직후 노출이 생기면 전송 이전 차단', async () => {
    let n = 0;
    const d = fake({ observeExposure: async () =>
      ({ positions: ++n === 1 ? 0 : 1, openOrders: 0 }) }).deps;
    eq((await maxOpenPositionsGate(I, d)).code, 'CAPACITY_REACHED');
  });
  test('LIVE 및 2슬롯으로 숫자만 변경하면 거래소 조회도 없이 차단', async () => {
    for (const i of [
      { mode: 'LIVE', maxOpenPositions: 1 },
      { mode: 'TESTNET', maxOpenPositions: 2 },
      { mode: 'TESTNET', maxOpenPositions: 0 },
    ]) {
      const { deps, c } = fake();
      eq((await maxOpenPositionsGate(i, deps)).code, 'CAPACITY_UNSUPPORTED');
      eq(c.reads, 0);
      eq(c.claims, 0);
    }
  });
}
