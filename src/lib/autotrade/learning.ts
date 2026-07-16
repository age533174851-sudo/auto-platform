// src/lib/autotrade/learning.ts
// AI 자기학습 — 국면×전략별 과거 성과를 분석해 Tactical 비중을 교정.
// "지난주 횡보장에서 Trend 전략 손실 → 다음부터 횡보장 Trend 비중 축소"
// AI가 스스로 국면별 전략 가중치를 학습하는 구조 (TRAIGO의 최종 목표).
import type { Regime } from './regime';
import type { StrategyFamily } from './tactical';

const KEY = 'tg_regime_learning_v1';

// 국면 라벨(한글 marketState) → Regime 매핑
const STATE_TO_REGIME: Record<string, Regime> = {
  '강세': 'TREND_UP', '상승 추세': 'TREND_UP', 'TREND_UP': 'TREND_UP',
  '약세': 'TREND_DOWN', '하락 추세': 'TREND_DOWN', 'TREND_DOWN': 'TREND_DOWN',
  '횡보': 'RANGE', '박스권': 'RANGE', 'RANGE': 'RANGE',
  '고변동성': 'VOLATILE', 'VOLATILE': 'VOLATILE',
};

export interface LearnedTrade {
  regime: Regime;
  family: StrategyFamily;
  win: boolean;
  pnl: number;
}

export interface CellStat { trades: number; wins: number; winRate: number; totalPnl: number; adjust: number }
// 학습 결과: 국면별 × 전략별 성과 + 비중 조정 계수
export type LearningMatrix = Partial<Record<Regime, Partial<Record<StrategyFamily, CellStat>>>>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 국면×전략 성과 → 조정 계수(0.5~1.5). 승률/손익 좋으면 비중↑, 나쁘면↓
function computeAdjust(winRate: number, totalPnl: number, trades: number): number {
  if (trades < 3) return 1;   // 표본 부족 → 조정 없음
  // 승률 50% 기준 ±, 손익 부호 반영
  const wrFactor = (winRate - 50) / 100;         // -0.5 ~ +0.5
  const pnlFactor = totalPnl > 0 ? 0.15 : totalPnl < 0 ? -0.15 : 0;
  const conf = Math.min(1, trades / 10);          // 표본 신뢰도
  return clamp(1 + (wrFactor + pnlFactor) * conf, 0.5, 1.5);
}

export function buildLearningMatrix(trades: LearnedTrade[]): LearningMatrix {
  const matrix: LearningMatrix = {};
  for (const t of trades) {
    if (!matrix[t.regime]) matrix[t.regime] = {};
    const cell = matrix[t.regime]![t.family] || { trades: 0, wins: 0, winRate: 0, totalPnl: 0, adjust: 1 };
    cell.trades++;
    if (t.win) cell.wins++;
    cell.totalPnl += t.pnl;
    matrix[t.regime]![t.family] = cell;
  }
  // 승률·조정계수 산출
  for (const reg of Object.keys(matrix) as Regime[]) {
    for (const fam of Object.keys(matrix[reg]!) as StrategyFamily[]) {
      const c = matrix[reg]![fam]!;
      c.winRate = c.trades ? (c.wins / c.trades) * 100 : 0;
      c.adjust = computeAdjust(c.winRate, c.totalPnl, c.trades);
    }
  }
  return matrix;
}

// 학습된 조정계수를 저장/로드 (Tactical이 참조)
export function saveLearning(matrix: LearningMatrix) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(matrix)); } catch {}
}
export function loadLearning(): LearningMatrix {
  if (typeof window === 'undefined') return {};
  try { const r = window.localStorage.getItem(KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
}

// 특정 국면×전략의 학습된 조정계수 (Tactical이 비중 곱할 때 사용)
export function getAdjust(matrix: LearningMatrix, regime: Regime, family: StrategyFamily): number {
  return matrix[regime]?.[family]?.adjust ?? 1;
}

// 감사로그 + 거래결과를 LearnedTrade[]로 변환.
// 전략 type → family 매핑 (audit엔 marketState만 있어 근사)
const TYPE_TO_FAMILY: Record<string, StrategyFamily> = {
  ema_cross: 'trend', breakout: 'breakout', rsi_reversal: 'meanrev',
  funding_rate: 'scalp', dca: 'dca', ai_strategy: 'trend', grid: 'grid',
};

export function auditToLearnedTrades(
  audit: Array<{ marketState: string; asset?: string; ts: number; action: string; executed: boolean }>,
  closedTrades: Array<{ ts: number; symbol: string; realized: number }>,
  stratTypeByAsset?: Record<string, string>
): LearnedTrade[] {
  const out: LearnedTrade[] = [];
  for (const trade of closedTrades) {
    // 이 거래 이전의 가장 가까운 진입 판단(감사로그)에서 국면 추출
    const entry = audit
      .filter(a => a.action.startsWith('enter') && (!a.asset || a.asset === trade.symbol) && a.ts <= trade.ts)
      .sort((x, y) => y.ts - x.ts)[0];
    const regime = entry ? STATE_TO_REGIME[entry.marketState] : undefined;
    if (!regime) continue;
    const type = stratTypeByAsset?.[trade.symbol] || 'ema_cross';
    const family = TYPE_TO_FAMILY[type] || 'trend';
    out.push({ regime, family, win: trade.realized > 0, pnl: trade.realized });
  }
  return out;
}

// 학습 인사이트 생성 (사람이 읽는 설명)
export interface LearningInsight { regime: Regime; family: StrategyFamily; text: string; direction: 'up' | 'down' }

const FAMILY_LABEL: Record<string, string> = {
  trend: 'Trend Hunter', breakout: 'Breakout', meanrev: 'Mean Reversion', grid: 'Grid', scalp: 'Scalping', dca: 'DCA',
};
const REGIME_LABEL: Record<string, string> = { TREND_UP: '상승 추세', TREND_DOWN: '하락 추세', RANGE: '횡보', VOLATILE: '고변동성' };

export function extractInsights(matrix: LearningMatrix): LearningInsight[] {
  const insights: LearningInsight[] = [];
  for (const reg of Object.keys(matrix) as Regime[]) {
    for (const fam of Object.keys(matrix[reg]!) as StrategyFamily[]) {
      const c = matrix[reg]![fam]!;
      if (c.trades < 3) continue;
      if (c.adjust < 0.9) {
        insights.push({ regime: reg, family: fam, direction: 'down',
          text: `${REGIME_LABEL[reg]}에서 ${FAMILY_LABEL[fam]} 승률 ${c.winRate.toFixed(0)}% — 비중 ${Math.round((1 - c.adjust) * 100)}% 축소` });
      } else if (c.adjust > 1.1) {
        insights.push({ regime: reg, family: fam, direction: 'up',
          text: `${REGIME_LABEL[reg]}에서 ${FAMILY_LABEL[fam]} 승률 ${c.winRate.toFixed(0)}% — 비중 ${Math.round((c.adjust - 1) * 100)}% 확대` });
      }
    }
  }
  return insights.sort((a, b) => (a.direction === 'down' ? -1 : 1) - (b.direction === 'down' ? -1 : 1));
}
