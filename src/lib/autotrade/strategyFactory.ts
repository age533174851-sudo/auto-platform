// src/lib/autotrade/strategyFactory.ts
// AI 전략 생성기(Strategy Factory) — AI가 기존 전략의 약점을 진단하고 개선안을 생성,
// Shadow Trading으로 검증한 뒤 기존보다 나을 때만 승격. AI가 마음대로 실전에 넣지 못한다.
// 흐름: 기존 전략 운영 → AI 개선안 생성 → Shadow 검증 → 성과 우위 시에만 승격.
import { computeMetrics } from './strategyScore';
import type { Regime } from './regime';
import type { LearningMatrix } from './learning';

export type ProposalStatus = 'proposed' | 'shadow' | 'promoted' | 'rejected';

export interface StrategyProposal {
  id: string;
  baseName: string;          // 원본 전략
  baseType: string;
  title: string;             // 개선안 이름
  hypothesis: string;        // AI의 개선 가설 (설명 가능성)
  change: { param: string; from: any; to: any; note: string };
  status: ProposalStatus;
  shadowDays: number;        // 섀도우 검증 경과일
  shadowTarget: number;      // 목표 검증일 (기본 14)
  // 검증 성과 (섀도우)
  baseMetrics?: { winRate: number; profitFactor: number; score: number };
  shadowMetrics?: { winRate: number; profitFactor: number; score: number };
  verdict?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 국면별 성과에서 약점을 찾아 개선안 생성.
// 예: "횡보장 Trend 승률 낮음 → 거래량/ADX 필터 추가"
export interface WeaknessInput {
  strategyId: string; name: string; type: string;
  params: Record<string, any>;
  regimeStats?: LearningMatrix;    // 국면별 성과 (learning)
  recentPnls?: number[];           // 최근 손익
}

const TYPE_FAMILY: Record<string, string> = {
  ema_cross: 'trend', breakout: 'breakout', rsi_reversal: 'meanrev', dca: 'dca', funding_rate: 'scalp', ai_strategy: 'trend', grid: 'grid',
};

const REGIME_LABEL: Record<string, string> = { TREND_UP: '상승 추세', TREND_DOWN: '하락 추세', RANGE: '횡보', VOLATILE: '고변동성' };

// 개선 규칙: 약점 패턴 → 파라미터 변경 제안
export function diagnoseAndPropose(input: WeaknessInput): StrategyProposal | null {
  const fam = TYPE_FAMILY[input.type] || 'trend';
  const stats = input.regimeStats;

  // 1) 국면별 최악 성과 셀 탐색
  let worst: { regime: Regime; winRate: number; trades: number } | null = null;
  if (stats) {
    for (const reg of Object.keys(stats) as Regime[]) {
      const cell = stats[reg]?.[fam as any];
      if (cell && cell.trades >= 3 && cell.winRate < 45) {
        if (!worst || cell.winRate < worst.winRate) worst = { regime: reg, winRate: cell.winRate, trades: cell.trades };
      }
    }
  }
  if (!worst) return null;   // 뚜렷한 약점 없으면 제안 안 함 (남발 방지)

  // 2) 약점 유형별 개선안
  let change: StrategyProposal['change'];
  let hypothesis: string;
  const regLabel = REGIME_LABEL[worst.regime] || worst.regime;

  if (fam === 'trend' && worst.regime === 'RANGE') {
    change = { param: 'vol_filter', from: input.params.vol_filter ?? false, to: true, note: '거래량 필터 추가 (거래량 증가 시에만 진입)' };
    hypothesis = `${regLabel}에서 ${input.name} 승률 ${worst.winRate.toFixed(0)}% — 거짓 돌파가 원인으로 추정. 거래량 필터를 추가하면 횡보장 휩쏘를 걸러 성과 개선이 기대됩니다.`;
  } else if (fam === 'trend') {
    change = { param: 'adx_min', from: input.params.adx_min ?? 0, to: 25, note: 'ADX 25 이상 필터 (추세 강도 확인)' };
    hypothesis = `${regLabel}에서 승률 ${worst.winRate.toFixed(0)}% — 약한 추세 진입이 원인. ADX 25 필터로 강한 추세만 진입하도록 개선합니다.`;
  } else if (fam === 'breakout') {
    change = { param: 'vol_mult', from: input.params.vol_mult ?? 1.5, to: 2.0, note: '돌파 거래량 배수 상향 (1.5→2.0)' };
    hypothesis = `${regLabel}에서 승률 ${worst.winRate.toFixed(0)}% — 약한 돌파에 속은 것으로 추정. 거래량 배수를 높여 진짜 돌파만 잡습니다.`;
  } else if (fam === 'meanrev') {
    change = { param: 'rsi_os', from: input.params.rsi_os ?? 30, to: 25, note: 'RSI 과매도 기준 강화 (30→25)' };
    hypothesis = `${regLabel}에서 승률 ${worst.winRate.toFixed(0)}% — 성급한 역추세 진입. RSI 기준을 강화해 극단에서만 진입합니다.`;
  } else {
    change = { param: 'cooldownMin', from: input.params.cooldownMin ?? 60, to: 120, note: '쿨다운 상향 (과매매 방지)' };
    hypothesis = `${regLabel}에서 승률 ${worst.winRate.toFixed(0)}% — 과매매 가능성. 쿨다운을 늘려 신호 품질을 높입니다.`;
  }

  return {
    id: 'prop_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    baseName: input.name, baseType: input.type,
    title: `${input.name} v2 (${change.note.split(' ')[0]} 추가)`,
    hypothesis, change,
    status: 'proposed', shadowDays: 0, shadowTarget: 14,
  };
}

// Shadow Trading 성과 갱신 — 원본 vs 개선안 병렬 성과 비교
export function updateShadow(p: StrategyProposal, basePnls: number[], shadowPnls: number[], daysPassed: number): StrategyProposal {
  const bm = computeMetrics(basePnls);
  const sm = computeMetrics(shadowPnls);
  const baseMetrics = { winRate: bm.winRate, profitFactor: bm.profitFactor, score: Math.round(bm.winRate * 0.5 + clamp(bm.profitFactor, 0, 3) / 3 * 50) };
  const shadowMetrics = { winRate: sm.winRate, profitFactor: sm.profitFactor, score: Math.round(sm.winRate * 0.5 + clamp(sm.profitFactor, 0, 3) / 3 * 50) };

  const shadowDays = clamp(daysPassed, 0, p.shadowTarget);
  let status: ProposalStatus = 'shadow';
  let verdict = `검증 ${shadowDays}/${p.shadowTarget}일 진행 중`;

  if (shadowDays >= p.shadowTarget) {
    // 검증 완료: 개선안이 유의미하게 우위일 때만 승격 (점수 +8 이상 AND PF 우위)
    const scoreGain = shadowMetrics.score - baseMetrics.score;
    const pfBetter = shadowMetrics.profitFactor >= baseMetrics.profitFactor + 0.15;
    const better = scoreGain >= 8 && pfBetter;
    if (better) { status = 'promoted'; verdict = `개선안 우위 (점수 ${baseMetrics.score}→${shadowMetrics.score}, PF ${baseMetrics.profitFactor.toFixed(2)}→${shadowMetrics.profitFactor.toFixed(2)}) — 승격 권장`; }
    else { status = 'rejected'; verdict = `개선 효과 부족 (점수 ${baseMetrics.score}→${shadowMetrics.score}) — 기존 유지`; }
  }

  return { ...p, status, shadowDays, baseMetrics, shadowMetrics, verdict };
}
