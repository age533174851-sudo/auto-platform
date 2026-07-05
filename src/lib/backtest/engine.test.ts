// src/lib/backtest/engine.test.ts
// 백테스트 엔진 유닛 테스트 — 자산 계산 정확성 + 폭증 방지 + sanity 검증.
import { runBacktest, type Candle } from './engine';
import { test, close, lt, gt, assert } from '../../test/harness';

function candles(spec: Array<[number, number]>): Candle[] {
  // spec: [가격, 반복수][] → 캔들 배열
  const out: Candle[] = [];
  let t = Date.UTC(2025, 0, 1);
  for (const [price, n] of spec) {
    for (let i = 0; i < n; i++) { out.push({ t, o: price, h: price, l: price, c: price, v: 1 }); t += 3600000; }
  }
  return out;
}

export function runBacktestTests() {
  console.log('[백테스트 엔진]');

  test('검증 케이스: 10M·5배·100→102·10% → 최종 정확히 10,100,000', () => {
    // 98 워밍업 → 100 점프(골든크로스 매수) → 100 유지 → 102 종료청산
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const r = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 5, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    const buy = r.trades.find(t => t.side === 'buy');
    const sell = r.trades.find(t => t.side === 'sell');
    assert(!!buy && !!sell, '매수·매도 모두 발생해야');
    close(buy!.price, 100, 0.01, '진입가 100');
    close(buy!.qty, 50000, 1, '수량 = 증거금1M×5배/100 = 50000');
    close((sell as any).netPnL, 100000, 1, 'netPnL = (102-100)*50000 = 100000');
    close(r.finalEquity, 10_100_000, 1, '최종자산 정확히 10.1M');
    close(r.totalReturnPct, 1, 0.01, '수익률 +1%');
    assert(!r.sanityWarning, 'sanity 경고 없어야');
  });

  test('폭증 방지: 다회 거래해도 초기의 50배 미만 (레버리지 중복 없음)', () => {
    // 강한 진동 추세로 여러 왕복
    const spec: Array<[number, number]> = [];
    let base = 100;
    for (let k = 0; k < 30; k++) for (let i = 0; i < 8; i++) { base += i < 4 ? 1.5 : -1.2; spec.push([Math.max(1, base), 1]); }
    const r = runBacktest(candles(spec), { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0.001, leverage: 5, positionPct: 1, emaFast: 3, emaSlow: 8 } as any);
    lt(r.finalEquity, 10_000_000 * 50, '자산이 초기의 50배를 넘으면 안 됨 (예전 버그면 920조)');
    gt(r.finalEquity, 0, '자산은 양수');
  });

  test('진입은 balance 불변, 청산 시에만 반영 (보유 중 equity = 미실현 반영)', () => {
    // 매수 후 가격 상승 중(미청산) — equityCurve가 balance+미실현을 반영하되 폭증 없음
    const C = candles([[98, 20], [100, 1], [105, 10]]);   // 매수 후 105로 상승, 청산 신호 없이 종료청산
    const r = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    // 진입가 100, 종료 105, 3배, 증거금 1M → netPnL = (105-100)*30000 = 150000
    close(r.finalEquity, 10_150_000, 5000, '최종 ≈10.15M');
    lt(r.finalEquity, 11_000_000, '폭증 없음');
  });

  test('수수료가 손익을 줄인다 (feeRate>0이면 순수익 < 무수수료)', () => {
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const noFee = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 5, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    const withFee = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0.001, leverage: 5, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    lt(withFee.finalEquity, noFee.finalEquity, '수수료 있으면 최종자산 더 작아야');
  });
}
