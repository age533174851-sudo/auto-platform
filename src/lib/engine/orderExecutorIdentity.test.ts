// src/lib/engine/orderExecutorIdentity.test.ts
//
// **반쪽 실행 계약은 거래소에 닿기 전에 멈춘다.**
//
// 왜 소스 순서로는 부족한가
// ─────────────────────────
// 검사기가 "guard가 insert보다 앞인가"만 보면, 나중에 누가 guard를
// 거래소 쓰기 뒤로 옮겨도 insert보다는 앞이라 통과한다. 지키려는 것은
// 그것보다 강하다:
//
//     반쪽 식별자가 있으면 **어떤 거래소 부수효과도 일어나기 전에** 거절한다
//
// 그래서 줄 위치가 아니라 **호출 횟수**로 본다. 진짜 `executeOrder`를
// 부르고, 장부에 한 번이라도 썼는지·거래소 모듈에 닿았는지를 센다.
//
// 거래소 모듈은 이 경로에 도달하지 못하므로 흉내 낼 필요도 없다 —
// 도달하면 실제 네트워크를 시도하다 실패할 테고, 그 자체가 실패 신호다.
import { test, eq, assert } from '../../test/harness';
import { executeOrder } from './orderExecutor';

/** 장부 접근을 세는 가짜. **한 번이라도 불리면 기록된다** */
function countingSb() {
  const calls: string[] = [];
  const chain: any = new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === 'then') return undefined;      // await 되지 않게
      return (...a: any[]) => {
        calls.push(`${prop}(${a.map(x => typeof x === 'string' ? x.slice(0, 20) : typeof x).join(',')})`);
        return chain;
      };
    },
  });
  return {
    calls,
    sb: { from: (t: string) => { calls.push(`from(${t})`); return chain; } },
  };
}

const PLAN = {
  approved: true, symbol: 'BTCUSDT', side: 'BUY' as const,
  quantity: 0.01, leverage: 100, positionSize: 100,
};

const ARGS = (identity: any) => ({
  userId: 'u1', connectionId: 'c1',
  clientOrderId: 'scalp-BTCUSDT-5m-1',
  exchange: 'binance' as const, mode: 'TESTNET' as const,
  plan: PLAN as any,
  apiKey: 'k', apiSecret: 's',
  stopPolicy: 'NO_FIXED_SL' as const,
  executionIdentity: identity,
});

export function runOrderExecutorIdentityTests() {
  console.log('\n🛑 반쪽 실행 계약 — 거래소에 닿기 전에 멈춘다');

  /** 셋 중 하나씩 빠진 판 */
  const HALVES: Array<[any, string]> = [
    [{ presetId: 'EXACT_100X', contractVersion: 2 }, '프로필 없음'],
    [{ profileId: 'MAX_LEV_100X', contractVersion: 2 }, '프리셋 없음'],
    [{ profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X' }, '버전 없음'],
    [{ profileId: '   ', presetId: 'EXACT_100X', contractVersion: 2 }, '프로필 공백'],
    [{ profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 'x' }, '버전이 숫자가 아님'],
  ];

  for (const [half, why] of HALVES) {
    test(`★ ${why} → REJECTED · 장부 쓰기 0회 · 거래소 쓰기 0회`, () => {
      const { sb, calls } = countingSb();
      return executeOrder(sb as any, ARGS(half) as any).then(r => {
        eq(r.ok, false, `★ ${why}인데 주문이 진행됐습니다`);
        eq((r as any).status, 'REJECTED');
        assert(String((r as any).message || '').includes('반쪽'),
          '왜 막혔는지 사유에 적어야 합니다');
        // ★ 핵심: 아무것도 건드리지 않았다.
        eq(calls.length, 0,
          `★ ${why}인데 장부를 건드렸습니다 (${calls.join(' → ')})`
          + ' — 거래소 쓰기도 이 뒤에 있습니다');
      });
    });
  }

  // 대조군 — 식별자를 아예 안 넘기면 기존 경로 그대로 진행한다.
  //
  //   여기서는 **진행한다는 사실만** 본다. 그 뒤는 장부·거래소를 실제로
  //   건드리는 구간이라 이 시험의 범위가 아니다 — 가짜 장부에 부딪혀
  //   실패하는 것이 정상이고, 중요한 것은 "반쪽 거절"로 끝나지 않는 것이다.
  test('식별자를 안 넘기면 반쪽 거절에 걸리지 않는다 (기존 경로)', () => {
    const { sb } = countingSb();
    const args: any = ARGS(undefined);
    delete args.executionIdentity;
    return executeOrder(sb as any, args).then(r => {
      const msg = String((r as any)?.message || '');
      eq(msg.includes('반쪽'), false,
        '★ 계약 없이 나가던 기존 경로가 반쪽 거절에 걸렸습니다');
    }, () => { /* 가짜 장부에 부딪혀 던져도 된다 — 반쪽 거절이 아니면 통과 */ });
  });

  test('온전한 식별자는 반쪽 거절에 걸리지 않는다', () => {
    const { sb } = countingSb();
    return executeOrder(sb as any, ARGS({
      profileId: 'MAX_LEV_100X', presetId: 'EXACT_100X', contractVersion: 2,
    }) as any).then(r => {
      const msg = String((r as any)?.message || '');
      eq(msg.includes('반쪽'), false, '★ 온전한 계약을 반쪽으로 읽었습니다');
    }, () => { /* 위와 같다 */ });
  });
}
