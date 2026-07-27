// src/lib/backtest/compound.ts
// 복리 분석 — 백테스트 수익률에서 CAGR·누적수익률·복리 성장을 계산.
// 1년만 보면 복리 ON/OFF 차이가 없지만, 다년으로 보면 복리 효과가 드러난다.

export interface CompoundAnalysis {
  periodDays: number;
  periodYears: number;
  totalReturnPct: number;       // 기간 총 수익률
  cagr: number;                 // 연평균 복리 수익률 (%)
  // 복리 ON/OFF 다년 성장 (초기자본 기준)
  years: number[];              // [1,2,3,5,10]
  compoundValues: number[];     // 복리 재투자 시 자산
  simpleValues: number[];       // 단리(원금 고정 수익) 시 자산
  projectionNote: string;
}

// CAGR = (최종/초기)^(1/연수) − 1
export function computeCAGR(totalReturnPct: number, periodDays: number): number {
  const years = periodDays / 365;
  if (years <= 0) return 0;
  const growth = 1 + totalReturnPct / 100;
  if (growth <= 0) return -100;
  return (Math.pow(growth, 1 / years) - 1) * 100;
}

export function analyzeCompound(totalReturnPct: number, periodDays: number, initialCapital = 10000000): CompoundAnalysis {
  const periodYears = periodDays / 365;
  const cagr = computeCAGR(totalReturnPct, periodDays);
  const r = cagr / 100;

  const years = [1, 2, 3, 5, 10];
  // 복리: 초기자본 × (1+CAGR)^n
  const compoundValues = years.map(y => Math.round(initialCapital * Math.pow(1 + r, y)));
  // 단리: 초기자본 × (1 + CAGR×n) — 수익을 재투자하지 않고 원금만 굴림
  const simpleValues = years.map(y => Math.round(initialCapital * (1 + r * y)));

  const y10Compound = compoundValues[4];
  const y10Simple = simpleValues[4];
  const diffPct = y10Simple > 0 ? ((y10Compound - y10Simple) / y10Simple) * 100 : 0;
  const projectionNote = cagr >= 0
    ? `연 ${cagr.toFixed(1)}% 유지 시 10년 후 복리는 단리보다 약 ${diffPct.toFixed(0)}% 더 성장합니다.`
    : `연 ${cagr.toFixed(1)}%로 손실이 지속되면 복리(재투자)가 오히려 원금을 더 빠르게 잠식합니다.`;

  return { periodDays, periodYears, totalReturnPct, cagr, years, compoundValues, simpleValues, projectionNote };
}

// 복리 성장 곡선 (그래프용) — 월 단위 포인트
export function compoundCurve(cagr: number, yearsSpan: number, initialCapital = 10000000): { compound: number[]; simple: number[]; labels: string[] } {
  const r = cagr / 100;
  const months = Math.round(yearsSpan * 12);
  const compound: number[] = [], simple: number[] = [], labels: string[] = [];
  for (let m = 0; m <= months; m++) {
    const y = m / 12;
    compound.push(Math.round(initialCapital * Math.pow(1 + r, y)));
    simple.push(Math.round(initialCapital * (1 + r * y)));
    labels.push(m % 12 === 0 ? `${m / 12}년` : '');
  }
  return { compound, simple, labels };
}
