// src/lib/engine/mutationGuard.test.ts
//
// **회차 안의 중복과 실행 사이의 중복은 다른 문제다.**
//
// 이 파일은 ①(회차 안)만 시험한다. ②(다른 워커·임차 탈취)는 임차 시험
// (`exitMonitorLease.test.ts`)과 청산 실행 시험(`lifecycleAction.test.ts`)이
// 맡는다 — 한 장치로 둘 다 막으려 하면 둘 다 못 막는다.
import { test, eq } from '../../test/harness';
import { mutationGuardFor } from './mutationGuard';
import { mutationKeyOf } from './managedPosition';

export function runMutationGuardTests() {
  console.log('\n🔁 회차 안 중복 방지');

  test('★ 같은 계좌·종목·방향은 한 회차에 한 번만 통과한다', () => {
    const g = mutationGuardFor(7);
    const key = mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' } as any);
    eq(g.claim(key), true, '처음은 통과');
    eq(g.claim(key), false, '★ 같은 자리에 두 번째 주문이 나갔습니다');
    eq(g.size(), 1);
  });

  test('방향이 다르면 다른 자리다', () => {
    const g = mutationGuardFor(7);
    eq(g.claim(mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' } as any)), true);
    eq(g.claim(mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'SHORT' } as any)), true);
  });

  test('계좌가 다르면 다른 자리다', () => {
    const g = mutationGuardFor(7);
    eq(g.claim(mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' } as any)), true);
    eq(g.claim(mutationKeyOf({ connectionId: 'c2', symbol: 'BTCUSDT', side: 'LONG' } as any)), true);
  });

  test('★ 키를 못 만든 줄은 통과시키지 않는다', () => {
    // 빈 키가 여럿이면 전부 같은 자리로 보이거나 전부 다른 자리로 보인다.
    const g = mutationGuardFor(7);
    eq(g.claim(''), false);
    eq(g.claim(undefined as any), false);
    eq(g.size(), 0);
  });

  test('★ 임차가 바뀌면 다른 회차다 — 옛 표식이 새 회차를 막지 않는다', () => {
    const key = mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' } as any);
    const g7 = mutationGuardFor(7);
    eq(g7.claim(key), true);
    const g8 = mutationGuardFor(8);
    eq(g8.claim(key), true, '★ 새 임차 회차가 옛 표식에 막혔습니다');
    eq(g8.fence, 8);
  });

  test('임차 표가 없는 배포에서도 회차 안 중복은 막는다', () => {
    const g = mutationGuardFor(null);
    const key = mutationKeyOf({ connectionId: 'c1', symbol: 'ETHUSDT', side: 'SHORT' } as any);
    eq(g.fence, null);
    eq(g.claim(key), true);
    eq(g.claim(key), false);
  });

  test('★ 여러 자리를 섞어도 각 자리는 한 번씩만', () => {
    const g = mutationGuardFor(1);
    const keys = [
      mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' } as any),
      mutationKeyOf({ connectionId: 'c1', symbol: 'ETHUSDT', side: 'LONG' } as any),
      mutationKeyOf({ connectionId: 'c1', symbol: 'BTCUSDT', side: 'LONG' } as any),
      mutationKeyOf({ connectionId: 'c1', symbol: 'ETHUSDT', side: 'LONG' } as any),
    ];
    eq(keys.map(k => g.claim(k)).filter(Boolean).length, 2, '★ 중복이 통과했습니다');
    eq(g.size(), 2);
  });
}
