// src/lib/backtest/validation.ts
// 백테스트 결과 → 백테스트 자체의 품질 판정
// 과최적화 경고 + 종합 등급
//
// 중요: 이 파일 하나로 실전 승격을 허용하지 않는다.
// 단일 in-sample 백테스트는 walk-forward/OOS/PAPER 증거를 포함하지 않기 때문이다.

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
  // 30회는 "아무 말도 못 하는 구간을 벗어나는 최소선"일 뿐 충분한 검증이 아니다.
  if (r.totalTrades >= 200) { passed.push(`검증 표본 ${r.totalTrades}건`); score += 20; }
  else if (r.totalTrades >= 30) { warnings.push(`표본 제한 (${r.totalTrades}건) — 방향만 볼 수 있으며 200건 이상 권장`); score += 8; }
  else { fatal.push(`표본 너무 적음 (${r.totalTrades}건) — 통계 판단 불가`); }

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

  // 비현실적 수익률 (계산 버그/과최적화 의심)
  if (r.totalReturn > 1000) {
    fatal.push(`⚠️ 비현실적 수익률 (+${r.totalReturn.toFixed(0)}%) — 계산 오류 또는 과최적화 의심. 레버리지·포지션 가정 검증 필요`);
  }
  // 모순: 손익비 낮은데 수익률 높음 (포지션 사이징 버그 신호)
  if (r.profitFactor < 1 && r.totalReturn > 50) {
    fatal.push(`⚠️ 모순된 결과: 손익비 ${r.profitFactor.toFixed(2)}(손실형)인데 수익률 +${r.totalReturn.toFixed(0)}% — 포지션 크기 계산 의심`);
  }

  // ── 물리적으로 불가능한 값 = 계산 오류 (하드 자동 실패) ──
  const loseN = (r as any).loseTrades ?? 0;
  if (r.profitFactor > 50 && r.profitFactor < 900 && loseN > 0) {
    fatal.push(`⚠️ 손익비 비정상 (${r.profitFactor.toFixed(1)}) — 실제 전략에서 나올 수 없는 값, 계산 오류 의심`);
  }
  if (r.sharpeRatio > 10) {
    fatal.push(`⚠️ 샤프 지수 비정상 (${r.sharpeRatio.toFixed(1)}) — 10 초과는 계산 오류/과최적화. 실전 샤프는 통상 3 이하`);
  }
  if (r.maxDrawdown > 100) {
    fatal.push(`⚠️ 최대낙폭 ${r.maxDrawdown.toFixed(0)}% — 자산이 마이너스가 됨(불가능). 자산 계산 로직 오류`);
  }
  if (!isFinite(r.totalReturn) || !isFinite(r.profitFactor) || !isFinite(r.sharpeRatio)) {
    fatal.push('⚠️ 지표에 비정상 값(NaN/Infinity) — 계산 오류');
  }

  // ── 종합 등급 ──
  let grade: Grade, gradeLabel: string, gradeColor: string, recommendation: string;

  // 이 함수는 단일 백테스트만 본다. 따라서 점수가 아무리 높아도 여기서
  // LIVE 권한을 주지 않는다. 실전 승격은 OOS/walk-forward + 비용 스트레스
  // + PAPER/TESTNET 실체결 증거를 별도 게이트에서 확인해야 한다.
  const canGoLive = false;

  if (fatal.length > 0) {
    grade = 'unfit'; gradeLabel = '백테스트 부적합'; gradeColor = '#EF4444';
    recommendation = '치명적 문제가 있습니다. 전략 또는 계산 로직을 먼저 수정하세요.';
  } else if (score >= 80) {
    grade = 'excellent'; gradeLabel = '백테스트 우수'; gradeColor = '#10B981';
    recommendation = '단일 백테스트는 통과했습니다. Walk-forward/OOS → 비용 스트레스 → PAPER/TESTNET 검증 전에는 실전 승격하지 않습니다.';
  } else if (score >= 60) {
    grade = 'good'; gradeLabel = '백테스트 양호'; gradeColor = '#60A5FA';
    recommendation = '방향성은 확인됐지만 실전 근거는 아닙니다. OOS와 실제 체결 검증을 이어가세요.';
  } else {
    grade = 'caution'; gradeLabel = '백테스트 주의'; gradeColor = '#F59E0B';
    recommendation = '검증 강도가 부족합니다. 데이터 기간·표본·비용 반영을 보강하세요.';
  }

  return {
    grade, gradeLabel, gradeColor, score: Math.min(100, score),
    passed, warnings, fatal, recommendation, canGoLive,
  };
}
