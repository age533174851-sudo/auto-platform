// src/lib/autotrade/tactical.ts
// AI Tactical (초단기) — 시장 국면 + 투자위원회 bias를 받아 전략 비중을 자동 조정.
// "상승 추세면 Trend Hunter 70%, 횡보면 Grid 60%" 처럼 국면에 맞는 전략에 자금을 몰아준다.
// AI는 매매하지 않는다 → 전략별 목표 비중만 산출.
import { detectRegime, type Regime } from './regime';

export type StrategyFamily = 'trend' | 'breakout' | 'meanrev' | 'grid' | 'scalp' | 'dca';

export interface FamilyInfo { key: StrategyFamily; label: string; color: string; desc: string }

export const FAMILIES: Record<StrategyFamily, FamilyInfo> = {
  trend:   { key: 'trend',   label: 'Trend Hunter', color: '#22C55E', desc: '추세 추종 (EMA·MACD)' },
  breakout:{ key: 'breakout',label: 'Breakout',     color: '#0EA5E9', desc: '돌파 매매 (볼린저·채널)' },
  meanrev: { key: 'meanrev', label: 'Mean Reversion',color: '#F59E0B', desc: '평균 회귀 (RSI 역추세)' },
  grid:    { key: 'grid',    label: 'Grid',          color: '#8B5CF6', desc: '격자 매매 (박스권 분할)' },
  scalp:   { key: 'scalp',   label: 'Scalping',      color: '#EC4899', desc: '초단타 (모멘텀)' },
  dca:     { key: 'dca',     label: 'DCA',           color: '#64748B', desc: '분할 매수 (방어)' },
};

// 국면별 기본 비중 프로파일 (합 100)
const REGIME_PROFILE: Record<Regime, Partial<Record<StrategyFamily, number>>> = {
  TREND_UP:   { trend: 55, breakout: 25, scalp: 12, dca: 8 },
  TREND_DOWN: { dca: 45, meanrev: 25, grid: 20, scalp: 10 },   // 하락: 방어·역추세 위주
  RANGE:      { grid: 45, meanrev: 35, scalp: 12, dca: 8 },
  VOLATILE:   { breakout: 35, dca: 35, scalp: 20, grid: 10 },
};

export interface TacticalWeight { family: StrategyFamily; label: string; color: string; desc: string; weightPct: number }

export interface TacticalResult {
  regime: Regime;
  regimeLabel: string;
  regimeColor: string;
  bias: number;                // 위원회 bias (-100~100)
  weights: TacticalWeight[];
  aggression: number;          // 공격성 0~100 (공격 전략 비중)
  rationale: string;
}

const REGIME_META: Record<Regime, { label: string; color: string }> = {
  TREND_UP: { label: '상승 추세', color: '#22C55E' },
  TREND_DOWN: { label: '하락 추세', color: '#EF4444' },
  RANGE: { label: '횡보', color: '#F59E0B' },
  VOLATILE: { label: '고변동성', color: '#8B5CF6' },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const AGGRESSIVE: StrategyFamily[] = ['trend', 'breakout', 'scalp'];
const DEFENSIVE: StrategyFamily[] = ['dca', 'grid', 'meanrev'];

export function computeTactical(prices: number[], committeeBias: number): TacticalResult {
  const r = detectRegime(prices);
  const profile = REGIME_PROFILE[r.regime];
  const meta = REGIME_META[r.regime];

  // 기본 비중 복사
  const raw: Partial<Record<StrategyFamily, number>> = { ...profile };

  // ── AI 자기학습 반영: 국면×전략 과거 성과로 비중 교정 ──
  if (typeof window !== 'undefined') {
    try {
      const { loadLearning, getAdjust } = require('./learning');
      const matrix = loadLearning();
      for (const fam of Object.keys(raw) as StrategyFamily[]) {
        const adj = getAdjust(matrix, r.regime, fam);
        if (adj !== 1 && raw[fam] != null) raw[fam] = (raw[fam] as number) * adj;
      }
    } catch {}
  }

  // 위원회 bias로 공격/방어 조정: 강세면 공격 전략 ↑, 약세면 방어 전략 ↑
  const b = clamp(committeeBias / 100, -1, 1);
  const tilt = b * 15;   // 최대 ±15%p 이동
  for (const fam of AGGRESSIVE) if (raw[fam] != null) raw[fam] = Math.max(0, (raw[fam] as number) + tilt / AGGRESSIVE.length * (raw[fam] ? 1 : 0));
  for (const fam of DEFENSIVE) if (raw[fam] != null) raw[fam] = Math.max(0, (raw[fam] as number) - tilt / DEFENSIVE.length * (raw[fam] ? 1 : 0));

  // 정규화 (합 100)
  const entries = Object.entries(raw).filter(([, v]) => (v as number) > 0) as [StrategyFamily, number][];
  const sum = entries.reduce((a, [, v]) => a + v, 0) || 1;
  let weights: TacticalWeight[] = entries.map(([fam, v]) => ({
    family: fam, label: FAMILIES[fam].label, color: FAMILIES[fam].color, desc: FAMILIES[fam].desc,
    weightPct: Math.round((v / sum) * 100),
  })).sort((a, b) => b.weightPct - a.weightPct);

  // 반올림 오차 보정
  const diff = 100 - weights.reduce((a, b) => a + b.weightPct, 0);
  if (weights.length && diff !== 0) weights[0].weightPct += diff;

  const aggression = weights.filter(w => AGGRESSIVE.includes(w.family)).reduce((a, b) => a + b.weightPct, 0);
  const top = weights[0];
  const rationale = `${meta.label} 국면 → ${top.label} ${top.weightPct}% 중심. ` +
    (committeeBias >= 25 ? `위원회 강세로 공격 전략 비중 상향(공격성 ${aggression}%).`
      : committeeBias <= -25 ? `위원회 약세로 방어 전략 비중 상향(공격성 ${aggression}%).`
        : `위원회 중립, 국면 기본 배분 유지.`);

  return { regime: r.regime, regimeLabel: meta.label, regimeColor: meta.color, bias: committeeBias, weights, aggression, rationale };
}
