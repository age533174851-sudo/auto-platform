// src/lib/strategies/spotOrderPlan.test.ts
//
// 막으려는 것:
//  1. 앱에만 있는 보호를 거래소 보호처럼 보여주는 것
//  2. 분할매도 합계가 보유를 넘어 뒷부분이 조용히 거부되는 것
//  3. 방향이 뒤집힌 TP/SL이 걸려서 "보호했다"고 믿게 되는 것
//  4. 트레일링 손절선이 내려가서 하락장에서 영원히 안 팔리는 것
import { test, assert, eq } from '../../test/harness';
import {
  planSplit, planBracket, updateTrailing, startTrailing,
  checkReserved, checkRepeat, summarizeGuards, validateWatchSpec,
} from './spotOrderPlan';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

export function runSpotOrderPlanTests() {
  console.log('[현물 주문 — 보호가 어디에 있는가]');

  test('트레일링은 항상 앱 보호다', () => {
    const u = updateTrailing(startTrailing(100, 5), 110);
    eq(u.guardedBy, 'APP', '서버가 멈추면 값이 멈추는데 거래소 보호로 표시됐다');
  });

  test('예약 주문도 앱 보호다', () => {
    eq(checkReserved({ side: 'BUY', triggerPrice: 90, direction: 'below', amount: 100 }, 95).guardedBy, 'APP');
  });

  test('지정가 분할·TP/SL은 거래소 보호다', () => {
    const s = planSplit({ side: 'BUY', total: 300, tranches: 3, fromPrice: 100, toPrice: 90 });
    assert(s.orders.every(o => o.guardedBy === 'EXCHANGE'), '지정가인데 앱 보호로 표시됐다');
    const b = planBracket({ heldQty: 1, avgPrice: 100, takeProfit: 120, stopLoss: 90 });
    assert(b.orders.every(o => o.guardedBy === 'EXCHANGE'));
  });

  test('앱 보호가 하나라도 있으면 경고를 만든다', () => {
    const mixed = summarizeGuards([{ guardedBy: 'EXCHANGE' }, { guardedBy: 'APP' }]);
    eq(mixed.app, 1);
    assert(mixed.warning!.includes('서버가 멈추면'), mixed.warning!);
    // 전부 거래소면 경고가 없다 — 없는 위험을 만들지 않는다
    eq(summarizeGuards([{ guardedBy: 'EXCHANGE' }]).warning, null);
  });

  console.log('[현물 주문 — 분할]');

  test('분할 합계가 총액과 정확히 같다', () => {
    const r = planSplit({ side: 'BUY', total: 1000, tranches: 3, fromPrice: 100, toPrice: 90 });
    eq(r.ok, true);
    const sum = r.orders.reduce((s, o) => s + (o.quoteUsd ?? 0), 0);
    assert(near(sum, 1000), `반올림으로 총액이 달라졌다: ${sum}`);
  });

  test('분할 가격이 구간을 균등하게 채운다', () => {
    const r = planSplit({ side: 'BUY', total: 300, tranches: 3, fromPrice: 100, toPrice: 90 });
    eq(r.orders.map(o => o.price!.toFixed(0)).join(','), '100,95,90');
  });

  test('1분할이면 시작가 하나만', () => {
    const r = planSplit({ side: 'BUY', total: 100, tranches: 1, fromPrice: 100, toPrice: 90 });
    eq(r.orders.length, 1);
    eq(r.orders[0].price, 100);
  });

  test('분할매도 합계가 보유를 넘으면 아예 계획하지 않는다', () => {
    const r = planSplit({
      side: 'SELL', total: 2, tranches: 4, fromPrice: 100, toPrice: 110, heldQty: 1,
    });
    eq(r.ok, false, '앞의 주문이 체결된 뒤 뒤가 잔량 부족으로 거부된다');
    assert(r.warnings[0].includes('공매도'), r.warnings[0]);
  });

  test('보유를 모르면 분할매도를 계획하지 않는다', () => {
    const r = planSplit({ side: 'SELL', total: 1, tranches: 2, fromPrice: 100, toPrice: 110 });
    eq(r.ok, false);
  });

  test('분할매도 합계가 보유와 정확히 같다', () => {
    const r = planSplit({
      side: 'SELL', total: 0.3, tranches: 3, fromPrice: 100, toPrice: 110, heldQty: 0.3,
    });
    eq(r.ok, true);
    const sum = r.orders.reduce((s, o) => s + (o.qty ?? 0), 0);
    assert(near(sum, 0.3), `먼지 잔량이 남으면 최소 주문 미달로 영영 못 판다: ${sum}`);
  });

  test('1회 주문이 최소 금액에 미달하면 막는다', () => {
    const r = planSplit({
      side: 'BUY', total: 30, tranches: 10, fromPrice: 100, toPrice: 90, minNotionalUsd: 10,
    });
    eq(r.ok, false);
    assert(r.warnings[0].includes('최소 주문'), r.warnings[0]);
  });

  test('이상한 입력은 거부한다', () => {
    eq(planSplit({ side: 'BUY', total: 0, tranches: 3, fromPrice: 100, toPrice: 90 }).ok, false);
    eq(planSplit({ side: 'BUY', total: 100, tranches: 0, fromPrice: 100, toPrice: 90 }).ok, false);
    eq(planSplit({ side: 'BUY', total: 100, tranches: 999, fromPrice: 100, toPrice: 90 }).ok, false);
    eq(planSplit({ side: 'BUY', total: 100, tranches: 3, fromPrice: 0, toPrice: 90 }).ok, false);
  });

  console.log('[현물 주문 — TP · SL]');

  test('익절가가 평균가 이하면 막는다', () => {
    const r = planBracket({ heldQty: 1, avgPrice: 100, takeProfit: 90 });
    eq(r.ok, false, '손실 확정 주문이 익절로 걸렸다');
  });

  test('손절가가 평균가 이상이면 막는다', () => {
    const r = planBracket({ heldQty: 1, avgPrice: 100, stopLoss: 110 });
    eq(r.ok, false, '즉시 체결될 주문이 손절로 걸렸다');
  });

  test('손절이 익절보다 높으면 막는다', () => {
    eq(planBracket({ heldQty: 1, avgPrice: 100, takeProfit: 105, stopLoss: 108 }).ok, false);
  });

  test('정상 방향이면 두 건을 만든다', () => {
    const r = planBracket({ heldQty: 2, avgPrice: 100, takeProfit: 130, stopLoss: 90 });
    eq(r.ok, true);
    eq(r.orders.length, 2);
    assert(r.orders.every(o => o.side === 'SELL'), '현물 TP/SL은 매도 주문이다');
    assert(r.orders.every(o => o.qty === 2));
  });

  test('둘 다 걸면 자동 해제되지 않는다고 경고한다', () => {
    const r = planBracket({ heldQty: 1, avgPrice: 100, takeProfit: 130, stopLoss: 90 });
    assert(r.warnings.some(w => w.includes('취소')), r.warnings.join(' '));
  });

  test('일부만 보호하면 나머지가 무방비라고 알린다', () => {
    const r = planBracket({ heldQty: 1, avgPrice: 100, stopLoss: 90, coverPct: 50 });
    eq(r.orders[0].qty, 0.5);
    assert(r.warnings.some(w => w.includes('보호되지 않습니다')), r.warnings.join(' '));
  });

  test('보유·평균가가 없으면 걸지 않는다', () => {
    eq(planBracket({ heldQty: 0, avgPrice: 100, stopLoss: 90 }).ok, false);
    eq(planBracket({ heldQty: 1, avgPrice: 0, stopLoss: 90 }).ok, false);
    eq(planBracket({ heldQty: 1, avgPrice: 100 }).ok, false, '둘 다 비었는데 통과했다');
  });

  console.log('[현물 주문 — 트레일링]');

  test('손절선은 올라가기만 한다', () => {
    let s = startTrailing(100, 10);        // 손절 90
    s = updateTrailing(s, 120).state;      // 최고 120 → 손절 108
    assert(near(s.stopPrice, 108), String(s.stopPrice));
    s = updateTrailing(s, 110).state;      // 내려왔지만 손절은 그대로
    assert(near(s.stopPrice, 108), `손절선이 내려갔다: ${s.stopPrice}`);
    s = updateTrailing(s, 100).state;
    assert(near(s.stopPrice, 108), '하락장에서 손절선이 따라 내려가면 영원히 안 팔린다');
  });

  test('손절선에 닿으면 발동한다', () => {
    let s = startTrailing(100, 10);
    s = updateTrailing(s, 120).state;
    const u = updateTrailing(s, 107);
    eq(u.triggered, true);
    assert(u.note.includes('매도'), u.note);
  });

  test('가격을 모르면 발동하지 않는다', () => {
    const s = startTrailing(100, 10);
    for (const bad of [NaN, 0, -1]) {
      const u = updateTrailing(s, bad);
      eq(u.triggered, false, `조회 실패 한 번에 보유분이 팔린다 (${bad})`);
      eq(u.moved, false);
    }
  });

  test('비율이 이상하면 갱신하지 않는다', () => {
    for (const pct of [0, -5, 100, 150, NaN]) {
      const u = updateTrailing({ highWater: 100, stopPrice: 90, trailPct: pct }, 200);
      eq(u.moved, false, String(pct));
    }
  });

  test('최고가를 안 넘으면 손절선이 그대로다', () => {
    const s = startTrailing(100, 10);
    const u = updateTrailing(s, 95);
    eq(u.moved, false);
    assert(near(u.state.stopPrice, 90));
  });

  console.log('[현물 주문 — 예약]');

  test('아래로 내려오면 발동하는 예약매수', () => {
    const spec = { side: 'BUY' as const, triggerPrice: 90, direction: 'below' as const, amount: 100 };
    eq(checkReserved(spec, 95).triggered, false);
    eq(checkReserved(spec, 90).triggered, true, '기준가 정확히 도달인데 발동 안 했다');
    eq(checkReserved(spec, 85).triggered, true);
  });

  test('위로 뚫으면 발동하는 예약매도', () => {
    const spec = {
      side: 'SELL' as const, triggerPrice: 120, direction: 'above' as const,
      amount: 0.5, heldQty: 1,
    };
    eq(checkReserved(spec, 119).triggered, false);
    eq(checkReserved(spec, 121).triggered, true);
  });

  test('보유보다 많은 예약매도는 발동하지 않는다', () => {
    const r = checkReserved({
      side: 'SELL', triggerPrice: 100, direction: 'above', amount: 5, heldQty: 1,
    }, 200);
    eq(r.triggered, false, '없는 물량을 파는 예약이 발동했다');
  });

  test('보유를 모르면 예약매도를 발동하지 않는다', () => {
    const r = checkReserved({ side: 'SELL', triggerPrice: 100, direction: 'above', amount: 1 }, 200);
    eq(r.triggered, false);
  });

  test('가격을 모르면 판단하지 않는다', () => {
    eq(checkReserved({ side: 'BUY', triggerPrice: 90, direction: 'below', amount: 100 }, null)
      .triggered, false);
  });

  console.log('[현물 주문 — 반복]');

  test('횟수를 다 쓰면 멈춘다', () => {
    const r = checkRepeat({ everyDays: 7, maxCount: 10, doneCount: 10, lastAt: null }, NOW);
    eq(r.due, false, '"10회 반복"이 무한 적립이 됐다');
    eq(r.remaining, 0);
  });

  test('첫 실행은 바로 된다', () => {
    eq(checkRepeat({ everyDays: 7, maxCount: 10, doneCount: 0, lastAt: null }, NOW).due, true);
  });

  test('주기 안이면 기다린다', () => {
    const r = checkRepeat({ everyDays: 7, maxCount: 10, doneCount: 1, lastAt: NOW - 3 * DAY }, NOW);
    eq(r.due, false);
    assert(r.reason.includes('4일'), r.reason);
  });

  test('주기가 지나면 실행한다', () => {
    eq(checkRepeat({ everyDays: 7, maxCount: 10, doneCount: 1, lastAt: NOW - 8 * DAY }, NOW).due, true);
  });

  test('주기가 이상하면 실행하지 않는다', () => {
    eq(checkRepeat({ everyDays: 0, maxCount: 10, doneCount: 0, lastAt: NOW }, NOW).due, false);
  });
  console.log('[현물 주문 — 감시 등록 검증]');

  test('트레일링 매수는 막는다', () => {
    const r = validateWatchSpec({ kind: 'TRAILING', side: 'BUY', quoteUsd: 100, entryPrice: 100, trailPct: 5 });
    eq(r.ok, false, '"떨어지면 산다"인지 "오르면 산다"인지 사람마다 다르게 읽는다');
    eq(r.code, 'sell_only');
  });

  test('트레일링 비율은 0~100 사이여야 한다', () => {
    for (const pct of [0, -5, 100, 150, NaN]) {
      const r = validateWatchSpec({ kind: 'TRAILING', side: 'SELL', qty: 1, entryPrice: 100, trailPct: pct });
      eq(r.ok, false, String(pct));
    }
    eq(validateWatchSpec({ kind: 'TRAILING', side: 'SELL', qty: 1, entryPrice: 100, trailPct: 5 }).ok, true);
  });

  test('시작가가 없으면 트레일링을 걸 수 없다', () => {
    eq(validateWatchSpec({ kind: 'TRAILING', side: 'SELL', qty: 1, trailPct: 5 }).ok, false);
  });

  test('수량도 금액도 없으면 막는다', () => {
    eq(validateWatchSpec({ kind: 'TRAILING', side: 'SELL', entryPrice: 100, trailPct: 5 }).ok, false);
    eq(validateWatchSpec({ kind: 'RESERVED', side: 'BUY', triggerPrice: 100, direction: 'below' }).ok, false);
  });

  test('매도 감시는 금액이 아니라 수량으로 건다', () => {
    const r = validateWatchSpec({ kind: 'RESERVED', side: 'SELL', quoteUsd: 100, triggerPrice: 120, direction: 'above' });
    eq(r.ok, false, '발동 시점에 수량을 되계산하면 보유를 넘길 수 있다');
    eq(r.code, 'sell_needs_qty');
  });

  test('예약은 기준가와 방향이 모두 필요하다', () => {
    eq(validateWatchSpec({ kind: 'RESERVED', side: 'BUY', quoteUsd: 100, triggerPrice: 0, direction: 'below' }).ok, false);
    eq(validateWatchSpec({ kind: 'RESERVED', side: 'BUY', quoteUsd: 100, triggerPrice: 100 }).ok, false);
    eq(validateWatchSpec({ kind: 'RESERVED', side: 'BUY', quoteUsd: 100, triggerPrice: 100, direction: 'below' }).ok, true);
  });
}
