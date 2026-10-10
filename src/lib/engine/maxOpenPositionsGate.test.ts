// src/lib/engine/maxOpenPositionsGate.test.ts
import { test, eq, assert } from '../../test/harness';
import { maxOpenPositionsGate, type CapacityDeps } from './maxOpenPositionsGate';

const I = { maxOpenPositions: 1, mode: 'TESTNET' };
function fake(over: Partial<CapacityDeps> = {}) {
  const c = { reads: 0, pending: 0, claims: 0 };
  const deps: CapacityDeps = {
    observeExposure: async () => { c.reads++; return { positions: 0, openOrders: 0 }; },
    countPendingEntries: async () => { c.pending++; return 0; },
    claimSlot: async () => { c.claims++; return { ok: true, duplicate: false, installed: true }; },
    ...over,
  };
  return { deps, c };
}
export function runMaxOpenPositionsGateTests() {
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
