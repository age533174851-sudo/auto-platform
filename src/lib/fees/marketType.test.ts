// src/lib/fees/marketType.test.ts
//
// **선물 비용을 현물 요율로 재고 있었다.**
//
// 무슨 일이 있었나
// ────────────────
// 한때 `src/lib/fees.ts`(파일)와 `src/lib/fees/index.ts`(폴더)가 **둘 다**
// `getDefaultConfig`를 내보냈다. 그리고 `'../fees'`는 Node·TS 해석에서
// **파일 쪽을 먼저** 골랐다. (그 파일은 지금 없다 — 아래 참고)
//
// 파일 쪽 서명은 인자가 하나다:
//
//     getDefaultConfig(exchangeId: ExchangeId = 'binance')
//
// 그래서 `backtest/index.ts`와 `safety/index.ts`가 부르던
//
//     getDefaultConfig(exchange, 'futures')
//
// 의 두 번째 인자가 **조용히 버려졌고**, 현물 요율이 돌아왔다. tsc는
// 이걸 계속 말하고 있었다(TS2554 "Expected 0-1 arguments, but got 2")
// — 기준선 73건 안에 섞여 아무도 안 봤다.
//
// 바이낸스 VIP0 taker 기준 **현물 0.1% 대 선물 0.05% — 정확히 2배**다.
// 백테스트에서 될 전략이 안 되는 것으로 나온다. 조용해서 더 나쁘다.
//
// 왜 타입만 고치면 모자라나
// ─────────────────────────
// import 경로를 되돌려도 CI는 안 막는다. 타입 오류 관문이
// `COUNT -gt BASELINE`이라 **개수가 줄어드는 쪽은 통과**하기 때문이다.
// 그래서 요율 자체를 값으로 고정한다.
import { test, eq, assert } from '../../test/harness';
import { getDefaultConfig, calcFeeAmount, calcFeeRate } from './index';

export function runFeeMarketTypeTests() {
  console.log('[수수료 — 선물과 현물을 섞지 않는다]');

  test('선물 taker 요율이 현물보다 싸다 — 같으면 시장 유형이 버려진 것이다', () => {
    const spot = calcFeeRate(getDefaultConfig('binance', 'spot'), 'taker');
    const fut  = calcFeeRate(getDefaultConfig('binance', 'futures'), 'taker');
    assert(fut < spot, `선물(${fut})이 현물(${spot})보다 싸지 않다 — 시장 유형이 반영되지 않았다`);
  });

  test('시장 유형이 실제로 금액을 바꾼다', () => {
    const notional = 10_000;
    const spot = calcFeeAmount(notional, getDefaultConfig('binance', 'spot'), 'taker');
    const fut  = calcFeeAmount(notional, getDefaultConfig('binance', 'futures'), 'taker');
    assert(fut < spot, `같은 금액이 나왔다 — 현물 ${spot} / 선물 ${fut}`);
    // 값까지 고정한다. 표가 바뀌면 여기서 먼저 걸린다.
    eq(spot, 10, '현물 taker 0.1%');
    eq(fut, 5, '선물 taker 0.05%');
  });

  test('시장 유형을 안 주면 현물이다 — 모르는 것을 선물로 치지 않는다', () => {
    eq(getDefaultConfig('binance').marketType, 'spot');
  });

  test('getDefaultConfig는 두 번째 인자를 실제로 쓴다', () => {
    // 쌍둥이 파일은 없앴다. 그래도 이 시험은 남긴다 — 누가 다시
    // 인자 하나짜리 서명으로 되돌리면(또는 marketType 을 무시하면)
    // 여기서 걸린다. 타입만으로는 못 막는다: CI 관문이
    // `COUNT -gt BASELINE` 이라 **개수가 줄어드는 쪽은 통과**한다.
    assert(getDefaultConfig.length >= 1, 'getDefaultConfig의 모양이 바뀌었다');
    eq(getDefaultConfig('binance', 'futures').marketType, 'futures',
      '두 번째 인자가 버려졌다 — marketType 을 읽지 않는 서명으로 돌아갔다');
  });

  test('모르는 거래소도 0원으로 적지 않는다', () => {
    const r = calcFeeRate(getDefaultConfig('custom' as any, 'futures'), 'taker');
    assert(r > 0, '수수료를 0으로 적으면 백테스트가 실제보다 좋게 나온다');
  });
}
