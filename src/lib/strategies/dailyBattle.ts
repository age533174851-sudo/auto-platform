// src/lib/strategies/dailyBattle.ts
// 1D 5v5 Daily Battle — 일봉 기반 하루 최대 1회 승부.
//
// 설계 원칙:
//  1. LONG/SHORT를 단순 이분법으로 두지 않고, 5개 독립 축에서 각각 점수를 낸다.
//     하나의 지표가 틀려도 전체 판단이 즉시 뒤집히지 않는다.
//  2. 점수 차이가 작으면 NO TRADE. "하루 1회"는 최대치지 의무가 아니다.
//  3. AI는 축별 점수만 산출하고, 진입가·손절·익절은 계산 엔진이 정한다.

import { evaluateVeto, type VetoInput, type VetoResult, type VetoRule } from './riskVeto';

export type BattleSide = 'LONG' | 'SHORT' | 'NO_TRADE';

export type AxisId = 'trend' | 'volume' | 'momentum' | 'derivatives' | 'macro';

export interface AxisScore {
  id: AxisId;
  label: string;
  longScore: number;    // 0~100
  shortScore: number;   // 0~100
  weight: number;       // 축 가중치 (합 1.0)
  rationale: string;    // 판단 근거 (설명 가능성)
}

export interface BattleInput {
  // 일봉 데이터
  dailyCloses: number[];        // 최근 종가 (최소 20개 권장)
  dailyVolumes?: number[];
  dailyHighs?: number[];
  dailyLows?: number[];
  // 보조 데이터 (없으면 중립 처리)
  fundingRate?: number;         // % (양수 = 롱 과열)
  openInterestChangePct?: number;
  // 파생 실데이터 분석 결과 (있으면 우선 사용)
  derivativesSignal?: {
    longConfirmation: number; shortConfirmation: number;
    patternLabel: string; crowdingNote: string; reliability: number;
  };
  fearGreed?: number;           // 0~100
  newsSentiment?: number;       // -100~100
}

export interface BattleResult {
  side: BattleSide;
  veto?: VetoResult;          // Veto에 걸리면 side는 NO_TRADE가 된다
  longTotal: number;            // 0~100
  shortTotal: number;
  margin: number;               // |long - short|
  minMarginRequired: number;
  confidence: number;           // 0~100
  axes: AxisScore[];
  reason: string;
  // 진입 파라미터 힌트 (실제 값은 riskManager가 확정)
  suggestedStopPct?: number;    // ATR 기반
  suggestedTpPct?: number;
}

// 점수 차이가 이보다 작으면 거래하지 않는다
// 5개 축을 가중평균하면 총점 편차가 크지 않다. 실측 결과:
//   최소 우위 10점 → 진입률 약 55%
//   최소 우위 15점 → 진입률 약 25%
//   최소 우위 20점 → 진입률 거의 0%
// 하루 최대 1회이므로 12점 정도가 "명확할 때만 진입"과 "기회를 놓치지 않음"의 균형점이다.
export const DEFAULT_MIN_MARGIN = 12;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return avg(values.slice(-period));
}

// 일봉 ATR% (손절 폭 산출용)
export function dailyAtrPct(highs: number[], lows: number[], closes: number[], period = 14): number {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n < 2) return 2;
  const trs: number[] = [];
  for (let i = Math.max(1, n - period); i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  const atr = avg(trs);
  const last = closes[n - 1] || 1;
  return clamp((atr / last) * 100, 0.3, 15);
}

// ── 축 1: 일봉 추세 ──
function axisTrend(input: BattleInput): AxisScore {
  const c = input.dailyCloses;
  const s5 = sma(c, 5), s20 = sma(c, 20);
  let longS = 50, shortS = 50, rationale = '데이터 부족 — 중립';

  if (s5 != null && s20 != null && c.length >= 20) {
    const spread = ((s5 - s20) / s20) * 100;
    // 스프레드 ±3%를 만점으로 스케일
    const bias = clamp(spread / 3, -1, 1);
    longS = clamp(50 + bias * 45, 5, 95);
    shortS = 100 - longS;
    rationale = spread > 0
      ? `5일선이 20일선 위 ${spread.toFixed(2)}% — 상승 추세`
      : `5일선이 20일선 아래 ${Math.abs(spread).toFixed(2)}% — 하락 추세`;
  }
  return { id: 'trend', label: '일봉 추세', longScore: longS, shortScore: shortS, weight: 0.25, rationale };
}

