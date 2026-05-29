// src/lib/backtest/validation.ts
// 백테스트 결과 → 실전 투입 적합도 판정
// 과최적화 경고 + 종합 등급

import type { BacktestResult } from './index';

export type Grade = 'excellent' | 'good' | 'caution' | 'unfit';

export interface ValidationResult {
  grade: Grade;
  gradeLabel: string;
  gradeColor: string;
  score: number;            // 0~100
  passed: string[];         // 통과 항목
  warnings: string[];       // 경고
  fatal: string[];          // 치명적 (실전 부적합)
  recommendation: string;
  canGoLive: boolean;
}

export function validateBacktest(r: BacktestResult): ValidationResult {
  const passed: string[] = [];
  const warnings: string[] = [];
  const fatal: string[] = [];
  let score = 0;

  // 1. 거래 횟수 (표본 크기) — 과최적화 핵심 판별
  if (r.totalTrades >= 30) { passed.push(`충분한 표본 (${r.totalTrades}건)`); score += 20; }
  else if (r.totalTrades >= 10) { warnings.push(`표본 부족 (${r.totalTrades}건) — 30건 이상 권장`); score += 8; }
  else { fatal.push(`표본 너무 적음 (${r.totalTrades}건) — 신뢰 불가, 과최적화 위험`); }

  // 2. 승률
  if (r.winRate >= 45) { passed.push(`승률 ${r.winRate}%`); score += 15; }
  else if (r.winRate >= 35) { warnings.push(`승률 낮음 (${r.winRate}%)`); score += 7; }
  else { warnings.push(`승률 매우 낮음 (${r.winRate}%)`); }

  // 3. 손익비 (Profit Factor)
  if (r.profitFactor >= 1.5) { passed.push(`손익비 우수 (${r.profitFactor.toFixed(2)})`); score += 20; }
  else if (r.profitFactor >= 1.1) { passed.push(`손익비 양호 (${r.profitFactor.toFixed(2)})`); score += 12; }
  else if (r.profitFactor >= 1.0) { warnings.push(`손익비 빠듯 (${r.profitFactor.toFixed(2)})`); score += 5; }
  else { fatal.push(`손익비 1 미만 (${r.profitFactor.toFixed(2)}) — 손실 전략`); }

  // 4. 최대 낙폭 (MDD)
  if (r.maxDrawdown <= 15) { passed.push(`낙폭 양호 (${r.maxDrawdown.toFixed(1)}%)`); score += 15; }
  else if (r.maxDrawdown <= 30) { warnings.push(`낙폭 다소 큼 (${r.maxDrawdown.toFixed(1)}%)`); score += 7; }
  else { fatal.push(`낙폭 과도 (${r.maxDrawdown.toFixed(1)}%) — 큰 손실 위험`); }

  // 5. 샤프 비율
  if (r.sharpeRatio >= 1.5) { passed.push(`샤프 우수 (${r.sharpeRatio.toFixed(2)})`); score += 15; }
  else if (r.sharpeRatio >= 0.8) { passed.push(`샤프 양호 (${r.sharpeRatio.toFixed(2)})`); score += 9; }
  else if (r.sharpeRatio >= 0) { warnings.push(`샤프 낮음 (${r.sharpeRatio.toFixed(2)})`); score += 3; }
  else { warnings.push(`샤프 음수 (${r.sharpeRatio.toFixed(2)})`); }

  // 6. 총수익
  if (r.totalReturn > 0) { passed.push(`수익 (+${r.totalReturn.toFixed(1)}%)`); score += 15; }
  else { fatal.push(`백테스트 손실 (${r.totalReturn.toFixed(1)}%)`); }

  // 과최적화 의심: 승률 매우 높은데 표본 적음
  if (r.winRate >= 80 && r.totalTrades < 20) {
    warnings.push('⚠️ 과최적화 의심: 높은 승률 + 적은 표본 (실전 성과 다를 수 있음)');
  }

  // ── 종합 등급 ──
  let grade: Grade, gradeLabel: string, gradeColor: string, recommendation: string;
  const canGoLive = fatal.length === 0 && score >= 55;

  if (fatal.length > 0) {
    grade = 'unfit'; gradeLabel = '실전 부적합'; gradeColor = '#EF4444';
    recommendation = '치명적 문제가 있어 실전 투입을 권장하지 않습니다. 전략을 수정하세요.';
  } else if (score >= 80) {
    grade = 'excellent'; gradeLabel = '우수'; gradeColor = '#10B981';
    recommendation = '실전 적합. 그래도 소액 + 모의매매 7일 검증 후 투입을 권장합니다.';
  } else if (score >= 60) {
    grade = 'good'; gradeLabel = '양호'; gradeColor = '#60A5FA';
    recommendation = '실전 가능하나 모의매매로 추가 검증 후 소액부터 시작하세요.';
  } else {
    grade = 'caution'; gradeLabel = '주의'; gradeColor = '#F59E0B';
    recommendation = '개선 여지가 있습니다. 모의매매로 충분히 검증한 뒤 결정하세요.';
  }

  return {
    grade, gradeLabel, gradeColor, score: Math.min(100, score),
    passed, warnings, fatal, recommendation, canGoLive,
  };
}
