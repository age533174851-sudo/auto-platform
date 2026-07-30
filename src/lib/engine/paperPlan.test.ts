// src/lib/engine/paperPlan.test.ts
//
// 모의라고 검사를 느슨하게 하면 그 연습은 쓸모가 없다.
// 여기서 확인하는 것은 "실전과 같은 규칙인가"다.

import { test, eq, assert } from '../../test/harness';
import { buildPaperPlan, linearLiquidationPrice, PAPER_MAX_LEVERAGE } from './paperPlan';

const base = {
  symbol: 'BTCUSDT', side: 'LONG' as const, quantity: 0.01, leverage: 5,
  markPrice: 60000, stopPrice: 58000, availableBalance: 1000,
};

export function runPaperPlanTests() {
  console.log('[모의 — 청산가 근사]');

  test('롱 청산가는 진입가보다 낮고, 숏은 높다', () => {
    const l = linearLiquidationPrice(60000, 5, 'LONG')!;
    const s = linearLiquidationPrice(60000, 5, 'SHORT')!;
    assert(l < 60000 && s > 60000, `롱 ${l} / 숏 ${s}`);
  });

  test('배율이 높을수록 청산이 가깝다', () => {
    const l5 = linearLiquidationPrice(60000, 5, 'LONG')!;
    const l50 = linearLiquidationPrice(60000, 50, 'LONG')!;
    assert(l50 > l5, '50배 청산가가 5배보다 멀다');
  });

  test('값이 이상하면 null이다 — 0을 돌려주면 청산거리가 100%가 된다', () => {
    eq(linearLiquidationPrice(0, 5, 'LONG'), null);
    eq(linearLiquidationPrice(60000, 0, 'LONG'), null);
    eq(linearLiquidationPrice(NaN, 5, 'LONG'), null);
  });

  console.log('[모의 — 주문 계획]');

  test('정상 주문은 통과하고 계산값이 붙는다', () => {
    const r = buildPaperPlan(base);
    eq(r.ok, true, r.reason);
    eq(r.notional, 600);
    eq(r.requiredMargin, 120);
    assert(r.liquidationPrice != null && r.liquidationPrice < 60000, '청산가가 없다');
    eq(r.plan!.approved, true);
  });

  test('시세를 모르면 주문하지 않는다 — 추측한 가격으로 체결하면 장부가 거짓말을 한다', () => {
    for (const mp of [null, 0, -1, NaN]) {
      const r = buildPaperPlan({ ...base, markPrice: mp as number });
      eq(r.ok, false, `${String(mp)}가 통과했다`);
      assert(r.reason.includes('시세'), r.reason);
    }
  });

  test('수량·배율이 이상하면 거부한다', () => {
    eq(buildPaperPlan({ ...base, quantity: 0 }).ok, false);
    eq(buildPaperPlan({ ...base, quantity: -1 }).ok, false);
    eq(buildPaperPlan({ ...base, leverage: 0 }).ok, false);
    eq(buildPaperPlan({ ...base, leverage: PAPER_MAX_LEVERAGE + 1 }).ok, false);
  });

  test('손절 없는 진입은 모의에서도 받지 않는다', () => {
    const r = buildPaperPlan({ ...base, stopPrice: null });
    eq(r.ok, false);
    assert(r.reason.includes('연습'), `이유를 적어야 한다: ${r.reason}`);
  });

  test('손절 방향이 뒤집히면 거부한다 — 걸자마자 발동한다', () => {
    eq(buildPaperPlan({ ...base, stopPrice: 61000 }).ok, false);
    eq(buildPaperPlan({ ...base, side: 'SHORT', stopPrice: 59000 }).ok, false);
    eq(buildPaperPlan({ ...base, side: 'SHORT', stopPrice: 62000 }).ok, true);
  });

  test('손절이 청산 너머면 거부한다 — 손절이 작동할 기회가 없다', () => {
    // 100배면 청산이 약 1% 거리다. 5% 손절은 그 너머다.
    const r = buildPaperPlan({ ...base, leverage: 100, stopPrice: 57000, availableBalance: 100000 });
    eq(r.ok, false);
    assert(r.reason.includes('청산이 먼저'), `이유: ${r.reason}`);
  });

  console.log('[모의 — 잔고]');

  test('잔고가 모자라면 얼마를 충전해야 하는지 적는다', () => {
    const r = buildPaperPlan({ ...base, availableBalance: 50 });
    eq(r.ok, false);
    assert(r.reason.includes('충전'), `이유: ${r.reason}`);
    assert(/\d/.test(r.reason), '숫자가 없으면 얼마를 넣어야 할지 모른다');
  });

  test('잔고를 모르면 거부한다 — 무시하면 증거금 개념이 사라진다', () => {
    const r = buildPaperPlan({ ...base, availableBalance: null });
    eq(r.ok, false);
    assert(r.reason.includes('잔고'), r.reason);
  });

  test('수수료까지 세고 판단한다 — 증거금만 보면 딱 맞을 때 통과해 버린다', () => {
    const exact = buildPaperPlan({ ...base, availableBalance: 120 });
    eq(exact.ok, false, '수수료를 빼먹었다');
    eq(buildPaperPlan({ ...base, availableBalance: 121 }).ok, true);
  });

  test('거부해도 계산값은 채워 돌려준다 — 화면이 이유와 숫자를 같이 보여줄 수 있게', () => {
    const r = buildPaperPlan({ ...base, availableBalance: 1 });
    eq(r.ok, false);
    eq(r.notional, 600);
    assert(r.liquidationPrice != null, '청산가가 비어 있다');
  });
}