// ── 축 2: 거래량/수급 ──
function axisVolume(input: BattleInput): AxisScore {
  const v = input.dailyVolumes, c = input.dailyCloses;
  let longS = 50, shortS = 50, rationale = '거래량 데이터 없음 — 중립';

  if (v && v.length >= 10 && c.length >= 10) {
    const recentVol = avg(v.slice(-3));
    const baseVol = avg(v.slice(-10, -3)) || 1;
    const volRatio = recentVol / baseVol;
    const priceChg = ((c[c.length - 1] - c[c.length - 4]) / c[c.length - 4]) * 100;

    // 거래량 증가 + 상승 = 롱 우위 / 거래량 증가 + 하락 = 숏 우위
    const strength = clamp((volRatio - 1) * 2, -1, 1);
    const dir = priceChg >= 0 ? 1 : -1;
    const bias = strength * dir;
    longS = clamp(50 + bias * 40, 10, 90);
    shortS = 100 - longS;
    rationale = `최근 거래량 ${((volRatio - 1) * 100).toFixed(0)}% ${volRatio >= 1 ? '증가' : '감소'}, 가격 ${priceChg >= 0 ? '상승' : '하락'} ${Math.abs(priceChg).toFixed(1)}%`;
  }
  return { id: 'volume', label: '거래량·수급', longScore: longS, shortScore: shortS, weight: 0.2, rationale };
}

