// src/lib/autotrade/metaStrategy.ts
// AI Meta Strategy — 전략 점수 기반 자동 교체 + 자금 배분(전략 포트폴리오).
// "최근 승률 41%로 떨어진 전략 자동 OFF → 68%인 전략 자동 ON"
// 기관 방식: 전략 하나를 믿지 않고, 성과에 따라 자금을 재배분.
import { scoreStrategy, tradesFromSummary, computeMetrics, type StrategyScore } from './strategyScore';

export interface MetaInput {
  id: string; name: string; enabled: boolean;
  winRate: number; totalPnl: number; trades: number;
  pnls?: number[];   // 실거래 손익열 (있으면 우선)
}

export type MetaAction = 'auto_off' | 'auto_on' | 'keep';

export interface MetaDecision {
  id: string; name: string;
  action: MetaAction;
  score: StrategyScore;
  recentWR: number;      // 최근 승률 (최근 10~50회)
  reason: string;
}

export interface MetaResult {
  decisions: MetaDecision[];
  offCount: number;
  onCount: number;
  summary: string;
}

// 임계값: OFF = 점수<40 또는 최근승률<42 (신뢰도 충분 시), ON = 점수≥65 & 최근승률≥55
const OFF_SCORE = 40, OFF_RECENT_WR = 42, ON_SCORE = 65, ON_RECENT_WR = 55, MIN_CONF = 40;

export function evaluateMeta(strats: MetaInput[]): MetaResult {
  const decisions: MetaDecision[] = strats.map(s => {
    const pnls = s.pnls && s.pnls.length ? s.pnls : tradesFromSummary(s);
    const score = scoreStrategy(pnls);
    const m = computeMetrics(pnls);
    const recentWR = m.recentWR;

    let action: MetaAction = 'keep';
    let reason = '현재 상태 유지';

    if (score.confidence < MIN_CONF) {
      reason = `표본 부족(신뢰도 ${score.confidence}%) — 자동 전환 보류`;
    } else if (s.enabled && (score.score < OFF_SCORE || recentWR < OFF_RECENT_WR)) {
      action = 'auto_off';
      reason = recentWR < OFF_RECENT_WR
        ? `최근 승률 ${recentWR.toFixed(0)}%로 하락 (기준 ${OFF_RECENT_WR}%) — 자동 OFF`
        : `종합 점수 ${score.score}점 (기준 ${OFF_SCORE}) — 자동 OFF`;
    } else if (!s.enabled && score.score >= ON_SCORE && recentWR >= ON_RECENT_WR) {
      action = 'auto_on';
      reason = `점수 ${score.score}점 · 최근 승률 ${recentWR.toFixed(0)}% — 자동 ON 후보`;
    } else if (s.enabled) {
      reason = `점수 ${score.score}점 · 최근 승률 ${recentWR.toFixed(0)}% — 정상 가동`;
    } else {
      reason = `점수 ${score.score}점 — ON 기준(${ON_SCORE}점·승률${ON_RECENT_WR}%) 미달`;
    }
    return { id: s.id, name: s.name, action, score, recentWR, reason };
  });

  const offCount = decisions.filter(d => d.action === 'auto_off').length;
  const onCount = decisions.filter(d => d.action === 'auto_on').length;
  const summary = offCount || onCount
    ? `교체 제안: ${offCount}개 OFF · ${onCount}개 ON`
    : '모든 전략이 적정 상태입니다';
  return { decisions, offCount, onCount, summary };
}

// ── 전략 포트폴리오: 점수 비례 자금 배분 ─────────────────────
export interface Allocation { id: string; name: string; weightPct: number; score: number }

export function allocateCapital(
  decisions: MetaDecision[],
  opts: { minPct?: number; maxPct?: number } = {}
): Allocation[] {
  const minPct = opts.minPct ?? 5, maxPct = opts.maxPct ?? 60;
  // 배분 대상: keep(enabled 유지) + auto_on 후보, 점수 50 초과분에 비례
  const eligible = decisions.filter(d => d.action !== 'auto_off' && d.score.confidence >= MIN_CONF && d.score.score > 50);
  if (!eligible.length) return [];
  const raws = eligible.map(d => ({ d, w: d.score.score - 50 }));
  const total = raws.reduce((a, b) => a + b.w, 0);
  let allocs = raws.map(({ d, w }) => ({
    id: d.id, name: d.name, score: d.score.score,
    weightPct: (w / total) * 100,
  }));
  // min/max 캡 적용 후 재정규화
  allocs = allocs.map(a => ({ ...a, weightPct: Math.max(minPct, Math.min(maxPct, a.weightPct)) }));
  const sum = allocs.reduce((a, b) => a + b.weightPct, 0);
  allocs = allocs.map(a => ({ ...a, weightPct: Math.round((a.weightPct / sum) * 100) }));
  // 반올림 오차 보정 (최대 비중에 흡수)
  const diff = 100 - allocs.reduce((a, b) => a + b.weightPct, 0);
  if (allocs.length && diff !== 0) allocs.sort((a, b) => b.weightPct - a.weightPct)[0].weightPct += diff;
  return allocs.sort((a, b) => b.weightPct - a.weightPct);
}
