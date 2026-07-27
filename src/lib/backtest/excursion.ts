// src/lib/backtest/excursion.ts
// MAE/MFE 분석 — 경로 의존성을 측정한다.
//
// 왜 필요한가:
//   종가 수익률만 보면 "그날 +5% 올랐으니 100배면 +500%"라는 결론이 나온다.
//   하지만 실제 경로가 진입 → -0.7% → +1% → +5% 였다면,
//   100배는 -0.5% 지점에서 이미 청산되어 +5%를 못 먹는다.
//
//   MAE (Maximum Adverse Excursion): 진입 후 가장 불리하게 갔던 지점
//   MFE (Maximum Favorable Excursion): 진입 후 가장 유리하게 갔던 지점
//
//   "MAE < 청산거리"인 거래만 그 배율에서 실제로 살아남는다.

export interface Bar { high: number; low: number; close: number; t?: number }

export interface Excursion {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  maePct: number;          // 최대 불리 이동 % (양수로 표기)
  mfePct: number;          // 최대 유리 이동 %
  closePct: number;        // 종가 기준 수익률 %
  maeBeforeMfe: boolean;   // MAE가 MFE보다 먼저 왔는가 (중요: 먼저 오면 청산 위험)
  maeBarIndex: number;
  mfeBarIndex: number;
  barsHeld: number;
}

/** 진입 후 봉들을 훑어 MAE/MFE를 기록한다 */
export function measureExcursion(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  bars: Bar[]
): Excursion {
  const isLong = side === 'LONG';
  let mae = 0, mfe = 0, maeIdx = 0, mfeIdx = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // 불리한 방향: 롱이면 저가, 숏이면 고가
    const adverse = isLong
      ? ((entryPrice - b.low) / entryPrice) * 100
      : ((b.high - entryPrice) / entryPrice) * 100;
    // 유리한 방향
    const favorable = isLong
      ? ((b.high - entryPrice) / entryPrice) * 100
      : ((entryPrice - b.low) / entryPrice) * 100;

    if (adverse > mae) { mae = adverse; maeIdx = i; }
    if (favorable > mfe) { mfe = favorable; mfeIdx = i; }
  }

  const last = bars[bars.length - 1];
  const closePct = last
    ? (isLong ? ((last.close - entryPrice) / entryPrice) * 100
              : ((entryPrice - last.close) / entryPrice) * 100)
    : 0;

  return {
    side, entryPrice,
    maePct: Math.max(0, mae),
    mfePct: Math.max(0, mfe),
    closePct,
    maeBeforeMfe: maeIdx <= mfeIdx,
    maeBarIndex: maeIdx, mfeBarIndex: mfeIdx,
    barsHeld: bars.length,
  };
}

// ── 배율별 생존 판정 ──────────────────────────────────

export interface SurvivalAtLeverage {
  leverage: number;
  liquidationDistPct: number;
  survived: boolean;
  reason: string;
  // 살아남았다면 실제로 얼마를 먹을 수 있었나
  achievableReturnPct: number | null;   // 증거금 대비 %
}

/**
 * 특정 배율에서 이 거래가 살아남았는지 판정한다.
 * MAE가 청산거리를 넘으면 최종 방향이 맞아도 청산된다.
 */
export function survivalAt(
  ex: Excursion,
  leverage: number,
  opts: { maintMarginRate?: number; feePct?: number; slippagePct?: number } = {}
): SurvivalAtLeverage {
  const mmr = opts.maintMarginRate ?? 0.005;
  const fee = opts.feePct ?? 0.08;      // 왕복
  const slip = opts.slippagePct ?? 0.05;

  const liqDist = Math.max(0.01, (1 / leverage - mmr) * 100);
  // 실효 MAE = 가격 MAE + 슬리피지 (진입가가 불리하게 체결되므로)
  const effectiveMae = ex.maePct + slip;

  if (effectiveMae >= liqDist) {
    return {
      leverage, liquidationDistPct: liqDist, survived: false,
      reason: `MAE ${effectiveMae.toFixed(2)}% ≥ 청산거리 ${liqDist.toFixed(2)}% — 청산됨`,
      achievableReturnPct: null,
    };
  }

  // 살아남음 — MFE까지 먹었다고 가정했을 때 증거금 대비 수익
  const grossPct = ex.mfePct * leverage;
  const costPct = (fee + slip) * leverage;
  return {
    leverage, liquidationDistPct: liqDist, survived: true,
    reason: `MAE ${effectiveMae.toFixed(2)}% < 청산거리 ${liqDist.toFixed(2)}% — 생존`,
    achievableReturnPct: grossPct - costPct,
  };
}

// ── 분포 분석 ─────────────────────────────────────────

