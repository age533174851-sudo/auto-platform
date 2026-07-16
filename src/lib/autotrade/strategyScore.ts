// src/lib/autotrade/strategyScore.ts
// AI 전략 점수(Strategy Score) — 승률·Profit Factor·MDD·샤프·최근 성과를 합산한 기관급 스코어.
// 단순 승률 건강도의 업그레이드: "얼마나 자주 이기나"가 아니라 "어떻게 이기나"까지 평가.

export interface ScoreBreakdownItem {
  key: 'winRate' | 'profitFactor' | 'mdd' | 'sharpe' | 'recent';
  label: string;
  value: string;      // 표시값 (예: "1.85", "-12.3%")
  sub: number;        // 0~100 서브점수
  weight: number;     // 가중치 %
}

export interface StrategyScore {
  score: number;         // 0~100
  stars: number;         // 0.5~5.0 (0.5 단위)
  grade: string;         // S/A/B/C/D
  gradeColor: string;
  confidence: number;    // 표본 신뢰도 0~100
  breakdown: ScoreBreakdownItem[];
  summary: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const mapRange = (v: number, inLo: number, inHi: number) => clamp(((v - inLo) / (inHi - inLo)) * 100, 0, 100);

// 핵심 지표 계산 (거래 손익 배열 기반)
export function computeMetrics(pnls: number[]) {
  const n = pnls.length;
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const winRate = n ? (wins.length / n) * 100 : 0;
  const totalWin = wins.reduce((a, b) => a + b, 0);
  const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 3 : 0);
  // MDD: 누적 손익 곡선의 최대 낙폭 (peak 대비 %)
  let cum = 0, peak = 0, mdd = 0;
  const base = Math.max(1, Math.abs(pnls.reduce((a, b) => a + Math.abs(b), 0)) / Math.max(1, n) * 10); // 스케일 기준
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > mdd) mdd = dd;
  }
  const mddPct = (mdd / (peak > 0 ? Math.max(peak, base) : base)) * 100;
  // Sharpe (거래 단위): 평균/표준편차 × √N 근사
  const mean = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(Math.min(n, 50)) : 0;
  // 최근 성과: 마지막 10회 승률
  const recent = pnls.slice(-10);
  const recentWR = recent.length ? (recent.filter(p => p > 0).length / recent.length) * 100 : 0;
  return { n, winRate, profitFactor, mddPct: clamp(mddPct, 0, 100), sharpe, recentWR };
}

export function scoreStrategy(pnls: number[]): StrategyScore {
  const m = computeMetrics(pnls);
  if (m.n === 0) {
    return { score: 50, stars: 2.5, grade: '—', gradeColor: '#64748B', confidence: 0,
      breakdown: [], summary: '거래 기록 없음 — 평가 불가' };
  }
  const breakdown: ScoreBreakdownItem[] = [
    { key: 'winRate', label: '승률', value: `${m.winRate.toFixed(0)}%`, sub: mapRange(m.winRate, 30, 70), weight: 20 },
    { key: 'profitFactor', label: 'Profit Factor', value: m.profitFactor.toFixed(2), sub: mapRange(m.profitFactor, 0.8, 2.5), weight: 25 },
    { key: 'mdd', label: '최대 낙폭(MDD)', value: `-${m.mddPct.toFixed(1)}%`, sub: 100 - mapRange(m.mddPct, 5, 45), weight: 20 },
    { key: 'sharpe', label: 'Sharpe', value: m.sharpe.toFixed(2), sub: mapRange(m.sharpe, 0, 2.5), weight: 15 },
    { key: 'recent', label: '최근 10회', value: `승률 ${m.recentWR.toFixed(0)}%`, sub: mapRange(m.recentWR, 30, 70), weight: 20 },
  ];
  let raw = breakdown.reduce((a, b) => a + b.sub * (b.weight / 100), 0);
  // 표본 신뢰도: 20회에 수렴
  const confidence = clamp((m.n / 20) * 100, 0, 100);
  const score = Math.round(50 + (raw - 50) * (confidence / 100));
  const stars = clamp(Math.round((score / 20) * 2) / 2, 0.5, 5);
  const grade = score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : 'D';
  const gradeColor = score >= 85 ? '#F59E0B' : score >= 70 ? '#22C55E' : score >= 55 ? '#0EA5E9' : score >= 40 ? '#64748B' : '#EF4444';
  const best = [...breakdown].sort((a, b) => b.sub - a.sub)[0];
  const worst = [...breakdown].sort((a, b) => a.sub - b.sub)[0];
  const summary = `강점: ${best.label}(${best.value}) · 약점: ${worst.label}(${worst.value})`;
  return { score, stars, grade, gradeColor, confidence: Math.round(confidence), breakdown, summary };
}

// 요약치(winRate/totalPnl/trades)에서 결정적 거래열 합성 — 실거래가 쌓이면 그대로 대체.
export function tradesFromSummary(s: { id: string; winRate: number; totalPnl: number; trades: number }): number[] {
  const n = Math.max(0, Math.floor(s.trades));
  if (n === 0) return [];
  const winsN = Math.round((clamp(s.winRate, 0, 100) / 100) * n);
  const lossN = n - winsN;
  // 평균 승/패 크기: totalPnl과 정합 (손익비 1.4 가정으로 역산)
  const R = 1.4;
  // winsN*avgW - lossN*avgL = totalPnl, avgW = R*avgL
  const denom = winsN * R - lossN;
  let avgL = denom !== 0 ? s.totalPnl / denom : Math.abs(s.totalPnl) / Math.max(1, n);
  if (!(avgL > 0)) avgL = Math.max(10000, Math.abs(s.totalPnl) / Math.max(1, n));
  const avgW = R * avgL;
  // 결정적 셔플 (id 해시 시드)
  const seed = s.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const out: number[] = [];
  let w = winsN, l = lossN;
  for (let i = 0; i < n; i++) {
    const r = Math.abs(Math.sin(seed * 3.7 + i * 2.3));
    const jitter = 0.7 + Math.abs(Math.sin(seed + i * 1.1)) * 0.6;
    const takeWin = l === 0 || (w > 0 && r < winsN / n);
    if (takeWin && w > 0) { out.push(avgW * jitter); w--; }
    else { out.push(-avgL * jitter); l--; }
  }
  return out;
}

// AI 추천: 최고 점수 전략
export function recommendStrategy(list: { id: string; name: string; score: StrategyScore }[]): { id: string; name: string; score: StrategyScore } | null {
  const eligible = list.filter(x => x.score.confidence >= 25);
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => b.score.score - a.score.score)[0];
}
