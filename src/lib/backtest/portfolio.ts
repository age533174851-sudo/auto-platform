// src/lib/backtest/portfolio.ts
// 다중 전략 포트폴리오 백테스트 — 여러 전략을 자금 배분대로 합쳐 합산 성과 계산.
// 핵심: 전략을 섞으면 상관관계가 낮을수록 분산 효과로 MDD가 줄어든다.
// (같은 방향으로만 움직이는 전략끼리는 분산 효과가 없다.)

export interface StrategyLeg {
  id: string;
  name: string;
  weightPct: number;              // 자금 배분 %
  equityCurve: { t: number; equity: number }[];   // 개별 백테스트 자산곡선
}

export interface PortfolioBacktestResult {
  combined: { t: number; equity: number }[];   // 합산 자산곡선 (초기=100 정규화)
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  // 분산 효과 지표
  weightedAvgMdd: number;         // 개별 MDD의 가중평균 (섞지 않았을 때)
  diversificationBenefit: number; // 가중평균MDD - 포트폴리오MDD (양수면 분산 효과)
  correlationMatrix: number[][];  // 전략 간 수익률 상관계수
  legStats: { id: string; name: string; returnPct: number; mddPct: number; weightPct: number }[];
}

// 자산곡선 → 일별(포인트별) 수익률 배열
function toReturns(curve: { equity: number }[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity || 1;
    r.push((curve[i].equity - prev) / prev);
  }
  return r;
}

function maxDrawdown(curve: { equity: number }[]): number {
  let peak = -Infinity, mdd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd * 100;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const av = a.slice(0, n), bv = b.slice(0, n);
  const ma = av.reduce((x, y) => x + y, 0) / n, mb = bv.reduce((x, y) => x + y, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = av[i] - ma, db = bv[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  const denom = Math.sqrt(va * vb);
  return denom === 0 ? 0 : cov / denom;
}

export function runPortfolioBacktest(legs: StrategyLeg[], initialCapital = 10000000): PortfolioBacktestResult {
  const valid = legs.filter(l => l.equityCurve && l.equityCurve.length > 1);
  if (!valid.length) {
    return { combined: [], totalReturnPct: 0, maxDrawdownPct: 0, sharpe: 0, weightedAvgMdd: 0, diversificationBenefit: 0, correlationMatrix: [], legStats: [] };
  }

  // 가중치 정규화
  const totalW = valid.reduce((a, b) => a + b.weightPct, 0) || 1;
  const weights = valid.map(l => l.weightPct / totalW);

  // 공통 길이 (가장 짧은 곡선 기준)
  const len = Math.min(...valid.map(l => l.equityCurve.length));

  // 각 전략을 초기값 기준 정규화 (배수) 후 가중합
  const combined: { t: number; equity: number }[] = [];
  for (let i = 0; i < len; i++) {
    let port = 0;
    for (let j = 0; j < valid.length; j++) {
      const base = valid[j].equityCurve[0].equity || 1;
      const mult = valid[j].equityCurve[i].equity / base;    // 초기 대비 배수
      port += weights[j] * mult;
    }
    combined.push({ t: valid[0].equityCurve[i].t, equity: initialCapital * port });
  }

  // 합산 성과
  const totalReturnPct = ((combined[len - 1].equity - initialCapital) / initialCapital) * 100;
  const maxDrawdownPct = maxDrawdown(combined);
  const portReturns = toReturns(combined);
  const meanR = portReturns.reduce((a, b) => a + b, 0) / (portReturns.length || 1);
  const sd = Math.sqrt(portReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (portReturns.length || 1));
  const sharpe = sd === 0 ? 0 : (meanR / sd) * Math.sqrt(252);

  // 개별 통계 + 가중평균 MDD
  const legStats = valid.map((l, j) => {
    const base = l.equityCurve[0].equity || 1;
    const last = l.equityCurve[l.equityCurve.length - 1].equity;
    return { id: l.id, name: l.name, returnPct: ((last - base) / base) * 100, mddPct: maxDrawdown(l.equityCurve), weightPct: weights[j] * 100 };
  });
  const weightedAvgMdd = legStats.reduce((a, s, j) => a + s.mddPct * weights[j], 0);
  const diversificationBenefit = weightedAvgMdd - maxDrawdownPct;

  // 상관관계 매트릭스
  const retArrays = valid.map(l => toReturns(l.equityCurve));
  const correlationMatrix = valid.map((_, i) => valid.map((_, k) => Math.round(correlation(retArrays[i], retArrays[k]) * 100) / 100));

  return { combined, totalReturnPct, maxDrawdownPct, sharpe, weightedAvgMdd, diversificationBenefit, correlationMatrix, legStats };
}
