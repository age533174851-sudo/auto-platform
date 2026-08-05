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

  console.log('[포지션 카드 — 방향을 어디서 읽는가]');

  test('Gate처럼 수량이 절대값으로 와도 side 필드가 있으면 숏이다', () => {
    // 실제로 났던 사고다. Gate 라우트가 `Math.abs()`로 수량을 실어 보냈고,
    // 이 함수는 부호에서 방향을 뽑았다 — 그래서 **모든 Gate 숏이 롱으로**
    // 표시됐다. 그리고 방향이 뒤집히자 손절 조회가 반대편을 뒤져
    // "손절 없음"이 됐고, 청산가 경고문도 반대로 계산됐다.
    const v = derivePosition({
      symbol: 'BTCUSDT', side: 'SHORT', amount: 0.9748,
      entryPrice: 64071.1, liquidationPrice: 76579.2,
    });
    eq(v.side, 'SHORT');
    eq(v.sideKnown, true);
    eq(v.sideSource, 'field');
    eq(v.sideConflict, null, '청산가가 진입가 위이므로 숏과 일치한다');
    eq(closeSideFor(v.side), 'BUY', '숏은 사서 닫는다');
  });

  test('side 필드가 없으면 예전처럼 부호로 판정한다', () => {
    eq(derivePosition({ amount: 1.5 }).sideSource, 'sign');
    eq(derivePosition({ amount: -1.5 }).side, 'SHORT');
    eq(derivePosition({ amount: -1.5 }).sideKnown, true);
  });

  test('수량 0이고 방향 필드도 없으면 방향을 모른다', () => {
    const v = derivePosition({ amount: 0 });
    eq(v.sideKnown, false, '모르는 것을 안다고 하지 않는다');
    eq(v.sideSource, 'none');
  });

  test('FLAT·BOTH는 방향이 아니다', () => {
    eq(derivePosition({ side: 'FLAT', amount: 0 }).sideKnown, false);
    eq(derivePosition({ positionSide: 'BOTH', amount: 0 }).sideKnown, false);
  });

  test('양수는 진술이 아니다 — 필드가 SHORT면 SHORT다', () => {
    // 어떤 어댑터는 수량을 절대값으로 보낸다. 그때 양수는 '롱이다'가 아니라
    // '부호가 지워졌다'이다. 이걸 모순으로 세면 그런 거래소의 모든 숏
    // 포지션에서 청산 버튼이 막힌다 — 못 닫는 것은 사고다.
    const v = derivePosition({ side: 'SHORT', amount: 1.5 });
    eq(v.side, 'SHORT');
    eq(v.sideKnown, true);
    eq(v.sideConflict, null);
  });

  test('음수는 진술이다 — LONG인데 음수면 진짜 모순이다', () => {
    // 롱에 -0.97을 보내는 거래소는 없다. 이건 어느 한쪽이 확실히 틀렸다.
    const v = derivePosition({ side: 'LONG', amount: -1.5 });
    eq(v.sideKnown, false);
    assert(v.sideConflict != null, '어긋난 사실을 들고 나간다');
  });

  test('청산가가 방향과 반대 모양이면 어긋남으로 잡는다', () => {
    // 숏인데 청산가가 진입가 아래 — 롱의 모양이다. 둘 중 하나는 틀렸고,
    // 어느 쪽인지 모르는 채로 청산 버튼을 누르게 두면 안 된다.
    const v = derivePosition({
      side: 'SHORT', amount: -1, entryPrice: 64000, liquidationPrice: 50000,
    });
    eq(v.sideKnown, false);
    assert(String(v.sideConflict).includes('LONG'));
  });

  test('교차마진의 청산가 0은 어긋남이 아니다', () => {
    // 교차는 청산가를 0/없음으로 준다. 그걸 모순으로 세면 교차 포지션마다
    // 가짜 경고가 뜨고, 곧 아무도 경고를 안 읽는다.
    const v = derivePosition({
      side: 'LONG', amount: 1, entryPrice: 64000, liquidationPrice: 0,
    });
    eq(v.sideConflict, null);
    eq(v.sideKnown, true);
  });
}
