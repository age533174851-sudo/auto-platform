// src/lib/engine/strategyConflictGate.test.ts
//
// **경로가 셋인데 하나만 고쳐져 있었다.**
//
// `symbolOwnershipConflict`는 만들어진 뒤 `my-original-v1` 한 곳에서만
// 쓰였다. 이 시험은 그 판정을 감싼 관문이 **DB를 못 읽었을 때 통과로
// 넘기지 않는지**를 지킨다 — 그게 이 관문의 유일한 실패 방식이다.

import { test, eq, assert } from '../../test/harness';
import { strategyConflictGate, sleeveCapitalGate } from './strategyConflictGate';

/** from(...).select(...).eq(...) 사슬을 흉내 낸다 */
function fakeSb(handlers: Record<string, any>) {
  return {
    from(table: string) {
      const h = handlers[table];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => (typeof h === 'function' ? h() : h) ?? { data: null, error: null },
        then: undefined,
      };
      // eq 체인의 마지막에서 await 되는 경우
      chain.eq = () => ({
        ...chain,
        eq: chain.eq,
        maybeSingle: chain.maybeSingle,
        then: (res: any) => res((typeof h === 'function' ? h() : h) ?? { data: [], error: null }),
      });
      return chain;
    },
  };
}

export function runStrategyConflictGateTests() {
  console.log('[진입 관문 — 같은 판단을 세 곳에 복사하지 않는다]');

  test('겹치는 전략이 없으면 통과한다', async () => {
    const sb = fakeSb({ autotrade_schedules: { data: [
      { symbol: 'BTCUSDT', connection_id: 'c1', strategy_id: 'my-original-v1', enabled: true },
    ], error: null } });
    const v = await strategyConflictGate(sb, {
      userId: 'u1', myStrategyId: 'my-original-v1', symbol: 'BTCUSDT', connectionId: 'c1',
    });
    eq(v.ok, true);
  });

  test('**같은 종목에 다른 전략이 켜져 있으면 막는다**', async () => {
    const sb = fakeSb({ autotrade_schedules: { data: [
      { symbol: 'BTCUSDT', connection_id: 'c1', strategy_id: 'daily-ladder', enabled: true },
    ], error: null } });
    const v = await strategyConflictGate(sb, {
      userId: 'u1', myStrategyId: 'my-original-v1', symbol: 'BTCUSDT', connectionId: 'c1',
    });
    eq(v.ok, false);
    eq(v.code, 'BLOCK_CONFLICT');
  });

  test('**예약을 못 읽으면 통과가 아니다**', async () => {
    // 못 읽었는데 "겹치는 것 없음"으로 읽으면, 정확히 막으려던 상황에서
    // 막지 못한다.
    const sb = fakeSb({ autotrade_schedules: { data: null, error: { message: 'boom' } } });
    const v = await strategyConflictGate(sb, {
      userId: 'u1', myStrategyId: 'my-original-v1', symbol: 'BTCUSDT', connectionId: 'c1',
    });
    eq(v.ok, false);
    eq(v.code, 'SCHEDULES_UNKNOWN');
  });

  test('조회가 통째로 터져도 통과로 넘기지 않는다', async () => {
    const sb = { from() { throw new Error('네트워크'); } } as any;
    const v = await strategyConflictGate(sb, {
      userId: 'u1', myStrategyId: 'x', symbol: 'BTCUSDT', connectionId: 'c1',
    });
    eq(v.ok, false);
  });

  // ── 전략 계좌 ──

  test('전략 계좌가 없으면 막지 않는다 — 돌던 전략이 갑자기 멈추면 안 된다', async () => {
    const sb = fakeSb({ strategy_accounts: { data: null, error: null } });
    const v = await sleeveCapitalGate(sb, { userId: 'u1', strategyId: 'x' });
    eq(v.allowed, true);
    eq(v.code, 'NO_SLEEVE');
  });

  test('표 자체가 없어도 막지 않는다 (041 이전)', async () => {
    const sb = fakeSb({ strategy_accounts: {
      data: null, error: { message: 'relation "strategy_accounts" does not exist' } } });
    const v = await sleeveCapitalGate(sb, { userId: 'u1', strategyId: 'x' });
    eq(v.allowed, true);
    eq(v.code, 'NO_SLEEVE');
  });

  test('**돈의 소유권을 못 읽으면 신규 진입을 막는다**', async () => {
    // 처음에는 여기서 막지 않았다. "조회 실패로 매매가 멎으면 그게 더 큰
    // 사고"라고 봤기 때문이다. 그건 틀렸다 — 소유권을 모르는 채로
    // 진입을 허용하면, 정확히 이 관문이 막으려던 상황(남의 증거금을
    // 쓰는 진입)에서 막지 못한다.
    const sb = fakeSb({ strategy_accounts: { data: null, error: { message: 'timeout' } } });
    const v = await sleeveCapitalGate(sb, { userId: 'u1', strategyId: 'x' });
    eq(v.code, 'UNKNOWN');
    eq(v.allowed, false);
    assert(/신규 진입을 막았습니다/.test(v.reason), v.reason);
    // **막는 것은 새로 여는 것뿐이다**
    assert(/청산·보호는 계속/.test(v.reason), v.reason);
  });

  test('예외도 통과로 읽지 않는다', async () => {
    const sb = { from() { throw new Error('네트워크'); } } as any;
    const v = await sleeveCapitalGate(sb, { userId: 'u1', strategyId: 'x' });
    eq(v.allowed, false);
  });
}
