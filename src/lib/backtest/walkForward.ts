// src/lib/backtest/walkForward.ts
// 워크포워드 검증 — 진짜 엣지와 과최적화를 구분한다.
//
// 문제: 파라미터를 바꿔가며 백테스트 수익률이 가장 높은 값을 고르면
//       그건 "그 데이터에만 맞는 값"일 가능성이 크다. 실전에서 무너진다.
//
// 방법: 데이터를 학습 구간(In-Sample)과 검증 구간(Out-of-Sample)으로 나눈다.
//       학습 구간에서만 최적값을 찾고, 검증 구간에서 그 값이 유지되는지 본다.
//       두 구간의 성과 차이(degradation)가 과최적화의 크기다.
import { runDailyStrategyBacktest, type DailyBar, type DailyBacktestConfig } from './dailyStrategyBacktest';

export interface ParamCandidate {
  label: string;
  config: Partial<DailyBacktestConfig>;
}

export interface FoldResult {
  foldIndex: number;
  inSampleExpectancy: number;
  outSampleExpectancy: number;
  inSampleTrades: number;
  outSampleTrades: number;
  bestParamLabel: string;
  degradation: number;          // IS - OOS (양수 = 검증에서 나빠짐)
}

export interface WalkForwardResult {
  folds: FoldResult[];
  // 전체 판정
  avgInSample: number;
  avgOutSample: number;
  avgDegradation: number;
  degradationPct: number;       // 검증에서 성과가 몇 % 떨어졌나
  consistency: number;          // 폴드 간 최적 파라미터 일치도 (0~100)
  paramStability: Record<string, number>;   // 각 파라미터가 몇 번 선택됐나
  overfittingRisk: 'low' | 'medium' | 'high';
  verdict: string;
  recommendation: string;
}

/**
 * 워크포워드 검증.
 * 데이터를 folds개로 나눠, 각 폴드마다 앞부분으로 학습하고 뒷부분으로 검증한다.
 */
