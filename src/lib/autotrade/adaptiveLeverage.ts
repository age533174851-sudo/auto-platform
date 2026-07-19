// src/lib/autotrade/adaptiveLeverage.ts
// AI 레버리지 자동조절 — 위원회 bias + 국면 + 변동성(ATR)을 종합해 0~5배로 조절.
// "항상 5배"가 아니라 "상황에 따라 0~5배". 리스크 관리하며 복리로 오래 살아남는 것이 목표.
// 위험한 시장 → 진입 안 함(0배). 청산당하면 복리도 없다.
import { detectRegime } from './regime';
import { computeATRPct } from './dynamicSizing';

export interface LeverageInput {
  prices: number[];
  committeeBias: number;      // -100~100
  consensus: number;         // 0~100
  maxLeverage?: number;      // 사용자가 정한 상한 (기본 5)
}

export interface LeverageResult {
  leverage: number;          // 최종 배율 (0~maxLeverage)
  marketGrade: '매우 좋음' | '좋음' | '보통' | '불확실' | '위험';
  gradeColor: string;
  atrPct: number;
  regime: string;
  regimeLabel: string;
  liquidationRiskPct: number;   // 대략적 청산까지 가격 여유 (%)
  reasons: string[];
  estMddPct: number;            // 이 배율에서 예상 MDD (근사)
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const REGIME_LABEL: Record<string, string> = { TREND_UP: '상승 추세', TREND_DOWN: '하락 추세', RANGE: '횡보', VOLATILE: '고변동성' };

export function computeAdaptiveLeverage(input: LeverageInput): LeverageResult {
  const maxLev = input.maxLeverage ?? 5;
  const r = detectRegime(input.prices);
  const atrPct = computeATRPct(input.prices);
  const reasons: string[] = [];

  // ── 1) 기본 배율: 위원회 bias 기반 ──
  // bias +60↑ → 공격, 0 근처 → 보통, 음수 → 축소
  let lev: number;
  if (input.committeeBias >= 50) { lev = maxLev; reasons.push(`위원회 강한 매수(+${input.committeeBias}) — 공격적`); }
  else if (input.committeeBias >= 25) { lev = maxLev * 0.6; reasons.push(`위원회 매수 우세(+${input.committeeBias})`); }
  else if (input.committeeBias >= -10) { lev = maxLev * 0.4; reasons.push(`위원회 중립(${input.committeeBias >= 0 ? '+' : ''}${input.committeeBias}) — 보수적`); }
  else if (input.committeeBias >= -30) { lev = maxLev * 0.2; reasons.push(`위원회 약세(${input.committeeBias}) — 최소 배율`); }
  else { lev = 0; reasons.push(`위원회 강한 매도(${input.committeeBias}) — 진입 보류`); }

  // ── 2) 국면 보정 ──
  if (r.regime === 'VOLATILE') { lev *= 0.4; reasons.push('고변동성 국면 — 배율 대폭 축소'); }
  else if (r.regime === 'TREND_DOWN') { lev *= 0.5; reasons.push('하락 추세 — 배율 축소'); }
  else if (r.regime === 'TREND_UP') { lev *= 1.0; reasons.push('상승 추세 — 배율 유지'); }
  else if (r.regime === 'RANGE') { lev *= 0.7; reasons.push('횡보 — 배율 소폭 축소'); }

  // ── 3) 변동성(ATR) 청산위험 보정 ──
  // ATR이 클수록 청산 위험 → 배율 강제 하향
  if (atrPct >= 7) { lev = Math.min(lev, 1); reasons.push(`변동성 극심(ATR ${atrPct.toFixed(1)}%) — 청산 위험, 1배 이하로 제한`); }
  else if (atrPct >= 4) { lev = Math.min(lev, 2); reasons.push(`변동성 높음(ATR ${atrPct.toFixed(1)}%) — 2배 이하로 제한`); }
  else if (atrPct >= 2) { lev *= 0.85; reasons.push(`변동성 보통(ATR ${atrPct.toFixed(1)}%)`); }
  else { reasons.push(`변동성 안정(ATR ${atrPct.toFixed(1)}%)`); }

  // ── 4) 합의 약하면 추가 보수화 ──
  if (input.consensus < 55) { lev *= 0.8; reasons.push(`위원회 합의 약함(${input.consensus}%) — 신중`); }

  // 최종 클램프 + 0.5 단위 반올림
  lev = clamp(lev, 0, maxLev);
  lev = Math.round(lev * 2) / 2;

  // 시장 등급
  let marketGrade: LeverageResult['marketGrade'], gradeColor: string;
  if (lev === 0) { marketGrade = '위험'; gradeColor = '#EF4444'; }
  else if (lev >= maxLev * 0.8) { marketGrade = '매우 좋음'; gradeColor = '#22C55E'; }
  else if (lev >= maxLev * 0.5) { marketGrade = '좋음'; gradeColor = '#4ADE80'; }
  else if (lev >= maxLev * 0.3) { marketGrade = '보통'; gradeColor = '#F59E0B'; }
  else { marketGrade = '불확실'; gradeColor = '#FB923C'; }

  // 청산까지 여유 (교차마진 근사: 100/leverage %가 대략 청산 거리)
  const liquidationRiskPct = lev > 0 ? 100 / lev : 100;
  // 예상 MDD ≈ 기초 변동성 × 배율 (근사, 네 예시 1배 -10%/2배 -20% 반영)
  const baseMdd = Math.max(10, atrPct * 3);
  const estMddPct = Math.round(baseMdd * lev * 0.5 + (lev > 0 ? baseMdd * 0.5 : 0));

  return {
    leverage: lev, marketGrade, gradeColor, atrPct, regime: r.regime, regimeLabel: REGIME_LABEL[r.regime] || r.regime,
    liquidationRiskPct: Math.round(liquidationRiskPct * 10) / 10, reasons,
    estMddPct: lev > 0 ? estMddPct : 0,
  };
}

// 배율별 시나리오 비교 (교육용 — "왜 낮은 배율이 나은가")
export function leverageScenarios(baseCagr: number, baseMdd: number): Array<{ lev: number; cagr: number; mdd: number; survives: boolean }> {
  return [1, 2, 3, 5, 10].map(lev => {
    const cagr = baseCagr * lev;
    const mdd = baseMdd * lev;
    // MDD가 -100% 이상이면 청산 (복리 불가)
    const survives = mdd < 90;
    return { lev, cagr: Math.round(cagr), mdd: Math.round(mdd), survives };
  });
}
