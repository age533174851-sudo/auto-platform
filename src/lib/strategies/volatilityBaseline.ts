// src/lib/strategies/volatilityBaseline.ts
// 변동성 기준선 — Risk Veto의 VOLATILITY_SPIKE 판정에 쓰인다.
//
// 왜 median인가:
//   평균을 쓰면 이미 고변동 구간에서 기준선도 같이 올라간다.
//   현재 ATR 5%가 "평소의 2배"가 아니라 "평소와 비슷"이 되어 Veto가 풀린다.
//   median은 소수의 극단값에 끌려가지 않으므로 급등 구간에서도 기준선이 안정적이다.
//
// 예: [1.5, 1.6, 1.4, 1.5, 8.0, 9.0]  ← 뒤 두 개가 급등
//     평균 = 3.83  → 현재 9%면 2.3배 (겨우 걸림)
//     중앙값 = 1.55 → 현재 9%면 5.8배 (확실히 걸림)

export interface AtrBaselineResult {
  baselineAtrPct: number;      // rolling median
  currentAtrPct: number;
  ratio: number;               // current / baseline
  sampleSize: number;
  method: 'median' | 'insufficient';
  note: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** True Range 기반 일별 ATR% 시계열 */
export function atrPctSeries(
  highs: number[], lows: number[], closes: number[], period = 14
): number[] {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n < period + 1) return [];

  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }

  const out: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    const window = trs.slice(i - period + 1, i + 1);
    const atr = window.reduce((a, b) => a + b, 0) / period;
    const px = closes[i + 1] || closes[closes.length - 1] || 1;
    out.push((atr / px) * 100);
  }
  return out;
}

/**
 * 최근 lookbackDays 구간의 ATR% rolling median을 기준선으로 삼는다.
 * 현재 값은 기준선 계산에서 제외한다 — 자기 자신이 기준이 되면 비율이 항상 1에 가까워진다.
 */
export function computeAtrBaseline(
  highs: number[], lows: number[], closes: number[],
  opts: { period?: number; lookbackDays?: number; minSample?: number } = {}
): AtrBaselineResult {
  const period = opts.period ?? 14;
  const lookback = clamp(opts.lookbackDays ?? 40, 20, 60);   // 리뷰 권고: 20~60일
  const minSample = opts.minSample ?? 20;

  const series = atrPctSeries(highs, lows, closes, period);
  if (series.length === 0) {
    return { baselineAtrPct: 0, currentAtrPct: 0, ratio: 1, sampleSize: 0,
      method: 'insufficient', note: '데이터 부족 — ATR을 계산할 수 없습니다' };
  }

  const current = series[series.length - 1];

  // 현재 값을 제외한 최근 lookback 구간
  const history = series.slice(Math.max(0, series.length - 1 - lookback), series.length - 1);

  if (history.length < minSample) {
    return {
      baselineAtrPct: current, currentAtrPct: current, ratio: 1,
      sampleSize: history.length, method: 'insufficient',
      note: `기준선 표본 ${history.length}일 (최소 ${minSample}일 필요) — 변동성 Veto를 신뢰할 수 없습니다`,
    };
  }

  const baseline = median(history);
  const ratio = baseline > 0 ? current / baseline : 1;

  return {
    baselineAtrPct: baseline, currentAtrPct: current, ratio,
    sampleSize: history.length, method: 'median',
    note: `최근 ${history.length}일 ATR% 중앙값 ${baseline.toFixed(2)}% 대비 현재 ${current.toFixed(2)}% (${ratio.toFixed(2)}배)`,
  };
}

/** 평균 대비 median의 강건성을 보여주는 비교 (진단용) */
export function compareBaselineMethods(
  highs: number[], lows: number[], closes: number[], lookbackDays = 40
): { mean: number; median: number; currentAtr: number; meanRatio: number; medianRatio: number; note: string } {
  const series = atrPctSeries(highs, lows, closes);
  if (series.length < 2) return { mean: 0, median: 0, currentAtr: 0, meanRatio: 1, medianRatio: 1, note: '데이터 부족' };

  const current = series[series.length - 1];
  const hist = series.slice(Math.max(0, series.length - 1 - lookbackDays), series.length - 1);
  const mean = hist.reduce((a, b) => a + b, 0) / (hist.length || 1);
  const med = median(hist);

  const meanRatio = mean > 0 ? current / mean : 1;
  const medianRatio = med > 0 ? current / med : 1;

  return {
    mean, median: med, currentAtr: current, meanRatio, medianRatio,
    note: medianRatio > meanRatio
      ? `median 기준이 ${(medianRatio / meanRatio).toFixed(2)}배 민감 — 급등을 더 잘 잡습니다`
      : 'median과 평균이 비슷한 구간입니다',
  };
}
