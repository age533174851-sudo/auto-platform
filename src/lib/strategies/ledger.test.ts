// src/lib/strategies/ledger.test.ts
//
// 막으려는 사고 두 가지:
//  1. 전략 A의 손절이 전략 B의 포지션까지 닫는 것
//  2. 장부와 거래소가 어긋났을 때 차이를 전략들에 임의로 나눠 붙이는 것
import { test, assert, eq } from '../../test/harness';
import {
  tagStrategy, strategyOf, attribute, canClose,
  canSpend, checkOverAllocation, detectConflicts, resolveConflict,
  type StrategyHolding, type Allocation, type StrategyIntent,
} from './ledger';

const hold = (
  strategyId: string, qty: number, symbol = 'BTCUSDT',
  market: StrategyHolding['market'] = 'USDT_FUTURES',
): StrategyHolding => ({ strategyId, symbol, market, qty, avgPrice: 100 });

export function runLedgerTests() {
  console.log('[전략 장부 — 남의 포지션을 닫지 않는다]');

  test('자기 귀속분을 넘겨 닫을 수 없다', () => {
    const book = [hold('A', 0.02), hold('B', 0.03)];
    const r = canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', 0.05);
    eq(r.ok, false, 'A가 전량(0.05)을 닫아 B의 물량까지 사라졌다');
    eq(r.allowedQty, 0.02, '닫아도 되는 양이 자기 보유와 다르다');
    assert(r.reason!.includes('B'), '누구 것이 사라지는지 안 알려준다: ' + r.reason);
  });

  test('자기 몫만큼은 닫을 수 있다', () => {
    const book = [hold('A', 0.02), hold('B', 0.03)];
    eq(canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', 0.02).ok, true);
    eq(canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', 0.01).ok, true, '부분 청산이 막혔다');
  });

  test('포지션이 없는 전략은 닫을 수 없다', () => {
    const r = canClose([hold('B', 0.03)], 'A', 'BTCUSDT', 'USDT_FUTURES', 0.01);
    eq(r.ok, false, 'A가 B의 포지션을 닫았다');
    eq(r.allowedQty, 0);
  });

  test('SHORT도 절대값 기준으로 자기 몫까지만', () => {
    const book = [hold('A', -0.02), hold('B', -0.03)];
    eq(canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', 0.02).ok, true);
    eq(canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', 0.04).ok, false);
  });

  test('현물과 선물은 서로 다른 장부다', () => {
    const book = [hold('A', 0.5, 'BTCUSDT', 'SPOT'), hold('A', 0.02, 'BTCUSDT', 'USDT_FUTURES')];
    // 현물 0.5를 들고 있다고 선물 0.5를 닫을 수는 없다
    eq(canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', 0.5).ok, false);
    eq(canClose(book, 'A', 'BTCUSDT', 'SPOT', 0.5).ok, true);
  });

  test('수량이 이상하면 막는다', () => {
    const book = [hold('A', 0.02)];
    eq(canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', 0).ok, false);
    eq(canClose(book, 'A', 'BTCUSDT', 'USDT_FUTURES', NaN).ok, false);
  });

  console.log('[전략 장부 — 차이를 나눠 붙이지 않는다]');

  test('거래소가 더 많으면 미귀속으로 남긴다', () => {
    const r = attribute([hold('A', 0.02), hold('B', 0.03)], 'BTCUSDT', 'USDT_FUTURES', 0.07);
    eq(r.attributed, 0.05);
    assert(Math.abs(r.unattributed! - 0.02) < 1e-9, String(r.unattributed));
    eq(r.matched, false);
    assert(r.note.includes('수동'), r.note);
  });

  test('장부가 더 많으면 그 사실을 알린다', () => {
    const r = attribute([hold('A', 0.05)], 'BTCUSDT', 'USDT_FUTURES', 0.02);
    assert(r.unattributed! < 0, '장부 초과가 음수로 안 나온다');
    assert(r.note.includes('청산') || r.note.includes('종료'), r.note);
  });

  test('일치하면 일치라고 한다', () => {
    const r = attribute([hold('A', 0.02), hold('B', 0.03)], 'BTCUSDT', 'USDT_FUTURES', 0.05);
    eq(r.matched, true);
    eq(r.unattributed, 0);
  });

  test('거래소 반올림 정도의 차이는 일치로 본다', () => {
    const r = attribute([hold('A', 0.05)], 'BTCUSDT', 'USDT_FUTURES', 0.0500001);
    eq(r.matched, true, '반올림 차이마다 불일치가 뜨면 경고를 무시하게 된다');
  });

  test('거래소를 못 읽으면 일치라고 하지 않는다', () => {
    const r = attribute([hold('A', 0.02)], 'BTCUSDT', 'USDT_FUTURES', null);
    eq(r.matched, false, '확인 불가를 일치로 처리했다');
    eq(r.unattributed, null);
    assert(r.note.includes('일치한다는 뜻이 아닙니다'), r.note);
  });

  test('다른 종목·다른 시장은 합산하지 않는다', () => {
    const book = [
      hold('A', 0.02, 'BTCUSDT', 'USDT_FUTURES'),
      hold('A', 5, 'ETHUSDT', 'USDT_FUTURES'),
      hold('A', 1, 'BTCUSDT', 'SPOT'),
    ];
    eq(attribute(book, 'BTCUSDT', 'USDT_FUTURES', 0.02).attributed, 0.02);
  });

  console.log('[전략 장부 — 자금 분리]');

  test('다른 전략의 예산을 쓸 수 없다', () => {
    const allocs: Allocation[] = [
      { strategyId: 'A', budgetUsd: 100, usedUsd: 90 },
      { strategyId: 'B', budgetUsd: 900, usedUsd: 0 },
    ];
    const r = canSpend(allocs, 'A', 50);
    eq(r.ok, false, 'A가 B의 예산을 썼다');
    eq(r.availableUsd, 10);
    assert(r.reason!.includes('다른 전략의 자금은 쓸 수 없습니다'), r.reason);
  });

  test('자기 예산 안이면 쓸 수 있다', () => {
    const allocs: Allocation[] = [{ strategyId: 'A', budgetUsd: 100, usedUsd: 40 }];
    eq(canSpend(allocs, 'A', 60).ok, true, '딱 맞는 금액이 막혔다');
    eq(canSpend(allocs, 'A', 61).ok, false);
  });

  test('예산이 배정되지 않은 전략은 못 쓴다', () => {
    const r = canSpend([{ strategyId: 'A', budgetUsd: 100, usedUsd: 0 }], 'Z', 1);
    eq(r.ok, false, '배정 없이 주문이 나갔다');
  });

  test('예산 합계가 지갑을 넘으면 막는다', () => {
    const r = checkOverAllocation([
      { strategyId: 'A', budgetUsd: 700, usedUsd: 0 },
      { strategyId: 'B', budgetUsd: 500, usedUsd: 0 },
    ], 1000);
    eq(r.ok, false, '같은 돈을 두 전략이 각자 자기 것으로 계산한다');
    assert(Math.abs(r.excess - 200) < 1e-9, String(r.excess));
  });

  test('지갑을 모르면 검증했다고 하지 않는다', () => {
    const r = checkOverAllocation([{ strategyId: 'A', budgetUsd: 100, usedUsd: 0 }], null);
    eq(r.ok, false, '지갑을 모르는데 통과시켰다');
  });

  test('합계가 지갑 이하면 통과한다', () => {
    eq(checkOverAllocation([
      { strategyId: 'A', budgetUsd: 400, usedUsd: 0 },
      { strategyId: 'B', budgetUsd: 600, usedUsd: 0 },
    ], 1000).ok, true);
  });

  console.log('[전략 장부 — 충돌]');

  const intent = (s: string, qty: number, symbol = 'BTCUSDT',
                  market: StrategyIntent['market'] = 'USDT_FUTURES'): StrategyIntent =>
    ({ strategyId: s, symbol, market, qty });

  test('같은 종목 반대 방향은 차단 대상이다', () => {
    const c = detectConflicts([intent('A', 0.02), intent('B', -0.03)]);
    const opp = c.find(x => x.code === 'OPPOSITE_DIRECTION');
    assert(!!opp, '반대 방향을 못 잡았다');
    eq(opp!.severity, 'block');
    assert(opp!.detail.includes('상쇄'), opp!.detail);
  });

  test('같은 방향으로 쌓이면 경고한다', () => {
    const c = detectConflicts([intent('A', 0.02), intent('B', 0.03)]);
    const st = c.find(x => x.code === 'SAME_DIRECTION_STACK');
    assert(!!st);
    eq(st!.severity, 'warn', '같은 방향까지 막으면 정상 운용이 안 된다');
  });

  test('전략이 하나면 충돌이 없다', () => {
    eq(detectConflicts([intent('A', 0.02)]).length, 0);
  });

  test('다른 종목끼리는 충돌이 아니다', () => {
    eq(detectConflicts([intent('A', 0.02, 'BTCUSDT'), intent('B', -1, 'ETHUSDT')]).length, 0);
  });

  test('현물 보유 + 선물 숏은 막지 않고 알린다', () => {
    const c = detectConflicts([intent('A', 1, 'BTCUSDT', 'SPOT'), intent('B', -0.5, 'BTCUSDT')]);
    const hedge = c.find(x => x.code === 'SPOT_FUTURES_HEDGE');
    assert(!!hedge, '헤지를 못 알아봤다');
    eq(hedge!.severity, 'info', '정상적인 헤지 전략을 막으면 안 된다');
  });

  console.log('[전략 장부 — 충돌 정책]');

  const opp = detectConflicts([intent('A', 0.02), intent('B', -0.03)])
    .find(x => x.code === 'OPPOSITE_DIRECTION')!;

  test('BLOCK은 둘 다 보류한다', () => {
    const r = resolveConflict(opp, 'BLOCK');
    eq(r.proceed.length, 0);
    eq(r.blocked.length, 2);
  });

  test('PRIORITY는 우선순위가 높은 하나만 실행한다', () => {
    const r = resolveConflict(opp, 'PRIORITY', ['B', 'A']);
    eq(r.proceed.join(''), 'B');
    eq(r.blocked.join(''), 'A');
  });

  test('우선순위가 없으면 PRIORITY도 보류한다', () => {
    const r = resolveConflict(opp, 'PRIORITY', []);
    eq(r.proceed.length, 0, '우선순위가 없는데 임의로 하나를 골랐다');
  });

  test('ISOLATE는 Hedge 모드 확인 전까지 보류한다', () => {
    const r = resolveConflict(opp, 'ISOLATE');
    eq(r.proceed.length, 0);
    assert(r.reason.includes('Hedge'), r.reason);
  });

  test('ALLOW는 진행하되 그것이 기본값은 아니다', () => {
    eq(resolveConflict(opp, 'ALLOW').proceed.length, 2);
  });

  console.log('[전략 장부 — 소유권 표식]');

  test('signal_id에 소유 전략을 새기고 다시 읽는다', () => {
    const t = tagStrategy('[SPOT]daily-2026-07-28', 'ladder-btc');
    eq(strategyOf({ signal_id: t }), 'ladder-btc');
    // 시장 표식과 서로 독립이라 둘 다 살아 있어야 한다
    assert(t.includes('[SPOT]'), '시장 표식이 지워졌다: ' + t);
  });

  test('표식을 두 번 붙이지 않는다', () => {
    const once = tagStrategy('x', 'A');
    eq(strategyOf({ signal_id: tagStrategy(once, 'B') }), 'B');
  });

  test('컬럼이 있으면 컬럼을 우선한다', () => {
    eq(strategyOf({ strategy_id: 'A', signal_id: '[s:B]x' }), 'A');
  });

  test('주인을 모르면 null — 아무 전략에나 붙이지 않는다', () => {
    eq(strategyOf({ signal_id: 'plain' }), null);
    eq(strategyOf({}), null);
    eq(strategyOf({ strategy_id: '  ' }), null);
  });
}
