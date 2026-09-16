// src/lib/trading/candleSeries.ts
//
// **차트에 그릴 봉을 만든다 — 없는 봉은 만들지 않는다.**
//
// 무엇을 막는가
// ─────────────
// 실시간 차트에서 제일 쉽게 나는 거짓말이 이것이다:
//
//   ① 현재가가 오면 **다음 봉을 미리 만들어** 붙인다 → 아직 열리지도 않은
//      시간대의 봉이 화면에 있다. 사용자는 그걸 보고 진입한다
//   ② 시세가 안 오는 동안 **이전 봉을 복제해** 이어 붙인다 → 거래가 없는
//      구간이 활발한 구간처럼 보인다
//   ③ 이미 **닫힌 봉의 종가를 현재가로 덮는다** → 과거가 바뀐다
//
// 셋 다 화면은 자연스러워 보이고, 셋 다 거짓이다. 그래서 이 파일은
// **관측된 값으로만** 봉을 움직인다:
//
//   · 닫힌 봉      venue가 준 값 그대로. 절대 고치지 않는다
//   · 진행 중 봉   venue가 준 그 봉에, **실제로 관측된 체결가**만 반영한다
//                  (고가는 넘을 때만 올리고, 저가는 밑돌 때만 내린다)
//   · 다음 봉      **만들지 않는다.** venue가 줄 때까지 기다린다
//
// 간격을 바꿀 때
// ──────────────
// 1분 차트를 보다가 1시간으로 바꾸면 요청이 두 개 떠 있는 상태가 된다.
// 먼저 보낸 1분 응답이 **나중에** 도착하면 1시간 차트에 1분 봉이 박힌다.
// 축은 그럴듯하고 아무도 오류를 못 본다.
//
// 그래서 요청마다 세대 번호를 붙이고, **지금 세대가 아닌 응답은 버린다.**
// 판정을 여기 순수 함수로 둔 이유는 컴포넌트 안에 두면 시험할 수 없어서다.

/** 차트 한 줄. lightweight-charts가 받는 모양과 같다 (time은 **초**다). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VolumeBar {
  time: number;
  value: number;
  /** 양봉·음봉 색. 화면이 고르지 않고 여기서 정한다 */
  color: string;
}

/** `fetchVenueBars`가 주는 모양 (그 모듈에 의존하지 않으려고 다시 적는다). */
export interface RawBars {
  opens: number[];
  highs: number[];
  lows: number[];
  closes: number[];
  volumes: number[];
  openTimes: number[];
}

function ok(...v: number[]): boolean {
  return v.every(x => typeof x === 'number' && Number.isFinite(x));
}

/**
 * venue 봉 → 차트 봉.
 *
 * **읽을 수 없는 줄은 버린다.** 0으로 채우면 차트에 바닥을 찍는 봉이 생기고,
 * 그건 실제로 그 가격에 거래가 있었다는 말이 된다.
 *
 * 시각은 **초**로 준다 — lightweight-charts의 `UTCTimestamp`가 초 단위다.
 * 밀리초를 그대로 주면 축이 5만 년 뒤로 간다.
 */
export function barsToCandles(bars: RawBars | null | undefined): Candle[] {
  if (!bars || !Array.isArray(bars.openTimes)) return [];
  const out: Candle[] = [];
  const n = bars.openTimes.length;
  for (let i = 0; i < n; i++) {
    const t = Number(bars.openTimes[i]);
    const o = Number(bars.opens?.[i]);
    const h = Number(bars.highs?.[i]);
    const l = Number(bars.lows?.[i]);
    const c = Number(bars.closes?.[i]);
    if (!ok(t, o, h, l, c) || t <= 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    out.push({ time: Math.floor(t / 1000), open: o, high: h, low: l, close: c });
  }
  // 차트는 시간순을 요구한다. venue가 뒤집어 줘도 여기서 맞춘다.
  out.sort((a, b) => a.time - b.time);
  return out;
}

export const UP_COLOR = 'rgba(16,185,129,0.5)';
export const DOWN_COLOR = 'rgba(239,68,68,0.5)';

/** 거래량 막대. 봉의 방향으로 색을 정한다 — 거래량만으로는 방향을 알 수 없다. */
export function barsToVolumes(bars: RawBars | null | undefined): VolumeBar[] {
  const candles = barsToCandles(bars);
  if (!candles.length || !bars) return [];
  const byTime = new Map<number, number>();
  const n = bars.openTimes?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const t = Math.floor(Number(bars.openTimes[i]) / 1000);
    const v = Number(bars.volumes?.[i]);
    if (Number.isFinite(t) && Number.isFinite(v) && v >= 0) byTime.set(t, v);
  }
  const out: VolumeBar[] = [];
  for (const c of candles) {
    const v = byTime.get(c.time);
    // **거래량을 못 읽은 봉은 막대를 그리지 않는다.** 0을 그리면 "거래가
    // 없었다"가 되고, 그건 확인된 사실이 아니다.
    if (v == null) continue;
    out.push({ time: c.time, value: v, color: c.close >= c.open ? UP_COLOR : DOWN_COLOR });
  }
  return out;
}

