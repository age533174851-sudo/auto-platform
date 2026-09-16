// src/lib/trading/positionSizing.test.ts
//
// **100배에서 슬라이더의 뜻이 뒤집히는지 여기서 고정한다.**
//
// 1배에서는 "잔고의 50%를 증거금으로"와 "잔고의 50%를 명목가로"가 같은
// 값이다. 그래서 개발 중에는 차이가 안 보인다. 100배에서 100배 차이가 난다.
import { test, eq, assert } from '../../test/harness';
import {
  planSizing, percentFromQuantity, isValidPercent, QUICK_PERCENTS,
} from './positionSizing';

export function runPositionSizingTests() {
  // ── ★ 슬라이더의 뜻 ──
  test('★ 50%는 가용 잔고의 절반을 **증거금**으로 쓴다는 뜻이다', () => {
    const r = planSizing({ availableBalance: 1000, percent: 50, price: 100, leverage: 1 });
    eq(r.code, 'OK');
    eq(r.marginBudget, 500);
    eq(r.notional, 500);        // 1배라 같다
    eq(r.quantity, 5);
  });

  test('★ 100배에서도 50%는 증거금 500이다 — 명목가 500이 아니다', () => {
    const r = planSizing({ availableBalance: 1000, percent: 50, price: 100, leverage: 100 });
    eq(r.marginBudget, 500);    // ← 슬라이더가 정하는 값
    eq(r.notional, 50000);      // ← 레버리지가 곱해진 결과
    eq(r.quantity, 500);
    // 만약 명목가 기준으로 잘못 계산했다면 증거금이 5가 됐을 것이다
    assert(r.marginBudget !== 5, '슬라이더가 명목가 기준으로 계산됐습니다');
  });

  test('★ 100%는 가용 잔고 전부를 증거금으로 쓴다', () => {
    const r = planSizing({ availableBalance: 1000, percent: 100, price: 50, leverage: 100 });
    eq(r.marginBudget, 1000);
    eq(r.notional, 100000);
    // 명목가가 잔고가 되는 해석이었다면 1000이었을 것이다
    assert(r.notional !== 1000, '100%가 명목가=잔고로 계산됐습니다');
  });

  test('배율이 커져도 증거금 예산은 그대로다 — 레버리지는 명목가에만 곱해진다', () => {
    const budgets = [1, 5, 25, 100].map(lev =>
      planSizing({ availableBalance: 800, percent: 25, price: 10, leverage: lev }).marginBudget);
    eq(budgets.join(','), '200,200,200,200');
  });

  test('명목가는 배율에 비례한다', () => {
    const n = [1, 2, 10].map(lev =>
      planSizing({ availableBalance: 100, percent: 100, price: 1, leverage: lev }).notional);
    eq(n.join(','), '100,200,1000');
  });

  // ── 못 읽은 값 ──
  test('★ 가용 잔고를 못 읽으면 0으로 읽지 않는다', () => {
    for (const b of [null, undefined, '', NaN, 'abc']) {
      const r = planSizing({ availableBalance: b as any, percent: 50, price: 100, leverage: 1 });
      eq(r.code, 'BALANCE_UNKNOWN');
      eq(r.marginBudget, null);
      eq(r.quantity, null);
    }
  });

  test('시세를 못 읽으면 수량을 만들지 않는다', () => {
    for (const p of [null, undefined, 0, -1, NaN]) {
      const r = planSizing({ availableBalance: 1000, percent: 50, price: p as any, leverage: 1 });
      eq(r.code, 'PRICE_UNKNOWN');
      eq(r.quantity, null);
    }
  });

  test('배율이 1보다 작거나 없으면 거부한다', () => {
    for (const l of [null, undefined, 0, 0.5, -1, NaN]) {
      eq(planSizing({ availableBalance: 1000, percent: 50, price: 10, leverage: l as any }).code,
         'LEVERAGE_INVALID');
    }
  });

  test('비율이 범위를 벗어나면 조용히 고치지 않고 거부한다', () => {
    for (const p of [-1, 101, 1000, NaN, null, undefined, 'x']) {
      eq(planSizing({ availableBalance: 1000, percent: p as any, price: 10, leverage: 1 }).code,
         'PERCENT_INVALID');
      eq(isValidPercent(p), false);
    }
    for (const p of [0, 25, 50, 100]) eq(isValidPercent(p), true);
  });

  test('0%는 잘못이 아니라 아직 안 고른 것이다', () => {
    const r = planSizing({ availableBalance: 1000, percent: 0, price: 10, leverage: 1 });
    eq(r.code, 'ZERO');
    eq(r.marginBudget, 0);
    eq(r.quantity, 0);
  });

  test('잔고가 0이면 배정할 증거금이 없다 — 오류가 아니다', () => {
    const r = planSizing({ availableBalance: 0, percent: 50, price: 10, leverage: 1 });
    eq(r.code, 'ZERO');
  });

  test('음수 잔고는 모름으로 읽는다', () => {
    eq(planSizing({ availableBalance: -5, percent: 50, price: 10, leverage: 1 }).code,
       'BALANCE_UNKNOWN');
  });

  // ── 역방향 ──
  test('수량에서 비율을 되돌릴 때도 기준은 증거금이다', () => {
    // 잔고 1000 · 100배 · 가격 100 · 수량 500 → 명목가 50,000 → 증거금 500 → 50%
    eq(percentFromQuantity({ quantity: 500, availableBalance: 1000, price: 100, leverage: 100 }), 50);
  });

  test('왕복이 일치한다 (비율 → 수량 → 비율)', () => {
    for (const pct of [0, 25, 50, 75, 100]) {
      const q = planSizing({ availableBalance: 1000, percent: pct, price: 37, leverage: 20 }).quantity;
      const back = percentFromQuantity({ quantity: q, availableBalance: 1000, price: 37, leverage: 20 });
      assert(back != null && Math.abs(back - pct) < 1e-9, `${pct}%에서 왕복이 어긋났습니다 (${back})`);
    }
  });

  test('★ 못 읽으면 슬라이더를 0으로 끌어다 놓지 않는다 (null이다)', () => {
    eq(percentFromQuantity({ quantity: 1, availableBalance: null, price: 10, leverage: 1 }), null);
    eq(percentFromQuantity({ quantity: 1, availableBalance: 0, price: 10, leverage: 1 }), null);
    eq(percentFromQuantity({ quantity: 1, availableBalance: 100, price: 0, leverage: 1 }), null);
    eq(percentFromQuantity({ quantity: null, availableBalance: 100, price: 10, leverage: 1 }), null);
  });

  test('넘치면 100으로 적고 음수는 0으로 적는다 — 슬라이더가 표현할 수 있는 범위다', () => {
    eq(percentFromQuantity({ quantity: 99999, availableBalance: 100, price: 10, leverage: 1 }), 100);
  });

  test('빠른 표시는 25/50/75/100뿐이다', () => {
    eq(QUICK_PERCENTS.join(','), '25,50,75,100');
    for (const p of QUICK_PERCENTS) assert(isValidPercent(p), `${p}가 유효하지 않습니다`);
  });
}
