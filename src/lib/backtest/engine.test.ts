// src/lib/backtest/engine.test.ts
// 백테스트 엔진 유닛 테스트 — 자산 계산 정확성 + 폭증 방지 + sanity 검증.
import { runBacktest, type Candle } from './engine';
import { test, close, lt, gt, eq, assert } from '../../test/harness';

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
    //
    // **손절·익절을 0으로 끈다.** 이 테스트가 보는 것은 자산 모델이지
    // 청산 규칙이 아니다. 규칙을 켜 두면 +4%에서 익절돼 105까지 못 간다.
    const C = candles([[98, 20], [100, 1], [105, 10]]);   // 매수 후 105로 상승, 청산 신호 없이 종료청산
    const r = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10, stopPct: 0, takeProfitPct: 0, maxHoldHours: 0 } as any);
    // 진입가 100, 종료 105, 3배, 증거금 1M → netPnL = (105-100)*30000 = 150000
    close(r.finalEquity, 10_150_000, 5000, '최종 ≈10.15M');
    lt(r.finalEquity, 11_000_000, '폭증 없음');
  });

  // ── 데모와 같은 규칙으로 도는가 ─────────────────────────
  //
  // 예전 백테스트에는 손절·익절·청산·보유시간이 **하나도 없었다.** 전략
  // 신호로만 사고팔았다. 그 차이는 한 방향으로만 작동한다 — 손절로 끝나는
  // 거래가 없으니 언제나 더 좋게 나온다. 그리고 그 성적이 자금 배분으로
  // 흘러 실제 돈의 크기를 정한다.

  test('기본값으로 돌리면 익절이 걸린다 — 신호가 없어도 나간다', () => {
    const C = candles([[98, 20], [100, 1], [105, 10]]);
    const r = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    // 익절 4% → 104에 나간다. 105가 아니다.
    const sell = r.trades.find(t => t.side === 'sell');
    close(sell!.price, 104, 0.01, '익절가 104에 청산');
    close(r.finalEquity, 10_120_000, 5000, '(104-100)×30000 = 120,000');
  });

  test('손절이 걸리고, 그 횟수가 성적표에 남는다', () => {
    // 진입 후 -5%까지 떨어진다 → 2% 손절
    const C = candles([[98, 20], [100, 1], [95, 10]]);
    const r = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    gt(r.stopExits ?? 0, 0, '손절로 끝난 거래가 있어야');
    lt(r.finalEquity, 10_000_000, '손절이면 손실');
  });

  test('갭으로 손절을 뛰어넘으면 손절가가 아니라 그 가격에 체결된다', () => {
    // 100에 진입 → 다음 봉이 95로 열린다. 손절 98에 받았다고 치면
    // 실제로는 못 받는 3원을 매번 벌어들이는 장부가 된다.
    const C = candles([[98, 20], [100, 1], [95, 10]]);
    const r = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    const sell = r.trades.find(t => t.side === 'sell');
    close(sell!.price, 95, 0.01, '갭 난 시가 95에 체결');
    gt(r.gapExits ?? 0, 0, '갭으로 밀린 청산이 세어져야');
  });

  test('손절 없이 돌리면 성적표가 그 사실을 적는다', () => {
    // 손절 없는 백테스트를 손절 있는 실전과 비교하면 안 된다.
    // 숫자만 남으면 그 차이가 안 보이므로 결과에 같이 싣는다.
    const C = candles([[98, 20], [100, 1], [102, 10]]);
    const off = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10, stopPct: 0 } as any);
    assert(/손절 없이/.test(off.rulesNote || ''), '손절 없이 돌린 사실이 적혀야');
    const on = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    assert(/손절 2%/.test(on.rulesNote || ''), '켜져 있으면 어떤 규칙인지 적혀야');
  });

  test('진입한 봉의 저가로는 손절당하지 않는다', () => {
    // 그 저가는 진입 *전에* 찍힌 것일 수 있다. 들어가자마자 손절당한
    // 것으로 계산하면 모든 전략이 실제보다 훨씬 나쁘게 나온다.
    const C = candles([[98, 20], [100, 1], [100, 10]]);
    // 진입 봉(가격 100)의 저가를 90으로 낮춘다
    C[20] = { ...C[20], l: 90 };
    const r = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    const sell = r.trades.find(t => t.side === 'sell');
    assert(!sell || !/손절/.test(sell.reason), '진입 봉의 저가로 손절되면 안 된다');
  });

  // ── 숏 ─────────────────────────────────────────────────
  //
  // 데모 자동매매는 하락 추세에 숏을 잡는다. 백테스트가 롱만 돌면 하락장
  // 성적이 통째로 빠지고, 그러면 "이 전략은 하락장에 거래를 안 한다"는
  // 잘못된 결론이 나온다.

  const DOWN = (): Candle[] => candles([[102, 20], [100, 1], [95, 10]]);
  const futures = (extra: any = {}) => ({
    symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0,
    leverage: 3, positionPct: 0.1, emaFast: 3, emaSlow: 10, ...extra,
  } as any);

  test('하락장에서 숏으로 들어가고, 내려가면 이익이다', () => {
    const r = runBacktest(DOWN(), futures());
    gt(r.shortTrades ?? 0, 0, '숏 진입이 있어야');
    gt(r.finalEquity, 10_000_000, '가격이 내렸으니 숏은 이익');
  });

  test('숏 익절은 아래쪽이다 — 100에 들어가 96에 닫는다', () => {
    const r = runBacktest(DOWN(), futures());
    // 익절 4% → 숏은 96. 저가가 95까지 갔어도 걸어 둔 96까지만 친다.
    const exit = r.trades.filter(t => t.pnl !== undefined)[0];
    close(exit.price, 96, 0.01, '숏 익절가 96');
    close((exit as any).netPnL, (100 - 96) * (1_000_000 * 3 / 100), 1, '(100-96)×수량');
  });

  test('현물(1배)에서는 숏을 안 잡는다 — 낼 수 없는 주문이다', () => {
    const r = runBacktest(DOWN(), futures({ leverage: 1 }));
    eq(r.shortTrades ?? 0, 0);
    assert(/롱만/.test(r.rulesNote || ''), '롱만 돌았다고 적혀야');
  });

  test('배율을 줬어도 명시적으로 끄면 롱만 돈다', () => {
    const r = runBacktest(DOWN(), futures({ allowShort: false }));
    eq(r.shortTrades ?? 0, 0);
  });

  test('DCA는 배율이 있어도 숏을 안 한다', () => {
    const r = runBacktest(DOWN(), futures({ strategy: 'dca', dcaIntervalDays: 1 }));
    eq(r.shortTrades ?? 0, 0);
  });

  test('숏이 불리하게 가면 위쪽에서 손절된다', () => {
    // 100에 숏 → 105로 오른다. 손절 2% → 102.
    const C = candles([[102, 20], [100, 1], [105, 10]]);
    const r = runBacktest(C, futures());
    gt(r.shortTrades ?? 0, 0, '숏 진입이 있어야');
    gt(r.stopExits ?? 0, 0, '손절로 끝나야');
    lt(r.finalEquity, 10_000_000, '숏인데 올랐으니 손실');
  });

  test('반대 신호가 오면 먼저 닫는다 — 한 계좌에 반대 포지션 둘이 생기지 않는다', () => {
    // 내렸다가(숏) 다시 오른다(골든크로스) — 그 시점에 숏이 닫혀야 한다.
    const C = candles([[102, 20], [100, 1], [99, 6], [130, 12]]);
    const r = runBacktest(C, futures({ stopPct: 0, takeProfitPct: 0, maxHoldHours: 0 }));
    // 체결 목록에서 어느 시점에도 미청산 수량이 양쪽으로 쌓이면 안 된다
    let net = 0;
    for (const t of r.trades) net += (t.side === 'buy' ? 1 : -1) * t.qty;
    close(net, 0, 1e-6, '끝나면 포지션이 0이어야');
  });

  test('숏 보유 중 가격이 오르면 자산 곡선이 내려간다', () => {
    // 부호를 안 뒤집으면 숏이 손실일 때 자산이 늘어나는 곡선이 그려지고,
    // 최대 낙폭이 통째로 틀어진다.
    const C = candles([[102, 20], [100, 1], [101, 10]]);
    const r = runBacktest(C, futures({ stopPct: 0, takeProfitPct: 0, maxHoldHours: 0 }));
    gt(r.shortTrades ?? 0, 0, '숏 진입이 있어야');
    const last = r.equityCurve[r.equityCurve.length - 2];  // 종료청산 직전
    lt(last.equity, 10_000_000, '숏인데 올랐으면 평가자산이 줄어야');
  });

  test('수수료가 손익을 줄인다 (feeRate>0이면 순수익 < 무수수료)', () => {
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const noFee = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0, leverage: 5, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    const withFee = runBacktest(C, { symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000, feeRate: 0.001, leverage: 5, positionPct: 0.1, emaFast: 3, emaSlow: 10 } as any);
    lt(withFee.finalEquity, noFee.finalEquity, '수수료 있으면 최종자산 더 작아야');
  });

  console.log('[백테스트 엔진 — 수수료 말고도 나가는 것들]');

  const BASE_CFG = (extra: any = {}) => ({
    symbol: 'BTC', strategy: 'ema-cross', initialCash: 10_000_000,
    feeRate: 0, leverage: 5, positionPct: 0.1, emaFast: 3, emaSlow: 10, ...extra,
  }) as any;

  test('슬리피지는 진입도 청산도 불리한 쪽으로 민다', () => {
    // 롱은 비싸게 사고 싸게 판다. 유리한 쪽으로 밀면 그 성적표는
    // 검증이 아니라 희망이다.
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const r = runBacktest(C, BASE_CFG({ slippagePct: 0.1 }));
    const buy = r.trades.find(t => t.side === 'buy');
    const sell = r.trades.find(t => t.side === 'sell');
    gt(buy!.price, 100, '롱 진입은 더 비싸게 체결돼야');
    lt(sell!.price, 102, '롱 청산은 더 싸게 체결돼야');
  });

  test('슬리피지를 넣으면 최종자산이 줄어든다', () => {
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const noSlip = runBacktest(C, BASE_CFG({ slippagePct: 0 }));
    const withSlip = runBacktest(C, BASE_CFG({ slippagePct: 0.1 }));
    lt(withSlip.finalEquity, noSlip.finalEquity, '슬리피지가 공짜면 안 된다');
    gt(withSlip.slippageCost ?? 0, 0, '얼마 나갔는지 성적표에 남아야');
  });

  test('슬리피지 0으로 돌면 성적표에 그 사실이 적힌다', () => {
    // 숫자만 남으면 슬리피지 0짜리와 넣고 돌린 것이 똑같이 생겼다.
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const r = runBacktest(C, BASE_CFG({ slippagePct: 0 }));
    eq(r.slippageCost, 0);
    assert(String(r.costNote).includes('슬리피지 0'),
      `성적표에 안 적혀 있다: ${r.costNote}`);
  });

  test('펀딩비는 보유 시간에 비례한다', () => {
    const short = candles([[98, 20], [100, 1], [100, 2], [102, 1]]);
    const long  = candles([[98, 20], [100, 1], [100, 40], [102, 1]]);
    const a = runBacktest(short, BASE_CFG({ fundingRatePct8h: 0.01, maxHoldHours: 0 }));
    const b = runBacktest(long,  BASE_CFG({ fundingRatePct8h: 0.01, maxHoldHours: 0 }));
    gt(b.fundingPaid ?? 0, a.fundingPaid ?? 0, '오래 들고 있으면 더 낸다');
  });

  test('양수 펀딩에서 숏은 받는다 — 둘 다 빼면 숏 성적이 틀린다', () => {
    // 하락 신호 → 숏. 같은 펀딩률에서 롱은 내고 숏은 받아야 한다.
    const DOWN = candles([[102, 20], [100, 1], [99, 20], [99, 1]]);
    const r = runBacktest(DOWN, BASE_CFG({
      fundingRatePct8h: 0.01, allowShort: true, stopPct: 0, takeProfitPct: 0, maxHoldHours: 0,
    }));
    gt(r.shortTrades ?? 0, 0, '숏 진입이 있어야 이 테스트가 뜻이 있다');
    lt(r.fundingPaid ?? 0, 0, '숏은 양수 펀딩을 받는다 — 순액이 음수여야');
  });

  test('펀딩비를 안 넣고 배율로 돌리면 성적표가 그렇다고 말한다', () => {
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const r = runBacktest(C, BASE_CFG({ leverage: 5 }));
    assert(String(r.costNote).includes('펀딩비 미반영'),
      `성적표에 안 적혀 있다: ${r.costNote}`);
  });

  test('현물(1배)에는 펀딩 경고를 붙이지 않는다', () => {
    const C = candles([[98, 20], [100, 1], [100, 10], [102, 1]]);
    const r = runBacktest(C, BASE_CFG({ leverage: 1 }));
    assert(!String(r.costNote).includes('펀딩'),
      '현물에는 펀딩비가 없다 — 없는 경고를 띄우면 곧 아무도 안 읽는다');
  });
}
