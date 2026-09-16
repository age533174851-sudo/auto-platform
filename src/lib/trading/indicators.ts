// src/lib/trading/indicators.ts
//
// **토글만 있고 계산이 없는 지표를 만들지 않는다.**
//
// 거래소 화면을 흉내 내다 보면 MA·EMA·BOLL·SAR·SUPER를 다 켜 놓고 싶어진다.
// 그런데 버튼만 있고 선이 안 그려지거나, 대충 계산한 선이 그려지면
// **사용자는 그 선을 보고 진입한다.** 그건 없는 것보다 나쁘다.
//
// 그래서 이 파일에 있는 것만 화면에 노출한다. 여기 없으면 화면에도 없다.
//
// 처음부터 많이 만들지 않는다
// ───────────────────────────
// MA와 EMA 둘을 **정확히** 끝내고, 지표를 더할 수 있는 자리만 열어 둔다.
// 다섯 개를 반쯤 만드는 것보다 둘을 끝내는 편이 낫다.
//
// 앞부분을 0으로 채우지 않는다
// ────────────────────────────
// 20일 이동평균은 20번째 봉부터 값이 있다. 앞 19개를 0으로 채우면 차트
// 왼쪽 끝에서 선이 바닥으로 떨어지고, 그건 "그때 가격이 0이었다"로 읽힌다.
// **값이 없는 구간은 점을 만들지 않는다.**

import type { Candle } from './candleSeries';

export interface LinePoint {
  time: number;
  value: number;
}

/** 화면에 노출할 지표. **여기 없는 것은 없는 것이다.** */
export type IndicatorId = 'MA7' | 'MA25' | 'EMA12' | 'EMA26';

export interface IndicatorSpec {
  id: IndicatorId;
  label: string;
  kind: 'MA' | 'EMA';
  period: number;
  color: string;
}

export const INDICATORS: IndicatorSpec[] = [
  { id: 'MA7',   label: 'MA 7',   kind: 'MA',  period: 7,  color: '#F59E0B' },
  { id: 'MA25',  label: 'MA 25',  kind: 'MA',  period: 25, color: '#8B5CF6' },
  { id: 'EMA12', label: 'EMA 12', kind: 'EMA', period: 12, color: '#3B82F6' },
  { id: 'EMA26', label: 'EMA 26', kind: 'EMA', period: 26, color: '#EC4899' },
];

export function indicatorSpec(id: any): IndicatorSpec | null {
  return INDICATORS.find(s => s.id === id) ?? null;
}

/**
 * 단순이동평균.
 *
 * **기간이 안 찬 구간은 점이 없다.** 0으로 채우지 않는다.
 */
export function sma(candles: Candle[], period: number): LinePoint[] {
  const p = Math.floor(Number(period));
  if (!Array.isArray(candles) || !Number.isFinite(p) || p < 1) return [];
  if (candles.length < p) return [];

  const out: LinePoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = Number(candles[i]?.close);
    // 읽을 수 없는 봉이 섞이면 **그 구간의 평균을 만들지 않는다.**
    // 건너뛰고 창을 다시 채우면 창 안에 시간 구멍이 생긴 평균이 나온다.
    if (!Number.isFinite(c)) return out;
    sum += c;
    if (i >= p) sum -= Number(candles[i - p].close);
    if (i >= p - 1) out.push({ time: candles[i].time, value: sum / p });
  }
  return out;
}

/**
 * 지수이동평균.
 *
 * 첫 값은 **처음 `period`개의 단순평균**으로 시작한다(일반적인 정의).
 * 첫 종가 하나로 시작하면 초반 구간이 실제보다 가격에 붙어 그려진다.
 */
export function ema(candles: Candle[], period: number): LinePoint[] {
  const p = Math.floor(Number(period));
  if (!Array.isArray(candles) || !Number.isFinite(p) || p < 1) return [];
  if (candles.length < p) return [];

  const k = 2 / (p + 1);
  let seed = 0;
  for (let i = 0; i < p; i++) {
    const c = Number(candles[i]?.close);
    if (!Number.isFinite(c)) return [];
    seed += c;
  }
  let prev = seed / p;

  const out: LinePoint[] = [{ time: candles[p - 1].time, value: prev }];
  for (let i = p; i < candles.length; i++) {
    const c = Number(candles[i]?.close);
    if (!Number.isFinite(c)) return out;     // 읽을 수 없으면 거기서 끝낸다
    prev = c * k + prev * (1 - k);
    out.push({ time: candles[i].time, value: prev });
  }
  return out;
}

/**
 * 지표 하나를 계산한다. **모르는 지표는 빈 배열이다 — 지어내지 않는다.**
 */
export function computeIndicator(id: any, candles: Candle[]): LinePoint[] {
  const spec = indicatorSpec(id);
  if (!spec) return [];
  return spec.kind === 'MA' ? sma(candles, spec.period) : ema(candles, spec.period);
}

/**
 * 이 봉 수로 그 지표를 그릴 수 있는가.
 *
 * 화면이 **켤 수 있는 것만 켜도록** 하는 자리다. 못 그리는 지표를 켜 두면
 * 사용자는 켰는데 선이 없는 화면을 보고 고장이라고 읽는다.
 */
export function indicatorAvailable(id: any, candleCount: number): boolean {
  const spec = indicatorSpec(id);
  if (!spec) return false;
  const n = Number(candleCount);
  return Number.isFinite(n) && n >= spec.period;
}
