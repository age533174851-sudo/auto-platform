// src/lib/fees/marketType.test.ts
//
// **선물 포지션의 비용을 현물 요율로 계산하고 있었다.**
//
// 이 저장소에는 `fees`라는 이름의 모듈이 둘이다:
//
//   src/lib/fees.ts        getDefaultConfig(exchangeId)              — 현물만
//   src/lib/fees/index.ts  getDefaultConfig(exchange, marketType)    — 시장 유형을 안다
//
// `backtest/index.ts`와 `safety/index.ts`는 이렇게 불렀다:
//
//     getDefaultConfig(exchange, 'futures')
//
// 그런데 `from '../fees'`로 앞엣것을 부르고 있었다. **두 번째 인자가
// 그냥 버려지고 현물 요율이 돌아왔다.** 바이낸스 기준 taker가
// 0.1% 대 0.05% — **2배다.**
//
// 백테스트는 비용을 두 배로 잡아 **될 전략을 안 되는 것으로** 만들고,
// 안전 점검은 왕복 비용을 두 배로 본다.
//
// "경로가 둘인데 한쪽만 고침"의 변형이다 — 이름이 둘인데 한쪽만 부른 것.
import { test, eq, assert } from '../../test/harness';
import { getDefaultConfig, calcFeeRate, calcFeeAmount } from './index';

export function runFeeMarketTypeTests() {
  console.log('[수수료 — 선물과 현물은 다른 요율이다]');

  test('선물 요율이 현물보다 싸다 (바이낸스)', () => {
    const spot = calcFeeRate(getDefaultConfig('binance', 'spot'), 'taker');
    const fut  = calcFeeRate(getDefaultConfig('binance', 'futures'), 'taker');
    assert(fut < spot, `선물(${fut})이 현물(${spot})보다 싸야 한다`);
  });

  test('시장 유형을 안 주면 현물이다 — 조용히 선물이 되지 않는다', () => {
    eq(getDefaultConfig('binance').marketType, 'spot');
  });

  test('시장 유형이 실제로 요율을 바꾼다', () => {
    // 이 값이 같으면 인자가 버려지고 있다는 뜻이다.
    const a = calcFeeAmount(1_000_000, getDefaultConfig('binance', 'spot'), 'taker');
    const b = calcFeeAmount(1_000_000, getDefaultConfig('binance', 'futures'), 'taker');
    assert(a !== b, `현물 ${a} · 선물 ${b} — 시장 유형이 무시되고 있다`);
  });

  test('선물 요율을 현물로 계산하면 두 배 가까이 틀린다', () => {
    const spot = calcFeeRate(getDefaultConfig('binance', 'spot'), 'taker');
    const fut  = calcFeeRate(getDefaultConfig('binance', 'futures'), 'taker');
    // 정확한 배수를 못 박지는 않는다 — 거래소가 요율을 바꾼다.
    // 다만 **같은 값이면 안 된다**는 것은 못 박는다.
    assert(spot / fut >= 1.5, `차이가 ${(spot / fut).toFixed(2)}배뿐이다 — 요율표를 확인하라`);
  });

  test('maker와 taker가 다르다', () => {
    const c = getDefaultConfig('binance', 'futures');
    assert(calcFeeRate(c, 'maker') < calcFeeRate(c, 'taker'));
  });

  test('모르는 거래소도 0으로 두지 않는다', () => {
    // 수수료 0은 '무료'라는 뜻이고, 그걸로 계산한 기대값은 언제나 낙관적이다.
    const r = calcFeeRate(getDefaultConfig('custom' as any, 'futures'), 'taker');
    assert(r > 0, `수수료가 ${r}이다 — 0으로 두면 기대값이 언제나 낙관적이 된다`);
  });
}
