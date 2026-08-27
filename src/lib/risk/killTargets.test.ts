// src/lib/risk/killTargets.test.ts
//
// **순수 판정 테스트가 못 잡은 배선을 잡는다.**
//
// `discoveryVerdict({ targetCount: 2 })`는 숫자를 손으로 넣는다. 그래서
// 라우트가 수량 칸 이름을 틀려도(`p.qty` ← 실제로는 `amount`) 아무도
// 못 잡았다. 포지션이 둘 있어도 전부 0으로 떨어져 `live = []`가 되고,
// **아무것도 안 줄인 채 "줄일 포지션 없음(거래소 확인)"으로 완료**였다.
//
// 그래서 여기서는 **거래소가 실제로 주는 모양**(`ExecPosition`)으로
// 시작해서 대상까지 만들고, 닫기가 몇 번 불렸는지까지 센다.
import { test, assert, eq } from '../../test/harness';
import { liveFromPositions, targetPlan, runTargetedCloses } from './killTargets';
import { LEVELS } from './emergencyLevel';
import { killCompletion } from './killSwitchTruth';

/** `futuresListPositions()`가 돌려주는 실제 모양 */
function execPosition(symbol: string, amount: number | null) {
  return {
    symbol, side: 'LONG' as const, amount,
    entryPrice: 100, markPrice: 101, unrealizedPnl: 1, leverage: 10, liquidationPrice: 50,
  };
}

const REDUCE = LEVELS.REDUCE_RISK;
const AUTO = LEVELS.CLOSE_AUTOMATED;

