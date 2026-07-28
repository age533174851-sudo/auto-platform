// src/lib/markets/coinM.test.ts
//
// 막으려는 사고:
//  1. 수량을 코인 개수로 착각하는 것 — 0.5를 넣고 0.5 BTC를 기대하는데
//     실제로는 0.5계약(50 USD)이거나 거부된다
//  2. 계약 크기를 추측하는 것 — BTC(100)와 알트(10)가 10배 다르다
//  3. USDT-M 공식으로 역방향 손익·청산가를 계산하는 것
import { test, assert, eq } from '../../test/harness';
import {
  isCoinMSymbol, baseAssetOf, isPerpetual, resolveContractSize,
  notionalToContracts, contractsToCoin, requiredMarginCoin,
  inversePnlCoin, inverseLiquidationPrice, checkCoinMIntent,
} from './coinM';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

export function runCoinMTests() {
  console.log('[COIN-M — 심볼 구분]');

  test('USDT-M 심볼을 COIN-M으로 받지 않는다', () => {
    eq(isCoinMSymbol('BTCUSDT'), false, 'BTCUSDT는 USDⓈ-M이다 — 섞이면 다른 시장에 주문이 나간다');
    eq(isCoinMSymbol('BTCUSD_PERP'), true);
    eq(isCoinMSymbol('ETHUSD_240628'), true);
    eq(isCoinMSymbol(''), false);
    eq(isCoinMSymbol('BTCUSD'), false);
  });

  test('기초자산과 만기 구분', () => {
    eq(baseAssetOf('BTCUSD_PERP'), 'BTC');
    eq(baseAssetOf('ETHUSD_240628'), 'ETH');
    eq(baseAssetOf('BTCUSDT'), null);
    eq(isPerpetual('BTCUSD_PERP'), true);
    eq(isPerpetual('BTCUSD_240628'), false, '분기물은 만기가 있어 취급이 다르다');
  });

  console.log('[COIN-M — 계약 크기를 추측하지 않는다]');

  test('거래소가 준 값을 최우선으로 쓴다', () => {
    const r = resolveContractSize('ETHUSD_PERP', 10);
    eq(r!.contractUsd, 10);
    eq(r!.source, 'exchange');
    // 아는 값이 있어도 거래소 값이 이긴다
    eq(resolveContractSize('BTCUSD_PERP', 50)!.contractUsd, 50);
  });

  test('BTC는 100 USD 계약이다', () => {
    const r = resolveContractSize('BTCUSD_PERP');
    eq(r!.contractUsd, 100);
    eq(r!.source, 'known');
  });

  test('모르는 심볼은 null — 흔한 값으로 추측하지 않는다', () => {
    eq(resolveContractSize('XYZUSD_PERP'), null,
      '알트를 10으로 추측했다가 BTC였으면 10배 틀린 주문이 나간다');
    eq(resolveContractSize('BTCUSDT'), null);
  });

  console.log('[COIN-M — 수량은 계약이다]');

  test('명목가를 계약으로 바꿀 때 항상 내림한다', () => {
    // 250 USD / 100 = 2.5 → 2계약(200 USD)
    const r = notionalToContracts(250, 100);
    eq(r.ok, true);
    eq(r.contracts, 2, '올림하면 의도보다 큰 포지션이 열린다');
    eq(r.actualNotionalUsd, 200);
    eq(r.shortfallUsd, 50);
  });

  test('한 계약도 못 사면 막고 이유를 말한다', () => {
    const r = notionalToContracts(50, 100);
    eq(r.ok, false);
    eq(r.contracts, 0);
    assert(r.reason!.includes('1계약'), r.reason);
  });

  test('계약 크기를 모르면 변환하지 않는다', () => {
    eq(notionalToContracts(1000, 0).ok, false);
    eq(notionalToContracts(1000, NaN).ok, false);
  });

  test('계약 수는 정수여야 한다', () => {
    const r = checkCoinMIntent({ symbol: 'BTCUSD_PERP', side: 'BUY', contracts: 0.5, leverage: 5 });
    eq(r.ok, false, '0.5를 "0.5 BTC"로 착각한 주문이 그대로 나갔다');
    eq(r.code, 'fractional_contracts');
    assert(r.reason!.includes('코인이 아니라 계약'), r.reason);
  });

  test('USDT-M 심볼로 COIN-M 주문을 낼 수 없다', () => {
    const r = checkCoinMIntent({ symbol: 'BTCUSDT', side: 'BUY', contracts: 1, leverage: 5 });
    eq(r.ok, false);
    eq(r.code, 'not_coinm');
    assert(r.reason!.includes('USDⓈ-M'), r.reason);
  });

  test('정상 의도는 통과한다', () => {
    eq(checkCoinMIntent({ symbol: 'BTCUSD_PERP', side: 'BUY', contracts: 3, leverage: 10 }).ok, true);
  });

  test('레버리지 범위를 벗어나면 막는다', () => {
    for (const lev of [0, -1, 200, NaN]) {
      eq(checkCoinMIntent({ symbol: 'BTCUSD_PERP', side: 'BUY', contracts: 1, leverage: lev }).ok,
        false, String(lev));
    }
  });

  console.log('[COIN-M — 증거금은 코인 단위다]');

  test('계약을 코인 수량으로 바꾼다', () => {
    // 2계약 × 100 USD = 200 USD, 가격 50,000 → 0.004 BTC
    assert(near(contractsToCoin(2, 100, 50_000)!, 0.004), String(contractsToCoin(2, 100, 50_000)));
  });

  test('필요 증거금이 코인으로 나온다', () => {
    // 0.004 BTC / 10배 = 0.0004 BTC
    const r = requiredMarginCoin(2, 100, 50_000, 10);
    eq(r.ok, true);
    assert(near(r.marginCoin, 0.0004), String(r.marginCoin));
    // USD 환산은 참고용이다
    assert(near(r.marginUsdApprox, 20), String(r.marginUsdApprox));
  });

  test('가격이나 레버리지를 모르면 증거금을 내지 않는다', () => {
    eq(requiredMarginCoin(2, 100, 0, 10).ok, false);
    eq(requiredMarginCoin(2, 100, 50_000, 0).ok, false);
  });

  console.log('[COIN-M — 역방향 손익]');

  test('역방향 손익은 선형이 아니다', () => {
    // 1계약(100 USD), 50,000 → 100,000 (2배)
    // 코인 손익 = 100 × (1/50000 − 1/100000) = 100 × 0.00001 = 0.001 BTC
    const pnl = inversePnlCoin(1, 100, 50_000, 100_000, 'LONG')!;
    assert(near(pnl, 0.001), String(pnl));

    // 선형(USDT-M)이라면 100 USD 포지션이 2배 → 100 USD 이익 = 0.001 BTC @ 100k.
    // 값은 우연히 같아 보이지만 방향이 다르면 확실히 갈린다:
    const down = inversePnlCoin(1, 100, 100_000, 50_000, 'LONG')!;
    assert(near(down, -0.001), `하락 시 손실이 대칭이 아니다: ${down}`);
    // 실제로 -50%일 때 코인 손실(0.001)이 +100%일 때 이익(0.001)과 같다 —
    // 이것이 역방향의 특징이다. 선형으로 계산하면 다른 값이 나온다.
  });

  test('숏은 부호가 반대다', () => {
    const long = inversePnlCoin(1, 100, 50_000, 60_000, 'LONG')!;
    const short = inversePnlCoin(1, 100, 50_000, 60_000, 'SHORT')!;
    assert(near(long, -short), `${long} vs ${short}`);
    assert(long > 0, '롱인데 상승에서 손실이 났다');
  });

  test('값이 이상하면 계산하지 않는다', () => {
    eq(inversePnlCoin(1, 100, 0, 60_000, 'LONG'), null);
    eq(inversePnlCoin(1, 100, 50_000, -1, 'LONG'), null);
  });

  console.log('[COIN-M — 청산가]');

  test('롱 청산가는 진입가보다 낮다', () => {
    const liq = inverseLiquidationPrice(50_000, 10, 'LONG')!;
    assert(liq < 50_000, `롱 청산가가 진입가보다 높다: ${liq}`);
    assert(liq > 40_000, `10배인데 청산가가 너무 멀다: ${liq}`);
  });

  test('숏 청산가는 진입가보다 높다', () => {
    const liq = inverseLiquidationPrice(50_000, 10, 'SHORT')!;
    assert(liq > 50_000, `숏 청산가가 진입가보다 낮다: ${liq}`);
  });

  test('배율이 높을수록 청산가가 가까워진다', () => {
    const l5 = inverseLiquidationPrice(50_000, 5, 'LONG')!;
    const l50 = inverseLiquidationPrice(50_000, 50, 'LONG')!;
    assert(l50 > l5, '50배 청산가가 5배보다 멀다');
  });

  test('값이 이상하면 청산가를 내지 않는다', () => {
    eq(inverseLiquidationPrice(0, 10, 'LONG'), null);
    eq(inverseLiquidationPrice(50_000, 0, 'LONG'), null);
  });
}
