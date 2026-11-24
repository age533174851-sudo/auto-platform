// src/lib/risk/bars.ts
//
// **버리던 고가·저가·거래량을 살린다.**
//
// 무엇이 문제였나
// ───────────────
// `regimeCheck.fetchDailyCloses`는 바이낸스에서 봉을 받아 놓고 **종가
// 하나만** 꺼냈다:
//
//   .map(k => parseFloat(k[4]))      // k[4] = 종가
//
// 바이낸스가 주는 한 봉은 이렇다:
//
//   [ 0 열린시각, 1 시가, 2 고가, 3 저가, 4 종가, 5 거래량, 6 닫힌시각, ... ]
//
// 고가·저가·거래량은 **이미 내려와 있었다.** 같은 요청, 같은 바이트다.
// 그걸 버렸기 때문에 오더블록·FVG·유동성 사냥·거래량 확인 돌파를 **쓸 수가
// 없었다.** 전략이 세 개뿐이었던 이유는 알고리즘이 모자라서가 아니라
// 재료가 없어서다.
//
// 모르는 봉은 버린다, 채우지 않는다
// ─────────────────────────────────
// 값 하나가 비거나 숫자가 아니면 그 봉을 **버린다.** 0으로 채우면
// "저가 0"이 되어 모든 하향 돌파가 발동하고, 앞 봉 값으로 채우면 없는
// 움직임을 지어내는 것이다. 하나도 못 읽으면 `null`이다 — 빈 배열이
// 아니다. 빈 배열은 "읽었는데 봉이 없다"로 읽히고, 그건 사실이 아니다.
//
// 어디까지만 하는가
// ─────────────────
// 이 파일은 **모양만** 본다. 무엇이 신호인가는 `engine/entrySignals.ts`가
// 정한다. 여기에 판단을 넣으면 같은 판단이 두 곳에 생긴다.

/** 봉 하나. 모든 값이 유한한 수이고 고가 >= 저가다 */
export interface Bar {
  /** 봉이 열린 시각(ms) */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 거래량. 0일 수 있다 — 0은 "없음"이 아니라 "안 거래됨"이다 */
  volume: number;
}