export function runKillTargetsTests() {
  console.log('\n🎯 킬스위치 대상 만들기 (거래소 모양 그대로)');

  // ══ 칸 이름 ══
  test('수량 칸은 amount다 — qty·positionAmt로 읽으면 전부 0이 된다', () => {
    const live = liveFromPositions([execPosition('BTCUSDT', 0.5), execPosition('ETHUSDT', 2)]);
    eq(live.length, 2, '두 건이 살아남아야 한다');
    eq(live[0].qty, 0.5, 'BTC 수량');
    eq(live[1].qty, 2, 'ETH 수량');
  });

  test('음수(숏)도 절대값으로 잡는다', () => {
    const live = liveFromPositions([execPosition('BTCUSDT', -0.5)]);
    eq(live.length, 1, '숏도 포지션이다');
    eq(live[0].qty, 0.5, '절대값');
  });

  test('0과 null은 포지션이 아니다', () => {
    eq(liveFromPositions([execPosition('BTCUSDT', 0)]).length, 0, '0');
    eq(liveFromPositions([execPosition('BTCUSDT', null)]).length, 0, 'null');
    eq(liveFromPositions(null).length, 0, '목록 자체가 없으면 빈 목록');
  });

  // ══ 지정된 통합 시나리오 ══
  test('REDUCE_RISK + 거래소 포지션 2개 + live_orders 0개 → live 2 · VERIFIED_TARGETS(2)', async () => {
    const positions = [execPosition('BTCUSDT', 0.5), execPosition('ETHUSDT', 2)];
    const plan = targetPlan({
      spec: REDUCE,
      positions,
      positionsRead: true,
      ledgerRead: true,      // 장부는 읽혔고, 봇이 연 것은 없다
      autoSymbols: new Set<string>(),   // ← live_orders 0개
    });

    eq(plan.live.length, 2, '거래소 포지션 2개가 후보가 되어야 한다');
    eq(plan.discovery.code, 'VERIFIED_TARGETS', '줄일 대상을 찾았다');
    eq(plan.discovery.count, 2, '2건');
    eq(plan.targets.length, 2, '대상 2건');

    // 실제 닫기가 2번 불리는가
    const calls: Array<{ symbol: string; pct: number }> = [];
    const closed = await runTargetedCloses({
      targets: plan.targets, live: plan.live, closePct: REDUCE.closePct,
      close: async (symbol, pct) => { calls.push({ symbol, pct }); return { success: true, message: 'ok' }; },
      readBack: async () => 0,
    });
    eq(calls.length, 2, '닫기가 두 번 불려야 한다');
    eq(calls[0].pct, 50, '절반');
    eq(closed.length, 2, '기록 2건');
    assert(closed.every(c => c.ok), '둘 다 접수됨');

    // 그리고 완료 판정이 통과하는가
    const done = killCompletion({
      actionMode: 'AB',
      exec: { ran: true, targeted: closed, closeFailed: 0 } as any,
      leftover: { code: 'CLEAR', expectedClosed: false, reason: '미체결 0' } as any,
      discovery: plan.discovery,
    });
    assert(done.complete, '둘 다 확인됐으면 완료다');
  });

  test('예전 배선(qty·positionAmt)이었다면 잡혔을 것 — 그 모양을 재현', () => {
    // 라우트가 읽던 이름으로만 값을 담은 모양.
    const wrong = [{ symbol: 'BTCUSDT', amount: null, qty: 0.5 } as any,
                   { symbol: 'ETHUSDT', amount: null, positionAmt: 2 } as any];
    const live = liveFromPositions(wrong);
    eq(live.length, 0, 'amount가 없으면 후보가 되지 않는다');
    const plan = targetPlan({
      spec: REDUCE, positions: wrong, positionsRead: true, ledgerRead: true,
      autoSymbols: new Set<string>(),
    });
    // **이것이 예전에 "완료"로 끝나던 자리다.**
    eq(plan.discovery.code, 'VERIFIED_EMPTY', '읽었는데 후보가 0이면 이렇게 보인다');
    eq(plan.targets.length, 0, '아무것도 안 줄인다');
  });

  test('CLOSE_AUTOMATED는 봇이 연 심볼만 대상으로 삼는다', () => {
    const positions = [execPosition('BTCUSDT', 0.5), execPosition('ETHUSDT', 2)];
    const plan = targetPlan({
      spec: AUTO, positions, positionsRead: true, ledgerRead: true,
      autoSymbols: new Set(['BTCUSDT']),
    });
    eq(plan.live.length, 2, '열린 것은 둘');
    eq(plan.targets.length, 1, '봇의 것만 하나');
    eq(plan.targets[0].symbol, 'BTCUSDT', '그 심볼');
    eq(plan.discovery.code, 'VERIFIED_TARGETS', '찾았다');
  });

  test('포지션 조회 실패는 대상 0이 아니라 UNKNOWN이다', () => {
    const plan = targetPlan({
      spec: REDUCE, positions: null, positionsRead: false, ledgerRead: true,
      autoSymbols: new Set<string>(),
    });
    eq(plan.discovery.code, 'UNKNOWN', '못 읽었다');
    eq(plan.discovery.count, null, '0으로 적지 않는다');
  });

  test('CLOSE_AUTOMATED에서 장부를 못 읽으면 UNKNOWN이다', () => {
    const plan = targetPlan({
      spec: AUTO, positions: [execPosition('BTCUSDT', 0.5)],
      positionsRead: true, ledgerRead: false, autoSymbols: new Set<string>(),
    });
    eq(plan.discovery.code, 'UNKNOWN', '봇의 것을 가릴 수 없다');
  });

  // ══ 접수와 체결 ══
  test('닫기가 실패하면 재조회를 하지 않고 실패로 남는다', async () => {
    let readBacks = 0;
    const closed = await runTargetedCloses({
      targets: [{ symbol: 'BTCUSDT' }], live: [{ symbol: 'BTCUSDT', qty: 1 }], closePct: 100,
      close: async () => ({ success: false, message: '거절됨' }),
      readBack: async () => { readBacks += 1; return 0; },
    });
    eq(closed[0].ok, false, '실패');
    eq(readBacks, 0, '거절된 주문을 재조회할 이유가 없다');
    eq(closed[0].after, null, '확인하지 못했다');
  });

  test('재조회가 던지면 after는 null이다 — 0으로 적지 않는다', async () => {
    const closed = await runTargetedCloses({
      targets: [{ symbol: 'BTCUSDT' }], live: [{ symbol: 'BTCUSDT', qty: 1 }], closePct: 100,
      close: async () => ({ success: true, message: 'ok' }),
      readBack: async () => { throw new Error('network'); },
    });
    eq(closed[0].after, null, '못 읽은 것을 0으로 적으면 닫혔다가 사실이 된다');
  });

  test('before는 대상의 원래 수량이다 — 절반 축소 확인에 쓴다', async () => {
    const closed = await runTargetedCloses({
      targets: [{ symbol: 'ETHUSDT' }], live: [{ symbol: 'ETHUSDT', qty: 2 }], closePct: 50,
      close: async () => ({ success: true, message: 'ok' }),
      readBack: async () => 1,
    });
    eq(closed[0].before, 2, '전');
    eq(closed[0].after, 1, '후');
    eq(closed[0].closePct, 50, '목표');
  });
}
