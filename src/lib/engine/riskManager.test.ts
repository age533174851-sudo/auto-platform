// src/lib/engine/riskManager.test.ts
// 주문 권한의 마지막 문을 검증한다. 특히 Expansion Mode 상한이 실제로
// 강제되는지 — 화면 계산과 주문 경로가 어긋나 있던 것이 이 테스트의 이유다.
import { test, assert, eq, lt } from '../../test/harness';
import { planPosition, type RiskConfig } from './riskManager';
import type { StandardSignal } from './signalGateway';
import { buildExpansionGate, type ExpansionResult } from '../strategies/expansionMode';

const signal = (over: Partial<StandardSignal> = {}): StandardSignal => ({
  strategyId: 'test',
  symbol: 'BTCUSDT',
  signal: 'LONG',
  confidence: 0.7,
  entryPrice: 100_000,
  stopLoss: 99_000,          // 손절 1%
  timeframe: '1h',
  timestamp: 0,
  bucket: 'swing',
  ...over,
} as StandardSignal);

const cfg = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  accountEquity: 100_000,
  availableMargin: 100_000,
  maxLeverage: 100,
  riskPerTradePct: 1,
  ...over,
});

const expansion = (over: Partial<ExpansionResult> = {}): ExpansionResult => ({
  mode: 'EXPANSION',
  maxLeverageAllowed: 40,
  expansionScore: 80,
  signals: [],
  maeConstraint: { expectedMaeP90: null, liquidationDistAt: {}, cappedBy: 'none' },
  reason: 'test',
  ...over,
});