const fin = (v: unknown): number | null => {
  if (v == null || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 바이낸스 kline 응답을 봉으로 읽는다.
 *
 * **못 읽은 봉은 버리고, 하나도 못 읽으면 null이다.** 가격이 0 이하인 봉도
 * 버린다 — 거래소가 그런 값을 줄 일은 없고, 왔다면 그건 우리가 응답 모양을
 * 잘못 읽고 있다는 뜻이다.
 */
export function parseKlines(raw: unknown): Bar[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const bars: Bar[] = [];
  for (const k of raw) {
    if (!Array.isArray(k) || k.length < 6) continue;
    const openTime = fin(k[0]);
    const open = fin(k[1]), high = fin(k[2]), low = fin(k[3]), close = fin(k[4]);
    const volume = fin(k[5]);
    if (openTime == null || open == null || high == null || low == null
      || close == null || volume == null) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    // 고가가 저가보다 낮은 봉은 모양이 깨진 것이다. 고쳐서 쓰지 않는다.
    if (high < low) continue;
    // 종가·시가가 고저 범위를 벗어난 봉도 같다.
    if (close > high || close < low || open > high || open < low) continue;
    bars.push({ openTime, open, high, low, close, volume });
  }
  return bars.length ? bars : null;
}

/** 종가만 뽑는다. 기존 판정이 쓰던 모양 그대로 */
export function closesOf(bars: Bar[] | null | undefined): number[] | null {
  if (!bars || bars.length === 0) return null;
  const closes = bars.map(b => b.close);
  return closes.length ? closes : null;
}

/**
 * 마지막 봉을 뺀 **직전 n개**의 평균 거래량.
 *
 * 마지막 봉을 빼는 이유: 지금 봉의 거래량을 평균에 넣으면 큰 거래량이
 * 자기 자신의 기준을 끌어올려 **자기 신호를 약하게 만든다.**
 * 비교 대상이 모자라면 null이다 — 적은 표본으로 "평소보다 많다"를
 * 말하지 않는다.
 */
export function priorAvgVolume(bars: Bar[] | null | undefined, n: number): number | null {
  if (!bars || !Number.isFinite(n) || n < 1) return null;
  const prior = bars.slice(0, -1);
  if (prior.length < n) return null;
  const window = prior.slice(-n);
  const sum = window.reduce((a, b) => a + b.volume, 0);
  const avg = sum / window.length;
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}

/** 마지막 봉. 없으면 null */
export function lastBar(bars: Bar[] | null | undefined): Bar | null {
  return bars && bars.length ? bars[bars.length - 1] : null;
}

/** 위꼬리/아래꼬리를 뺀 몸통 범위. 시가=종가면 폭 0인 구간이다 */
export function body(b: Bar): { lo: number; hi: number } {
  return b.close >= b.open ? { lo: b.open, hi: b.close } : { lo: b.close, hi: b.open };
}

/** 가격이 [lo, hi] 안에 있는가. 경계 포함 */
export function inZone(price: number, lo: number, hi: number): boolean {
  return Number.isFinite(price) && Number.isFinite(lo) && Number.isFinite(hi)
    && hi >= lo && price >= lo && price <= hi;
}

// ══════════════════════════════════════════════════════════════════
//  봉 주기
//
//  전략 일곱 개가 **일봉 하나에 묶여** 있었다. 받아오는 주소에
//  `interval=1d`가 글자로 박혀 있었기 때문이다
//  (`regimeCheck.ts`). 스캘핑과 스윙은 같은 전략을 다른 주기로 보는 것인데,
//  주기를 고를 수 없으면 둘 다 "일봉으로 보는 그것" 하나가 된다.
//
//  주기를 고를 수 있게 하면 전략 수가 **주기만큼 곱해진다** — 새 알고리즘을
//  쓰지 않고도 7개가 7×N개가 된다. 같은 사이징·손절·익절을 공유하므로
//  성적표는 여전히 비교 가능하다.
// ══════════════════════════════════════════════════════════════════

/** 바이낸스가 받는 주기 중 우리가 쓰는 것 */
export type BarInterval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w';

export const BAR_INTERVALS: readonly BarInterval[] = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w',
] as const;

/**
 * 기본값은 **지금까지 돌던 그것**이다.
 *
 * 기본값을 바꾸면 `paper-auto-v1`의 기존 기록이 조용히 다른 주기의 기록과
 * 섞인다 — 그 기록이 앞으로 만드는 모든 봇의 비교 기준이다.
 */
export const DEFAULT_BAR_INTERVAL: BarInterval = '1d';

/** 한 봉이 덮는 시간(ms). 신선도·나이 판정에 쓴다 */
export const BAR_INTERVAL_MS: Record<BarInterval, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
};

export const BAR_INTERVAL_LABEL: Record<BarInterval, string> = {
  '1m': '1분봉', '3m': '3분봉', '5m': '5분봉', '15m': '15분봉', '30m': '30분봉',
  '1h': '1시간봉', '2h': '2시간봉', '4h': '4시간봉', '6h': '6시간봉',
  '8h': '8시간봉', '12h': '12시간봉',
  '1d': '일봉', '3d': '3일봉', '1w': '주봉',
};

/**
 * 바깥에서 온 주기. **아는 값만 통과시킨다.**
 *
 * 모르는 값을 기본값으로 떨어뜨리지 않는다 — 떨어뜨리면 오타 하나로 다른
 * 주기가 돌면서 그 봇의 성적표에 기록된다. 거래소에 모르는 문자열을 그대로
 * 보내는 것도 막는다.
 */
export function parseBarInterval(raw: unknown): BarInterval | null {
  const v = String(raw ?? '').trim().toLowerCase();
  return (BAR_INTERVALS as readonly string[]).includes(v) ? (v as BarInterval) : null;
}

export function barIntervalLabel(i: BarInterval): string {
  return BAR_INTERVAL_LABEL[i] ?? String(i);
}
