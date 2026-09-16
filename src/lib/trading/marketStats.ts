// src/lib/trading/marketStats.ts
//
// 24시간 통계 줄(고가·저가·거래량·변동률)을 **글자로 바꾸는 일만** 한다.
//
// 값을 만들지 않는다
// ──────────────────
// 여기에는 계산이 없다. 못 읽은 값(null)은 `—`로 적고, 절대 0으로 적지
// 않는다. 화면에 `24h 저가 0`이 떠 있으면 사용자는 그걸 시장 사실로
// 읽는다. "UNKNOWN을 0으로 적지 않는다"가 표시 계층에서도 그대로다.

/** 못 읽은 값의 표시. 0이 아니다. */
export const UNKNOWN_TEXT = '—';

/**
 * 가격 소수 자릿수를 크기로 정한다.
 *
 * 65000.12345를 5자리로 적으면 읽을 수 없고, 0.00001234를 2자리로 적으면
 * 0.00이 된다 — 후자는 "값이 0"으로 오해된다.
 */
export function priceDigits(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v)) return 2;
  const a = Math.abs(v);
  if (a === 0) return 2;
  if (a >= 1000) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 5;
  return 8;
}

/** 가격 한 칸. 못 읽으면 `—`. */
export function fmtStatPrice(v: number | null | undefined, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return UNKNOWN_TEXT;
  const d = digits ?? priceDigits(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * 거래량을 짧게. 1.23B / 45.6M / 789.0K.
 *
 * 축약은 **표시 전용**이다. 이 문자열이 주문 수량이나 계산으로 돌아가는
 * 경로는 없다 — 되돌리는 함수를 만들지 않는 이유가 그것이다.
 */
export function fmtCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return UNKNOWN_TEXT;
  const neg = v < 0;
  const a = Math.abs(v);
  const pick = (): string => {
    if (a >= 1e12) return `${(a / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${(a / 1e3).toFixed(2)}K`;
    return a.toLocaleString('en-US', { maximumFractionDigits: 2 });
  };
  return (neg ? '-' : '') + pick();
}

/** 변동률. 0%는 못 읽음이 아니므로 `+0.00%`로 적는다. */
export function fmtChangePct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return UNKNOWN_TEXT;
  const sign = v > 0 ? '+' : v < 0 ? '' : '+';
  return `${sign}${v.toFixed(2)}%`;
}

export type StatTone = 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';

/** 색을 정하는 판단. 못 읽은 값은 오름도 내림도 아니다. */
export function changeTone(v: number | null | undefined): StatTone {
  if (v == null || !Number.isFinite(v)) return 'UNKNOWN';
  return v > 0 ? 'UP' : v < 0 ? 'DOWN' : 'FLAT';
}

export interface StatCell {
  label: string;
  text: string;
  /** 못 읽은 칸인가. 화면이 이걸 흐리게 표시할 수 있게 넘긴다 */
  unknown: boolean;
}

export interface MarketStatsInput {
  market: 'SPOT' | 'USDM' | null;
  markPrice: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  quoteVolume24h: number | null;
  /** 상대통화 표시명. 보통 'USDT' */
  quoteAsset?: string;
}

/**
 * 헤더에 들어갈 칸 목록.
 *
 * **현물에는 마크가격 칸을 만들지 않는다.** 빈 칸을 두고 `—`를 적으면
 * "지금 못 받았다"처럼 보이지만, 현물의 마크가격은 앞으로도 오지 않는다.
 * 없는 개념과 못 받은 값은 다르게 보여야 한다.
 */
export function marketStatCells(i: MarketStatsInput): StatCell[] {
  const quote = i.quoteAsset || 'USDT';
  const cells: StatCell[] = [];
  if (i.market === 'USDM') {
    cells.push({
      label: 'Mark', text: fmtStatPrice(i.markPrice), unknown: i.markPrice == null,
    });
  }
  cells.push({ label: '24h High', text: fmtStatPrice(i.high24h), unknown: i.high24h == null });
  cells.push({ label: '24h Low', text: fmtStatPrice(i.low24h), unknown: i.low24h == null });
  cells.push({
    label: `24h Vol(${quote})`,
    text: fmtCompact(i.quoteVolume24h),
    unknown: i.quoteVolume24h == null,
  });
  return cells;
}
