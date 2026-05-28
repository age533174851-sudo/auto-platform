// src/lib/autotrade/engine.ts
// 시그널 평가 엔진 — 가격 시계열에서 지표 계산 + 조건 매칭

import type { StrategyCondition } from '@/lib/strategies/types';
import type { IndicatorSnapshot, ConditionEvalResult } from './types';

// ─── 지표 계산 함수 ──────────────────────────────────────────

// RSI 14
export function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// EMA
export function calcEMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  // 첫 EMA는 SMA로 시작
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// SMA
export function calcSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

// 평균 거래량
export function calcVolumeAvg(volumes: number[], period = 20): number | null {
  if (volumes.length < period) return null;
  const slice = volumes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

// ─── 스냅샷 생성 ──────────────────────────────────────────────
export function buildSnapshot(closes: number[], volumes: number[]): IndicatorSnapshot {
  const current = closes[closes.length - 1];
  const prev    = closes[closes.length - 2];
  return {
    rsi:          calcRSI(closes, 14) ?? undefined,
    ema20:        calcEMA(closes, 20) ?? undefined,
    ema60:        calcEMA(closes, 60) ?? undefined,
    ema120:       calcEMA(closes, 120) ?? undefined,
    volume:       volumes[volumes.length - 1],
    volumeAvg:    calcVolumeAvg(volumes, 20) ?? undefined,
    priceChange:  prev > 0 ? ((current - prev) / prev) * 100 : 0,
    currentPrice: current,
  };
}

// ─── 단일 조건 평가 ──────────────────────────────────────────
export function evaluateCondition(
  cond: StrategyCondition,
  snap: IndicatorSnapshot,
): ConditionEvalResult {
  const { indicator, operator, value, signal } = cond;

  // RSI
  if (indicator === 'RSI') {
    const v = snap.rsi;
    if (v == null) return { indicator: 'RSI', pass: false, current: '데이터 없음', expected: String(value ?? '?') };
    const expected = typeof value === 'number' ? value : 30;
    const pass = checkComparison(v, operator, expected);
    return { indicator: 'RSI', pass, current: v.toFixed(1), expected: `${operator || '≤'} ${expected}` };
  }

  // EMA / SMA — 가격이 EMA 위/아래
  if (indicator === 'EMA' || indicator === 'SMA') {
    const period = cond.period ?? 20;
    const emaVal = period === 20 ? snap.ema20 : period === 60 ? snap.ema60 : snap.ema120;
    if (emaVal == null || snap.currentPrice == null) {
      return { indicator, pass: false, current: '데이터 없음', expected: '' };
    }
    // cross_above: 현재가가 EMA 위 (간단한 근사)
    let pass = false;
    if (operator === 'cross_above')      pass = snap.currentPrice > emaVal;
    else if (operator === 'cross_below') pass = snap.currentPrice < emaVal;
    else if (operator === '>')           pass = snap.currentPrice > emaVal;
    else if (operator === '<')           pass = snap.currentPrice < emaVal;
    else                                 pass = snap.currentPrice > emaVal;  // 기본
    return {
      indicator: `${indicator}${period}`,
      pass,
      current: `가격 ${snap.currentPrice.toFixed(2)}`,
      expected: `${operator || '>'} ${indicator}${period} ${emaVal.toFixed(2)}`,
    };
  }

  // MA_Cross — EMA20 vs EMA60 골든/데드 크로스 (스냅샷 비교)
  if (indicator === 'MA_Cross') {
    if (snap.ema20 == null || snap.ema60 == null) {
      return { indicator: 'MA_Cross', pass: false, current: '데이터 없음', expected: '' };
    }
    const isGolden = snap.ema20 > snap.ema60;
    const pass = signal === 'golden_cross' ? isGolden
              : signal === 'dead_cross'    ? !isGolden
              : false;
    return {
      indicator: 'MA Cross',
      pass,
      current: `EMA20 ${snap.ema20.toFixed(2)} vs EMA60 ${snap.ema60.toFixed(2)}`,
      expected: signal === 'golden_cross' ? '골든크로스' : '데드크로스',
    };
  }

  // Volume — 거래량 급증
  if (indicator === 'Volume') {
    if (snap.volume == null || snap.volumeAvg == null) {
      return { indicator: 'Volume', pass: false, current: '데이터 없음', expected: '' };
    }
    const ratio = snap.volume / snap.volumeAvg;
    let pass = false;
    if (operator === 'volume_surge') pass = ratio >= 2;
    else if (typeof value === 'number') pass = checkComparison(ratio, operator, value);
    else pass = ratio >= 1.5;
    return {
      indicator: 'Volume',
      pass,
      current: `${ratio.toFixed(2)}배`,
      expected: '평균 대비 ≥ 2배',
    };
  }

  // PriceChange — 가격 변동률 %
  if (indicator === 'PriceChange') {
    if (snap.priceChange == null) {
      return { indicator: 'PriceChange', pass: false, current: '데이터 없음', expected: '' };
    }
    const expected = typeof value === 'number' ? value : 5;
    const pass = checkComparison(snap.priceChange, operator, expected);
    return {
      indicator: 'PriceChange',
      pass,
      current: `${snap.priceChange.toFixed(2)}%`,
      expected: `${operator || '≥'} ${expected}%`,
    };
  }

  // 미지원 지표
  return {
    indicator,
    pass: false,
    current: '지원 안 됨',
    expected: '엔진이 곧 지원',
  };
}

function checkComparison(actual: number, op: string | undefined, expected: number): boolean {
  switch (op) {
    case '<=': return actual <= expected;
    case '<':  return actual <  expected;
    case '>=': return actual >= expected;
    case '>':  return actual >  expected;
    case '==': return Math.abs(actual - expected) < 0.001;
    default:   return actual <= expected;
  }
}

// ─── 전체 평가 (AND 결합) ──────────────────────────────────
export function evaluateAll(
  conditions: StrategyCondition[],
  snap: IndicatorSnapshot,
): { allPass: boolean; details: ConditionEvalResult[]; passCount: number } {
  const details = conditions.map(c => evaluateCondition(c, snap));
  const passCount = details.filter(d => d.pass).length;
  return {
    allPass: passCount === conditions.length && conditions.length > 0,
    details,
    passCount,
  };
}
