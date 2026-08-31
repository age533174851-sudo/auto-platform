// src/lib/engine/paperOpenAtomic.test.ts
//
// **모의 진입에 '부분 성공'이라는 상태가 없다.**
//
// 회귀 대상: 진입은 `paper_positions` INSERT → `paper_apply_entry_fee` RPC
// 두 단계였다. 서로 다른 트랜잭션이라 뒤쪽만 실패할 수 있었고, 그러면
// 포지션은 있는데 수수료가 안 빠진 계좌가 영구히 남았다. 실패를 읽는
// 코드도 한 곳도 없었다.
//
// 여기서 붙드는 것 두 가지:
//
//   ① TypeScript 계약 — 호출부가 OPENED / DUPLICATE / NO_ACCOUNT / ERROR를
//      정확히 옮기고, 실패에서 **옛 두 단계 경로로 되돌아가지 않는다**
//   ② SQL 계약은 검사기가 본다 (아래 참고)
//
// DB를 실제로 띄우는 통합 시험대는 이 저장소에 없다. **없는 시험 인프라를
// 새로 만들지 않는다.** 시험은 임시 디렉터리에서 `src`만 갖고 돌기 때문에
// 저장소의 SQL 파일도 여기서는 읽을 수 없다 — SQL 계약(잠금·같은 함수 안의
// INSERT와 수수료 갱신·잔고 산술)은 `check-paper-open-atomic.mjs`가 본다.

import { test, eq, assert } from '../../test/harness';
import { openPaperPosition } from './paperStore';

const PLAN: any = {
  symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01, positionSize: 1000,
  leverage: 10, requiredMargin: 100, approved: true,
  stopDistancePct: 2, effectiveStopPct: 2, riskAmount: 20,
  riskAmountWithCosts: 21, liquidationPrice: 0, liquidationDistancePct: 9, notes: [],
};

export function runPaperOpenAtomicTests() {
  console.log('[모의 진입 원자성 — 포지션과 수수료는 함께 남는다]');

  // ── ① 호출부 계약 ──

  test('OPENED면 포지션 id를 그대로 돌려준다', async () => {
    let called = 0;
    const sb: any = {
      rpc: (fn: string, p: any) => {
        called++;
        eq(fn, 'paper_open_position');
        // 금액은 호출부가 계산해서 넘긴다 — SQL이 다시 만들지 않는다.
        assert(Number(p.p_entry_fee) >= 0, '진입 수수료를 넘겨야 한다');
        assert(p.p_quantity > 0, '수량을 넘겨야 한다');
        return Promise.resolve({ data: [{ status: 'OPENED', position_id: 'pos-1' }], error: null });
      },
    };
    const r = await openPaperPosition(sb, {
      userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });
    eq(r.ok, true);
    eq(r.status, 'OPENED');
    eq(r.positionId, 'pos-1');
    eq(called, 1);
  });

  test('중복 신호는 포지션을 만들지 않는다', async () => {
    const sb: any = {
      rpc: () => Promise.resolve({ data: [{ status: 'DUPLICATE', position_id: 'pos-old' }], error: null }),
    };
    const r = await openPaperPosition(sb, {
      userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });
    eq(r.ok, false);
    eq(r.status, 'DUPLICATE');
    eq(r.duplicate, true);
    eq(r.positionId, undefined);
  });

  test('계좌가 없으면 NO_ACCOUNT — 여기서 계좌를 만들지 않는다', async () => {
    const sb: any = {
      rpc: () => Promise.resolve({ data: [{ status: 'NO_ACCOUNT', position_id: null }], error: null }),
    };
    const r = await openPaperPosition(sb, {
      userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });
    eq(r.ok, false);
    eq(r.status, 'NO_ACCOUNT');
    eq(r.positionId, undefined);
  });

  test('**RPC가 실패해도 옛 두 단계 경로로 되돌아가지 않는다**', async () => {
    // 되돌아가면 이 변경이 없애려던 부분 성공이 그대로 살아난다.
    let usedFrom = 0;
    const sb: any = {
      rpc: () => Promise.resolve({ data: null, error: { message: 'db down' } }),
      from() { usedFrom++; return {}; },
    };
    const r = await openPaperPosition(sb, {
      userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });
    eq(r.ok, false);
    eq(r.status, 'ERROR');
    eq(usedFrom, 0);      // 표를 직접 건드리지 않았다
  });

  test('rpc 자체가 던져도 포지션을 만들었다고 적지 않는다', async () => {
    const sb: any = { rpc: () => { throw new Error('boom'); } };
    const r = await openPaperPosition(sb, {
      userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });
    eq(r.ok, false);
    eq(r.status, 'ERROR');
  });

  test('모르는 결과를 성공으로 읽지 않는다', async () => {
    for (const status of ['', 'WHATEVER', null, undefined]) {
      const sb: any = { rpc: () => Promise.resolve({ data: [{ status }], error: null }) };
      const r = await openPaperPosition(sb, {
        userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
      });
      eq(r.ok, false);
      eq(r.status, 'ERROR');
    }
  });

  test('부분 성공을 표현하는 칸이 남아 있지 않다', async () => {
    const sb: any = {
      rpc: () => Promise.resolve({ data: [{ status: 'OPENED', position_id: 'p' }], error: null }),
    };
    const r: any = await openPaperPosition(sb, {
      userId: 'u', signalId: 's1', strategyId: 'scalp', plan: PLAN, entryPrice: 100_000,
    });
    // 예전에는 `feeApplied: boolean | null`이 있었고 아무도 읽지 않았다.
    // 그 칸이 있는 한 "포지션은 있고 수수료는 모름"이 표현 가능하다.
    eq('feeApplied' in r, false);
  });

}