/**
 * 진행 중인 봉에 **관측된 체결가**를 반영한다.
 *
 * 규칙 셋:
 *   · 고가는 **넘을 때만** 올린다 — 내리면 실제로 닿았던 가격이 지워진다
 *   · 저가는 **밑돌 때만** 내린다
 *   · 시가는 **절대 건드리지 않는다** — venue가 정한 값이다
 *
 * 값을 못 읽으면 **원래 봉을 그대로 돌려준다.** 새 봉을 만들지 않는다.
 */
export function applyLivePrice(candle: Candle | null | undefined, price: any): Candle | null {
  if (!candle) return null;
  const p = price == null || price === '' ? NaN : Number(price);
  if (!Number.isFinite(p) || p <= 0) return candle;
  return {
    time: candle.time,
    open: candle.open,                       // ★ 건드리지 않는다
    high: Math.max(candle.high, p),          // ★ 넘을 때만
    low: Math.min(candle.low, p),            // ★ 밑돌 때만
    close: p,
  };
}

/**
 * 마지막 봉에만 현재가를 반영한 목록.
 *
 * **다음 봉을 만들지 않는다.** 현재 시각이 이미 다음 구간으로 넘어갔더라도
 * venue가 그 봉을 줄 때까지 기다린다 — 여기서 만들면 그건 우리가 지어낸
 * 봉이다.
 */
export function withLivePrice(candles: Candle[], price: any): Candle[] {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const last = candles[candles.length - 1];
  const updated = applyLivePrice(last, price);
  if (!updated || updated === last) return candles;
  return [...candles.slice(0, -1), updated];
}

// ══════════════ 간격을 바꿀 때 ══════════════

/**
 * 이 응답을 받아들여도 되는가.
 *
 * **지금 세대가 아니면 버린다.** 1분 요청의 늦은 응답이 1시간 차트에
 * 박히는 것을 막는 유일한 장치다 — 봉 모양만 보고는 구별할 수 없다.
 */
export function isFreshResponse(responseGeneration: number, currentGeneration: number): boolean {
  return Number.isFinite(responseGeneration)
    && Number.isFinite(currentGeneration)
    && responseGeneration === currentGeneration;
}

/**
 * 이 봉들이 그 간격의 것인가 — **연속한 두 봉의 간격으로 확인한다.**
 *
 * 세대 번호는 우리 쪽 실수를 막지만, venue가 엉뚱한 간격을 줬을 때는
 * 아무 말도 하지 않는다. 데이터 자체를 한 번 더 본다.
 *
 * 봉이 하나뿐이면 **판단하지 않는다**(`null`) — 모르는 것을 통과로도
 * 거부로도 적지 않는다.
 */
export function candlesMatchInterval(
  candles: Candle[], expectedMs: number | null | undefined,
): boolean | null {
  const want = Number(expectedMs);
  if (!Number.isFinite(want) || want <= 0) return null;
  if (!Array.isArray(candles) || candles.length < 2) return null;
  // 가장 흔한 간격을 본다. 거래소 점검으로 빈 구간이 있어도 흔들리지 않는다.
  const gaps = new Map<number, number>();
  for (let i = 1; i < candles.length; i++) {
    const g = (candles[i].time - candles[i - 1].time) * 1000;
    if (g > 0) gaps.set(g, (gaps.get(g) ?? 0) + 1);
  }
  if (!gaps.size) return null;
  let best = 0, bestN = 0;
  for (const [g, n] of gaps) if (n > bestN) { best = g; bestN = n; }
  return best === want;
}