export function runRiskManagerTests() {
  console.log('[Risk Manager — Expansion 게이트]');

  test('평가가 없으면 설정 상한(100배)이 아니라 일반 모드 상한으로 제한된다', () => {
    const p = planPosition(signal(), cfg({ maxLeverage: 100 }));
    assert(p.approved || p.rejectCode === 'LIQUIDATION_BEFORE_STOP', '예기치 않은 거부: ' + p.rejectCode);
    lt(p.leverage, 11, `평가 없이 ${p.leverage}배가 승인됨 — fail-closed가 깨졌다`);
  });

  test('normalMaxLeverage로 일반 모드 상한을 바꿀 수 있다', () => {
    const p = planPosition(signal(), cfg({ maxLeverage: 100, normalMaxLeverage: 3 }));
    lt(p.leverage, 4, `상한 3배 설정인데 ${p.leverage}배`);
  });

  test('EXPANSION 평가가 있으면 그 상한까지 올라갈 수 있다', () => {
    const wide = signal({ stopLoss: 90_000 });   // 손절 10% — 청산 여유 확보용
    const p = planPosition(wide, cfg({ maxLeverage: 100, expansion: expansion({ maxLeverageAllowed: 40 }) }));
    assert(p.leverage <= 40, `expansion 상한 40배를 넘었다: ${p.leverage}배`);
  });

  test('expansion 상한과 설정 상한 중 낮은 쪽이 적용된다', () => {
    const p = planPosition(signal(), cfg({ maxLeverage: 5, expansion: expansion({ maxLeverageAllowed: 80 }) }));
    assert(p.leverage <= 5, `설정 상한 5배를 넘었다: ${p.leverage}배`);
  });

  test('NO_TRADE 판정이면 주문이 거부된다', () => {
    const p = planPosition(signal(), cfg({ expansion: expansion({ mode: 'NO_TRADE' }) }));
    eq(p.approved, false, 'NO_TRADE인데 승인됨');
    eq(p.rejectCode, 'EXPANSION_NO_TRADE');
  });

  console.log('[Risk Manager — 청산가]');

  test('청산 거리가 손절보다 충분히 멀어야 승인된다', () => {
    // 손절 0.1%로 아주 좁게 → 고배율이 역산되어 청산이 손절보다 가까워진다
    const tight = signal({ stopLoss: 99_900 });
    const p = planPosition(tight, cfg({ maxLeverage: 100, expansion: expansion({ maxLeverageAllowed: 100 }) }));
    if (p.approved) {
      assert(p.liquidationDistancePct > p.effectiveStopPct,
        `승인됐는데 청산(${p.liquidationDistancePct.toFixed(2)}%)이 손절(${p.effectiveStopPct.toFixed(2)}%)보다 가깝다`);
    } else {
      eq(p.rejectCode, 'LIQUIDATION_BEFORE_STOP');
    }
  });

  test('명목가가 커지면 유지증거금 계단이 올라가 청산이 더 가까워진다', () => {
    // 같은 배율에서 소액 vs 거액을 비교한다. 계단식이면 거액 쪽 청산 거리가
    // 더 짧아야 하고, 평탄 근사식이었다면 둘이 정확히 같은 값이 나온다.
    //
    // 증거금은 양쪽 다 역산 배율이 5배가 되도록 맞췄다. 증거금을 넉넉히 주면
    // 위험 기반 사이징 특성상 배율이 1배로 떨어져 비교 자체가 성립하지 않는다.
    const wide = signal({ stopLoss: 95_000 });   // 손절 5% → 실효 5.15%
    const small = planPosition(wide, cfg({
      accountEquity: 10_000, availableMargin: 400,          // 명목가 ≈ $1,942
      maxLeverage: 10, expansion: expansion({ maxLeverageAllowed: 10 }),
    }));
    const large = planPosition(wide, cfg({
      accountEquity: 50_000_000, availableMargin: 2_000_000, // 명목가 ≈ $9.7M
      maxLeverage: 10, expansion: expansion({ maxLeverageAllowed: 10 }),
    }));

    assert(small.approved, '소액 주문이 거부됨: ' + small.rejectReason);
    assert(large.approved, '거액 주문이 거부됨: ' + large.rejectReason);
    eq(small.leverage, large.leverage, '비교 전제인 배율이 서로 다르다');
    assert(large.positionSize > small.positionSize * 100, '명목가 차이가 충분하지 않다');
    assert(large.liquidationDistancePct < small.liquidationDistancePct,
      `계단식이 반영되지 않았다 — 소액 ${small.liquidationDistancePct.toFixed(3)}% vs 거액 ${large.liquidationDistancePct.toFixed(3)}%`);
  });

  test('1배는 청산 사유로 거부되지 않는다', () => {
    const p = planPosition(signal({ stopLoss: 50_000 }), cfg({ maxLeverage: 1, normalMaxLeverage: 1 }));
    assert(p.rejectCode !== 'LIQUIDATION_BEFORE_STOP', '1배인데 청산 사유로 거부됨');
  });

  console.log('[Expansion 게이트 빌더]');

  // 합성 일봉 — 완만한 우상향에 소폭 노이즈
  const bars = (n: number, vol = 0.01) => {
    const closes: number[] = [], highs: number[] = [], lows: number[] = [];
    let px = 100_000;
    for (let i = 0; i < n; i++) {
      px *= 1 + ((i % 7) - 3) * vol * 0.1;
      closes.push(px);
      highs.push(px * (1 + vol));
      lows.push(px * (1 - vol));
    }
    return { closes, highs, lows };
  };

  test('일봉이 없으면 평가하지 않고 이유를 남긴다 (fail-closed)', () => {
    const g = buildExpansionGate({});
    eq(g.result, null, '데이터 없이 평가 결과가 나왔다');
    assert(!!g.skipReason, 'skipReason이 비어 있다');
  });

  test('표본이 부족하면 평가하지 않는다', () => {
    const b = bars(20);   // ATR 기준선 최소 표본(20일) 미달
    const g = buildExpansionGate({ dailyHighs: b.highs, dailyLows: b.lows, dailyCloses: b.closes });
    eq(g.result, null, '표본 부족인데 평가됨');
  });

  test('데이터가 충분하면 평가 결과를 만든다', () => {
    const b = bars(60);
    const g = buildExpansionGate({ dailyHighs: b.highs, dailyLows: b.lows, dailyCloses: b.closes });
    assert(g.result !== null, '충분한 데이터인데 평가 실패: ' + g.skipReason);
    assert(g.result!.maxLeverageAllowed >= 1, '상한이 1배 미만');
  });

  test('평가 불가 시 주문은 일반 모드 상한으로 제한된다', () => {
    // buildExpansionGate → planPosition 경로를 그대로 통과시킨다
    const g = buildExpansionGate({});
    const p = planPosition(signal(), cfg({ maxLeverage: 100, expansion: g.result }));
    lt(p.leverage, 11, `평가 불가인데 ${p.leverage}배가 승인됨`);
  });

  console.log('[Risk Manager — 기존 한도]');

  test('일일 손실 한도에 도달하면 신규 진입을 막는다', () => {
    const p = planPosition(signal(), cfg({ dailyPnl: -5_000, maxDailyLossPct: 3 }));
    eq(p.approved, false);
    eq(p.rejectCode, 'DAILY_LOSS_LIMIT');
  });

  test('손절 거리가 0이면 위험 계산이 불가하므로 거부한다', () => {
    const p = planPosition(signal({ stopLoss: 100_000 }), cfg());
    eq(p.approved, false);
    eq(p.rejectCode, 'INVALID_STOP');
  });
}
