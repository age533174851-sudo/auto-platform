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

  // ── 현물 ────────────────────────────────────────────────
  //
  // 현물은 선물의 특수한 경우가 아니다. 배율이 없고, 청산이 없고, 손절이
  // 없다. 실전 현물 라우트가 stopLossPct·leverage를 아예 거부하므로
  // 모의만 손절을 요구하면 규칙이 실전과 달라진다.
  console.log('[모의 현물 — 규칙이 실전과 같아야 한다]');

  const spotBase = {
    symbol: 'BTCUSDT', side: 'LONG' as const, quantity: 0.01, leverage: 1,
    markPrice: 60000, availableBalance: 1000, market: 'SPOT' as const,
  };

  test('현물은 손절 없이도 통과한다 — 실전 현물이 손절을 안 받기 때문이다', () => {
    const r = buildPaperPlan(spotBase);
    eq(r.ok, true, r.reason);
  });

  test('선물은 손절이 없으면 여전히 거부한다', () => {
    const r = buildPaperPlan({ ...base, stopPrice: null });
    eq(r.ok, false);
    assert(r.reason.includes('손절'), r.reason);
  });

  test('현물에는 청산가가 없다 — 0이 아니라 null이다', () => {
    // 0으로 두면 화면이 "청산가 0"을 그리고, 그건 "곧 청산된다"로 읽힌다.
    const r = buildPaperPlan(spotBase);
    eq(r.liquidationPrice, null);
    eq(r.plan?.liquidationPrice, 0);   // PositionPlan은 number라 0으로 내려간다
  });

  test('현물 증거금은 산 금액 전부다 — 배율로 나누지 않는다', () => {
    const r = buildPaperPlan(spotBase);
    eq(r.notional, 600);
    eq(r.requiredMargin, 600);
  });

  test('현물에 배율을 주면 조용히 1로 바꾸지 않고 거부한다', () => {
    // 화면이 3배를 보여주는데 장부에 1배로 적히면 둘이 갈린다.
    const r = buildPaperPlan({ ...spotBase, leverage: 3 });
    eq(r.ok, false);
    assert(r.reason.includes('배율'), r.reason);
  });

  test('현물은 숏으로 못 연다 — 매도는 보유분 청산이다', () => {
    const r = buildPaperPlan({ ...spotBase, side: 'SHORT' as any });
    eq(r.ok, false);
    assert(r.reason.includes('숏'), r.reason);
  });

  test('현물도 잔고를 넘으면 거부한다', () => {
    const r = buildPaperPlan({ ...spotBase, availableBalance: 100 });
    eq(r.ok, false);
    assert(r.reason.includes('잔고'), r.reason);
  });

  test('손절 없는 현물의 위험은 0이 아니라 산 금액 전부다', () => {
    // 0으로 적으면 "위험 0"이 되어 위험 없는 거래처럼 보인다.
    const r = buildPaperPlan(spotBase);
    eq(r.plan?.riskAmount, 600);
  });

  test('현물에 손절을 붙이면 방향은 여전히 검사한다', () => {
    const r = buildPaperPlan({ ...spotBase, stopPrice: 61000 });
    eq(r.ok, false, '롱인데 손절이 위에 있으면 즉시 발동한다');
  });
}