// ── 축 3: 모멘텀 ──
function axisMomentum(input: BattleInput): AxisScore {
  const c = input.dailyCloses;
  let longS = 50, shortS = 50, rationale = '데이터 부족 — 중립';

  if (c.length >= 15) {
    // RSI(14) 간이 계산
    let gains = 0, losses = 0;
    for (let i = c.length - 14; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    const rsi = 100 - 100 / (1 + rs);

    // 과매수(70+)는 숏 쪽, 과매도(30-)는 롱 쪽으로 역발상 반영하되
    // 40~60 구간은 추세 방향을 따른다
    if (rsi >= 70) { shortS = clamp(50 + (rsi - 70) * 1.5, 55, 85); longS = 100 - shortS; rationale = `RSI ${rsi.toFixed(0)} 과매수 — 조정 위험`; }
    else if (rsi <= 30) { longS = clamp(50 + (30 - rsi) * 1.5, 55, 85); shortS = 100 - longS; rationale = `RSI ${rsi.toFixed(0)} 과매도 — 반등 여지`; }
    else { const bias = (rsi - 50) / 20; longS = clamp(50 + bias * 25, 25, 75); shortS = 100 - longS; rationale = `RSI ${rsi.toFixed(0)} 중립 구간`; }
  }
  return { id: 'momentum', label: '모멘텀', longScore: longS, shortScore: shortS, weight: 0.2, rationale };
}

// ── 축 4: 파생시장 (펀딩비 + 미결제약정) ──
// 실데이터가 있으면 OI×가격 패턴 + 펀딩 쏠림을 함께 본다.
// 없으면 중립 처리하되, 그 사실을 근거에 남긴다.
function axisDerivatives(input: BattleInput): AxisScore {
  // 실데이터 분석 결과가 주입된 경우 우선 사용
  if (input.derivativesSignal) {
    const d = input.derivativesSignal;
    const parts = [d.patternLabel];
    if (d.crowdingNote) parts.push(d.crowdingNote);
    if (d.reliability < 70) parts.push(`신뢰도 ${d.reliability}%`);
    return {
      id: 'derivatives', label: '파생시장',
      longScore: d.longConfirmation, shortScore: d.shortConfirmation,
      weight: 0.2,
      rationale: parts.join(' · '),
    };
  }

  // 폴백: 펀딩비만 있는 경우
  let longS = 50;
  const parts: string[] = [];

  if (input.fundingRate != null) {
    const f = input.fundingRate;
    const bias = clamp(-f / 0.05, -1, 1);
    longS += bias * 20;
    parts.push(`펀딩비 ${f >= 0 ? '+' : ''}${f.toFixed(4)}% (${f > 0.01 ? '롱 과열' : f < -0.01 ? '숏 과열' : '정상'})`);
  }
  if (input.openInterestChangePct != null) {
    parts.push(`OI ${input.openInterestChangePct >= 0 ? '+' : ''}${input.openInterestChangePct.toFixed(1)}%`);
  }

  longS = clamp(longS, 15, 85);
  return {
    id: 'derivatives', label: '파생시장',
    longScore: longS, shortScore: 100 - longS, weight: 0.2,
    rationale: parts.length ? parts.join(' · ') : '파생 데이터 없음 — 중립 (실데이터 연결 시 판별력 향상)',
  };
}

// ── 축 5: 거시·심리·뉴스 ──
function axisMacro(input: BattleInput): AxisScore {
  let longS = 50;
  const parts: string[] = [];

  if (input.fearGreed != null) {
    const fg = input.fearGreed;
    // 역발상: 극단적 공포는 롱, 극단적 탐욕은 숏
    const bias = clamp((50 - fg) / 40, -1, 1);
    longS += bias * 22;
    parts.push(`F&G ${fg} (${fg <= 25 ? '극단적 공포' : fg >= 75 ? '극단적 탐욕' : '중립'})`);
  }
  if (input.newsSentiment != null) {
    const ns = input.newsSentiment;
    longS += clamp(ns / 100, -1, 1) * 15;
    parts.push(`뉴스 심리 ${ns >= 0 ? '+' : ''}${ns.toFixed(0)}`);
  }

  longS = clamp(longS, 15, 85);
  return {
    id: 'macro', label: '거시·심리·뉴스',
    longScore: longS, shortScore: 100 - longS, weight: 0.15,
    rationale: parts.length ? parts.join(' · ') : '거시 데이터 없음 — 중립',
  };
}

// ── 5v5 판정 ──
export function evaluateBattle(
  input: BattleInput,
  opts: { minMargin?: number; veto?: VetoInput; vetoRules?: VetoRule[] } = {}
): BattleResult {
  const axes = [axisTrend(input), axisVolume(input), axisMomentum(input), axisDerivatives(input), axisMacro(input)];
  const minMargin = opts.minMargin ?? DEFAULT_MIN_MARGIN;

  const longTotal = axes.reduce((a, x) => a + x.longScore * x.weight, 0);
  const shortTotal = axes.reduce((a, x) => a + x.shortScore * x.weight, 0);
  const margin = Math.abs(longTotal - shortTotal);

  let side: BattleSide;
  let reason: string;

  if (margin < minMargin) {
    side = 'NO_TRADE';
    reason = `점수 차이 ${margin.toFixed(0)}점이 최소 우위 ${minMargin}점 미만 — 오늘은 거래하지 않습니다 (LONG ${longTotal.toFixed(0)} : ${shortTotal.toFixed(0)} SHORT)`;
  } else {
    side = longTotal > shortTotal ? 'LONG' : 'SHORT';
    const winner = side === 'LONG' ? longTotal : shortTotal;
    const agreeing = axes.filter(a => (side === 'LONG' ? a.longScore > a.shortScore : a.shortScore > a.longScore)).length;
    reason = `${side} 우세 (${longTotal.toFixed(0)} : ${shortTotal.toFixed(0)}) · 5개 축 중 ${agreeing}개 동의 · 점수차 ${margin.toFixed(0)}점`;
  }

  // 손절/익절 힌트 — ATR 기반 (실제 확정은 riskManager)
  let suggestedStopPct: number | undefined, suggestedTpPct: number | undefined;
  if (side !== 'NO_TRADE' && input.dailyHighs && input.dailyLows) {
    const atr = dailyAtrPct(input.dailyHighs, input.dailyLows, input.dailyCloses);
    suggestedStopPct = clamp(atr * 0.8, 0.3, 8);
    suggestedTpPct = suggestedStopPct * 2.5;   // 손익비 1:2.5
  }

  // ── Risk Veto: 5축이 모두 같은 방향이어도 진입을 막을 수 있다 ──
  let veto: VetoResult | undefined;
  if (opts.veto) {
    veto = evaluateVeto(opts.veto, opts.vetoRules);
    if (veto.vetoed && side !== 'NO_TRADE') {
      reason = `${side} 우세(${longTotal.toFixed(0)}:${shortTotal.toFixed(0)})였으나 위험 조건으로 진입하지 않습니다 — ${veto.hits.map(h => h.label).join(', ')}`;
      side = 'NO_TRADE';
      suggestedStopPct = undefined;
      suggestedTpPct = undefined;
    }
  }

  return {
    side, veto, longTotal, shortTotal, margin, minMarginRequired: minMargin,
    confidence: side === 'NO_TRADE' ? 0 : clamp(50 + margin, 50, 95),
    axes, reason, suggestedStopPct, suggestedTpPct,
  };
}