export function runWalkForward(
  daily: DailyBar[],
  candidates: ParamCandidate[],
  opts: {
    folds?: number;
    inSampleRatio?: number;       // 각 폴드에서 학습 비율 (기본 0.7)
    baseConfig?: DailyBacktestConfig;
    intradayProvider?: (dayIndex: number) => { high: number; low: number; close: number }[] | null;
  } = {}
): WalkForwardResult {
  const folds = opts.folds ?? 4;
  const isRatio = opts.inSampleRatio ?? 0.7;
  const base = opts.baseConfig ?? {};

  const foldSize = Math.floor(daily.length / folds);
  const results: FoldResult[] = [];
  const paramCount: Record<string, number> = {};

  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = Math.min(daily.length, start + foldSize);
    const segment = daily.slice(start, end);
    if (segment.length < 80) continue;   // 워밍업 30일 + 최소 표본

    const splitAt = Math.floor(segment.length * isRatio);
    const inSample = segment.slice(0, splitAt);
    const outSample = segment.slice(splitAt);
    if (outSample.length < 40) continue;

    // ── 학습 구간에서 최적 파라미터 탐색 ──
    let bestLabel = candidates[0]?.label ?? 'default';
    let bestIS = -Infinity;
    let bestISTrades = 0;

    for (const cand of candidates) {
      const r = runDailyStrategyBacktest(inSample, { ...base, ...cand.config });
      // 표본이 너무 적으면 신뢰할 수 없음 — 제외
      if (r.trades.length < 10) continue;
      if (r.expectancyR > bestIS) {
        bestIS = r.expectancyR;
        bestLabel = cand.label;
        bestISTrades = r.trades.length;
      }
    }
    if (bestIS === -Infinity) continue;

    // ── 검증 구간에서 그 파라미터를 그대로 적용 ──
    const bestCand = candidates.find(c => c.label === bestLabel)!;
    const oos = runDailyStrategyBacktest(outSample, { ...base, ...bestCand.config });

    paramCount[bestLabel] = (paramCount[bestLabel] || 0) + 1;
    results.push({
      foldIndex: f,
      inSampleExpectancy: bestIS,
      outSampleExpectancy: oos.expectancyR,
      inSampleTrades: bestISTrades,
      outSampleTrades: oos.trades.length,
      bestParamLabel: bestLabel,
      degradation: bestIS - oos.expectancyR,
    });
  }

  if (!results.length) {
    return {
      folds: [], avgInSample: 0, avgOutSample: 0, avgDegradation: 0, degradationPct: 0,
      consistency: 0, paramStability: {}, overfittingRisk: 'high',
      verdict: '유효한 폴드가 없습니다. 데이터 기간을 늘리거나 진입 조건을 완화하세요.',
      recommendation: '최소 300일 이상의 데이터를 권장합니다.',
    };
  }

  const avgIS = results.reduce((a, r) => a + r.inSampleExpectancy, 0) / results.length;
  const avgOOS = results.reduce((a, r) => a + r.outSampleExpectancy, 0) / results.length;
  const avgDeg = avgIS - avgOOS;
  const degPct = avgIS !== 0 ? (avgDeg / Math.abs(avgIS)) * 100 : 0;

  // 파라미터 일관성 — 같은 값이 여러 폴드에서 선택될수록 신뢰도 높음
  const maxCount = Math.max(...Object.values(paramCount));
  const consistency = (maxCount / results.length) * 100;

  // 과최적화 위험 판정
  // 주의: 검증이 학습보다 크게 좋으면(음수 degradation) 그건 좋은 신호가 아니라
  //       표본이 부족해 결과가 노이즈에 지배된다는 뜻이다.
  const totalOosTrades = results.reduce((a, r) => a + r.outSampleTrades, 0);
  const totalIsTrades = results.reduce((a, r) => a + r.inSampleTrades, 0);
  const sampleThin = totalOosTrades < 100 || totalIsTrades < 150;
  const oosBeatsIs = degPct < -50;   // 검증이 학습보다 50% 이상 좋음 = 비정상

  let risk: WalkForwardResult['overfittingRisk'];
  if (avgOOS <= 0) risk = 'high';
  else if (oosBeatsIs || sampleThin) risk = 'high';         // 노이즈 지배
  else if (degPct > 60 || consistency < 40) risk = 'high';
  else if (degPct > 30 || consistency < 60) risk = 'medium';
  else risk = 'low';

  let verdict: string;
  if (avgOOS <= 0) {
    verdict = `검증 구간 기대값 ${avgOOS.toFixed(3)}R — 학습 구간에서만 좋았고 실제로는 엣지가 없습니다. 전형적인 과최적화입니다.`;
  } else if (oosBeatsIs) {
    verdict = `검증(${avgOOS.toFixed(3)}R)이 학습(${avgIS.toFixed(3)}R)보다 크게 좋습니다. 이는 엣지의 증거가 아니라 표본이 작아 결과가 우연에 지배된다는 신호입니다. 거래 표본: 학습 ${totalIsTrades}건 / 검증 ${totalOosTrades}건.`;
  } else if (sampleThin) {
    verdict = `표본이 부족합니다 (학습 ${totalIsTrades}건 / 검증 ${totalOosTrades}건). 어떤 결론도 신뢰하기 어렵습니다. 데이터 기간을 늘리세요.`;
  } else if (degPct > 60) {
    verdict = `학습 ${avgIS.toFixed(3)}R → 검증 ${avgOOS.toFixed(3)}R로 ${degPct.toFixed(0)}% 하락. 상당 부분이 곡선맞추기입니다.`;
  } else if (degPct > 30) {
    verdict = `검증에서 ${degPct.toFixed(0)}% 하락 — 일부 과최적화가 있지만 엣지 자체는 남아 있습니다.`;
  } else {
    verdict = `학습 ${avgIS.toFixed(3)}R → 검증 ${avgOOS.toFixed(3)}R (하락 ${degPct.toFixed(0)}%). 엣지가 구간을 넘어 유지됩니다.`;
  }

  const recommendation = (oosBeatsIs || sampleThin)
    ? `표본을 늘리세요 — 폴드당 최소 50거래, 전체 300거래 이상을 권장합니다. 현재 수치로 파라미터를 고르면 우연을 실력으로 착각합니다.`
    : risk === 'high'
      ? '이 파라미터를 실전에 쓰지 마세요. 파라미터 조정이 아니라 전략 로직 자체를 개선해야 합니다.'
      : risk === 'medium'
        ? `검증 구간 성과(${avgOOS.toFixed(3)}R)를 실제 기대값으로 보세요. 학습 구간 수치는 부풀려져 있습니다.`
        : `여러 구간에서 일관되게 선택된 파라미터(${Object.entries(paramCount).sort((a, b) => b[1] - a[1])[0]?.[0]})를 사용하세요.`;

  return {
    folds: results,
    avgInSample: avgIS, avgOutSample: avgOOS,
    avgDegradation: avgDeg, degradationPct: degPct,
    consistency, paramStability: paramCount,
    overfittingRisk: risk, verdict, recommendation,
  };
}

/**
 * 5v5 파라미터 후보 생성 — 최소 우위 × 트레일링 조합
 */
export function generate5v5Candidates(): ParamCandidate[] {
  const out: ParamCandidate[] = [];
  for (const minMargin of [8, 12, 16, 20, 25]) {
    for (const trailStartR of [1.5, 2, 3]) {
      for (const trailDistanceR of [0.5, 1, 1.5]) {
        out.push({
          label: `M${minMargin}/T${trailStartR}/D${trailDistanceR}`,
          config: { minMargin, trailStartR, trailDistanceR },
        });
      }
    }
  }
  return out;
}

/**
 * 단순 파라미터 스윕 (검증 없음) — 과최적화 위험을 보여주기 위한 비교군
 */
export interface SweepRow {
  label: string;
  expectancyR: number;
  winRate: number;
  trades: number;
  tradeRate: number;
  liquidations: number;
  maxConsecutiveLosses: number;
}

export function sweepParams(
  daily: DailyBar[],
  candidates: ParamCandidate[],
  base: DailyBacktestConfig = {}
): SweepRow[] {
  return candidates.map(c => {
    const r = runDailyStrategyBacktest(daily, { ...base, ...c.config });
    return {
      label: c.label,
      expectancyR: r.expectancyR,
      winRate: r.winRate,
      trades: r.trades.length,
      tradeRate: r.tradeRate,
      liquidations: r.liquidationCount,
      maxConsecutiveLosses: r.maxConsecutiveLosses,
    };
  }).sort((a, b) => b.expectancyR - a.expectancyR);
}