export interface ExcursionStats {
  sampleSize: number;
  // MAE 분포
  maeP50: number; maeP75: number; maeP90: number; maeP99: number; maeMax: number;
  // MFE 분포
  mfeP50: number; mfeP90: number; mfeP99: number; mfeMax: number;
  // 배율별 생존률
  survivalByLeverage: { leverage: number; survivalRate: number; avgReturnIfSurvived: number; bigWinCount: number }[];
  // fat-tail 빈도
  daysWith3PctMove: number;
  daysWith5PctMove: number;
  // 100배에서 실제로 큰 수익이 가능했던 날
  fatTailDays: { mfePct: number; maePct: number; returnAt100x: number }[];
  note: string;
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

export function analyzeExcursions(
  excursions: Excursion[],
  leverages: number[] = [100, 50, 25, 10, 5, 2],
  opts: { bigWinThresholdPct?: number } = {}
): ExcursionStats {
  const bigWin = opts.bigWinThresholdPct ?? 300;   // 증거금 대비 +300%
  const n = excursions.length;

  const maes = excursions.map(e => e.maePct).sort((a, b) => a - b);
  const mfes = excursions.map(e => e.mfePct).sort((a, b) => a - b);

  const survivalByLeverage = leverages.map(lev => {
    const results = excursions.map(e => survivalAt(e, lev));
    const survived = results.filter(r => r.survived);
    const returns = survived.map(r => r.achievableReturnPct ?? 0);
    return {
      leverage: lev,
      survivalRate: n ? (survived.length / n) * 100 : 0,
      avgReturnIfSurvived: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
      bigWinCount: returns.filter(r => r >= bigWin).length,
    };
  });

  // 100배에서 살아남고 큰 수익이 났던 날
  const fatTailDays = excursions
    .map(e => ({ e, s: survivalAt(e, 100) }))
    .filter(x => x.s.survived && (x.s.achievableReturnPct ?? 0) >= bigWin)
    .map(x => ({
      mfePct: x.e.mfePct, maePct: x.e.maePct,
      returnAt100x: x.s.achievableReturnPct ?? 0,
    }))
    .sort((a, b) => b.returnAt100x - a.returnAt100x);

  const s100 = survivalByLeverage.find(s => s.leverage === 100);
  const note = !n
    ? '표본이 없습니다'
    : s100 && s100.survivalRate < 10
      ? `100배 생존률 ${s100.survivalRate.toFixed(1)}% — 대부분의 거래가 MAE에서 청산됩니다. MAE 중앙값 ${pct(maes, 0.5).toFixed(2)}%가 청산거리 0.50%를 넘습니다.`
      : s100
        ? `100배 생존률 ${s100.survivalRate.toFixed(1)}%, 그중 +${bigWin}% 이상 ${s100.bigWinCount}회`
        : '';

  return {
    sampleSize: n,
    maeP50: pct(maes, 0.5), maeP75: pct(maes, 0.75), maeP90: pct(maes, 0.9),
    maeP99: pct(maes, 0.99), maeMax: maes[maes.length - 1] ?? 0,
    mfeP50: pct(mfes, 0.5), mfeP90: pct(mfes, 0.9), mfeP99: pct(mfes, 0.99),
    mfeMax: mfes[mfes.length - 1] ?? 0,
    survivalByLeverage,
    daysWith3PctMove: excursions.filter(e => e.mfePct >= 3).length,
    daysWith5PctMove: excursions.filter(e => e.mfePct >= 5).length,
    fatTailDays: fatTailDays.slice(0, 20),
    note,
  };
}

/**
 * MAE 분포에서 안전한 최대 배율을 역산한다.
 * "거래의 X%가 살아남으려면 배율이 얼마여야 하는가"
 */
export function maxLeverageForSurvivalRate(
  excursions: Excursion[],
  targetSurvivalRate = 90,
  opts: { maintMarginRate?: number; slippagePct?: number } = {}
): { leverage: number; actualSurvivalRate: number; requiredLiqDist: number; note: string } {
  const mmr = opts.maintMarginRate ?? 0.005;
  const slip = opts.slippagePct ?? 0.05;
  if (!excursions.length) {
    return { leverage: 1, actualSurvivalRate: 0, requiredLiqDist: 0, note: '표본 없음' };
  }

  // 목표 생존률에 해당하는 MAE 분위수
  const maes = excursions.map(e => e.maePct + slip).sort((a, b) => a - b);
  const idx = Math.min(maes.length - 1, Math.floor(maes.length * (targetSurvivalRate / 100)));
  const requiredLiqDist = maes[idx];

  // (1/lev - mmr)*100 >= requiredLiqDist  →  lev <= 1/(requiredLiqDist/100 + mmr)
  const lev = Math.max(1, Math.floor(1 / (requiredLiqDist / 100 + mmr)));

  const actual = excursions.filter(e => survivalAt(e, lev, opts).survived).length / excursions.length * 100;

  return {
    leverage: lev,
    actualSurvivalRate: actual,
    requiredLiqDist,
    note: `거래의 ${targetSurvivalRate}%가 살아남으려면 청산거리 ${requiredLiqDist.toFixed(2)}% 이상 필요 → 최대 ${lev}배`,
  };
}
