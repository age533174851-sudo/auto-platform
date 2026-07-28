// src/lib/markets/positionView.test.ts
//
// 막으려는 사고:
//  1. 청산가 0을 '0달러에 청산'으로 그려 즉시 청산 직전처럼 보이는 것
//     — 실제로는 청산가가 없다는 뜻이라 정반대다
//  2. 증거금을 추정해 놓고 거래소가 준 값인 척하는 것
//  3. 분모가 0인데 나눠서 수익률이 ∞%로 나가는 것 — 대박으로 읽힌다
//  4. 값을 못 받았는데 0으로 그려 '손익 0'처럼 보이는 것
import { test, assert, eq } from '../../test/harness';
import { derivePosition, closeSideFor } from './positionView';

const near = (a: number | null, b: number, eps = 1e-6) =>
  a != null && Math.abs(a - b) < eps;

export function runPositionViewTests() {
  console.log('[포지션 카드 — 청산가]');

  test('청산가 0은 없음이지 0원이 아니다', () => {
    const v = derivePosition({ liquidationPrice: 0, amount: 1, entryPrice: 100 });
    eq(v.liq, null, '0을 그대로 두면 즉시 청산 직전처럼 보인다');
  });

  test('청산가가 있으면 그대로', () => {
    eq(derivePosition({ liquidationPrice: 63980.18 }).liq, 63980.18);
  });

  test('청산가를 못 받으면 null', () => {
    eq(derivePosition({}).liq, null);
    eq(derivePosition({ liquidationPrice: 'abc' }).liq, null);
  });

  console.log('[포지션 카드 — 증거금]');

  test('거래소가 준 값을 우선한다', () => {
    const v = derivePosition({ amount: 1, entryPrice: 1000, leverage: 10, isolatedMargin: 111 });
    eq(v.margin, 111);
    eq(v.marginEstimated, false);
  });

  test('없으면 명목가÷배율로 추정하고 추정임을 알린다', () => {
    const v = derivePosition({ amount: 1, entryPrice: 1000, leverage: 10 });
    assert(near(v.margin, 100), String(v.margin));
    eq(v.marginEstimated, true, '추정을 거래소 값인 척하면 안 된다');
  });

  test('배율을 모르면 추정하지 않는다', () => {
    const v = derivePosition({ amount: 1, entryPrice: 1000 });
    eq(v.margin, null);
    eq(v.marginEstimated, false);
  });

  test('거래소가 0을 주면 추정으로 넘어간다', () => {
    const v = derivePosition({ amount: 1, entryPrice: 1000, leverage: 4, isolatedMargin: 0 });
    assert(near(v.margin, 250), String(v.margin));
    eq(v.marginEstimated, true);
  });

  console.log('[포지션 카드 — 수익률]');

  test('수익률은 증거금 대비다', () => {
    const v = derivePosition({ amount: 1, entryPrice: 1000, leverage: 10, unrealizedPnl: 5 });
    assert(near(v.roi, 5), String(v.roi));   // 5 / 100 = 5%
  });

  test('분모가 없으면 계산하지 않는다', () => {
    // ∞%가 화면에 나가면 사용자는 그걸 대박으로 읽는다
    eq(derivePosition({ unrealizedPnl: 5 }).roi, null);
    eq(derivePosition({ amount: 1, entryPrice: 0, leverage: 10, unrealizedPnl: 5 }).roi, null);
  });

  test('손익을 못 받으면 수익률도 없다', () => {
    eq(derivePosition({ amount: 1, entryPrice: 1000, leverage: 10 }).roi, null);
  });

  test('손실도 그대로 나온다', () => {
    const v = derivePosition({ amount: 1, entryPrice: 1000, leverage: 10, unrealizedPnl: -20 });
    assert(near(v.roi, -20), String(v.roi));
  });

  console.log('[포지션 카드 — 나머지]');

  test('손익을 못 받으면 0이 아니라 null', () => {
    eq(derivePosition({ amount: 1 }).pnl, null, '0으로 두면 본전처럼 보인다');
  });

  test('방향과 수량', () => {
    eq(derivePosition({ amount: 2 }).side, 'LONG');
    eq(derivePosition({ amount: -2 }).side, 'SHORT');
    eq(derivePosition({ amount: -2 }).qty, 2);
  });

  test('교차/격리를 구분한다', () => {
    eq(derivePosition({ marginType: 'isolated' }).isolated, true);
    eq(derivePosition({ marginType: 'cross' }).isolated, false);
    eq(derivePosition({}).isolated, false, '모르면 교차로 본다 — 더 위험한 쪽');
  });

  test('바이낸스의 unRealizedProfit 철자도 받는다', () => {
    eq(derivePosition({ unRealizedProfit: 7 }).pnl, 7);
  });

  console.log('[포지션 카드 — 청산 방향]');

  test('롱은 팔아서 닫고 숏은 사서 닫는다', () => {
    // 반대로 잡으면 청산이 아니라 포지션이 두 배가 된다
    eq(closeSideFor('LONG'), 'SELL');
    eq(closeSideFor('SHORT'), 'BUY');
  });

  test('카드가 읽는 방향과 청산 방향이 어긋나지 않는다', () => {
    const long = derivePosition({ amount: 1.5 });
    const short = derivePosition({ amount: -1.5 });
    eq(closeSideFor(long.side), 'SELL');
    eq(closeSideFor(short.side), 'BUY');
  });

  test('명목가는 진입가 기준', () => {
    assert(near(derivePosition({ amount: -3, entryPrice: 100 }).notional, 300));
    eq(derivePosition({ amount: 3 }).notional, null);
  });
}
