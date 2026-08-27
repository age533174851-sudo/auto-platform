// src/lib/engine/highWater.ts
//
// **트레일링·본전이동은 "진입 이후 어디까지 갔나"로 정해진다.
// 그 봉을 남의 거래소에서 가져오면 전부 틀린다.**
//
// 실제로 이렇게 틀렸다
// ────────────────────
// `highWaterSince()`는 호스트를 이렇게 골랐다:
//
//     const host = testnet ? 'https://demo-fapi.binance.com'
//                          : 'https://fapi.binance.com';
//
// **거래소를 묻지 않는다.** Gate에서 연 포지션도 바이낸스 봉으로
// 계산한다. 게다가 심볼 표기가 다르다(`BTCUSDT` ↔ `BTC_USDT`)라서
// Gate 계약을 그대로 넣으면 바이낸스가 400을 준다 → `null` →
// "캔들 조회 실패 — 이번 주기 건너뜀".
//
// 그 문장은 **매 주기 조용히 반복된다.** 즉 Gate 포지션은
// 트레일링도 본전이동도 **영원히 안 돈다.** 그런데 로그에는 실패가
// 아니라 '건너뜀'만 남는다.
//
// 왜 계산을 따로 빼나
// ───────────────────
// 예전에는 fetch와 R 계산이 한 함수에 붙어 있어서, R 계산을 확인하려면
// 망을 타야 했다. 그래서 아무도 확인하지 않았다. 봉만 주면 답이 나오는
// 순수 함수로 갈라 둔다.

export interface Bar { high: number; low: number; close: number }

export interface HighWater { highWaterR: number; lastPrice: number }

/**
 * 진입 이후 최고 도달 R.
 *
 * **못 구하면 null이다 — 0이 아니다.** 0은 "아직 안 갔다"이고 그건
 * 트레일링을 안 하는 정상 상태로 읽힌다. 못 읽은 것과 섞이면 안 된다.
 */
export function highWaterOf(i: {
  bars: Bar[] | null | undefined;
  entry: number; stop: number; isLong: boolean;
}): HighWater | null {
  const bars = Array.isArray(i?.bars) ? i.bars : null;
  if (!bars || bars.length === 0) return null;

  const entry = Number(i.entry), stop = Number(i.stop);
  if (!Number.isFinite(entry) || !Number.isFinite(stop)) return null;
  const riskDist = Math.abs(entry - stop);
  if (!(riskDist > 0)) return null;

  let best = 0;
  let lastPrice = entry;
  let seen = 0;
  for (const b of bars) {
    const high = Number(b?.high), low = Number(b?.low), close = Number(b?.close);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    seen += 1;
    const favorable = i.isLong ? high : low;
    const move = i.isLong ? favorable - entry : entry - favorable;
    const r = move / riskDist;
    if (r > best) best = r;
    if (Number.isFinite(close)) lastPrice = close;
  }
  // 줄은 왔는데 쓸 수 있는 값이 하나도 없었다 — 읽은 것이 아니다.
  if (seen === 0) return null;
  return { highWaterR: best, lastPrice };
}

/** 바이낸스 kline 한 줄 → Bar. `[openTime, open, high, low, close, ...]` */
export function barFromBinance(k: any): Bar | null {
  if (!Array.isArray(k)) return null;
  return { high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) };
}

/**
 * Gate candlestick 한 줄 → Bar.
 *
 * Gate는 **객체**로 준다: `{ t, o, h, l, c, v }`. 바이낸스처럼 배열
 * 인덱스로 읽으면 전부 `undefined`가 되고, 그건 위에서 `seen === 0` →
 * `null`이 된다(조용히 0이 되지 않는다).
 */
export function barFromGate(k: any): Bar | null {
  if (!k || typeof k !== 'object' || Array.isArray(k)) return null;
  return { high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c) };
}

/**
 * 바이낸스 심볼(`BTCUSDT`) → Gate 계약(`BTC_USDT`).
 *
 * 이미 밑줄이 있으면 그대로 둔다. 저장된 심볼 표기가 두 가지라
 * 여기서 한 번만 맞춘다.
 */
export function gateContractOf(symbol: string): string {
  const s = String(symbol || '').toUpperCase().trim();
  if (!s) return '';
  if (s.includes('_')) return s;
  for (const quote of ['USDT', 'USDC', 'USD']) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return `${s.slice(0, -quote.length)}_${quote}`;
    }
  }
  return s;
}
