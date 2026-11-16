// src/lib/risk/regimeCheck.ts
//
// 국면 판정에 넣을 **실제 봉**을 받아온다.
//
// 판정은 regimeGate.ts(순수)가 하고 여기서는 시세만 읽는다. 나눠 두는 이유는
// 판정에 테스트를 붙이기 위해서다 — 봉이 모자랄 때 '횡보 · 진입 허용'이
// 나오던 버그가 정확히 그 자리에서 났다.
//
// 실패는 빈 배열로 덮지 않는다
// ────────────────────────────
// 시세를 못 받으면 `null`이다. `[]`로 돌려주면 `detectRegime`이 '판정 불가'를
// 내주기는 하지만, '조회 실패'와 '데이터 없음'을 구분할 수 없어진다.

import { judgeRegime, readRegimeFilter, type RegimeGateVerdict, type RegimeFilterMode } from './regimeGate';
import { parseKlines, closesOf, type Bar } from './bars';

/**
 * 공개 엔드포인트라 키가 없어도 읽는다. 못 받으면 null.
 *
 * **봉을 통째로 돌려준다.** 예전에는 같은 응답에서 종가 하나만 꺼내고
 * 고가·저가·거래량을 버렸다 — 같은 요청, 같은 바이트인데 버린 것이다.
 * 그래서 오더블록·FVG·유동성 사냥·거래량 확인 돌파를 쓸 수가 없었다.
 */
export async function fetchDailyBars(
  symbol: string, limit = 120,
): Promise<Bar[] | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${limit}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    return parseKlines(await r.json());
  } catch { return null; }
}

/**
 * 종가만 필요한 호출자를 위한 얇은 겉면.
 *
 * **받아오는 길은 하나다.** 두 함수가 각자 fetch하면 같은 회차에서 서로
 * 다른 봉을 보게 되고, 그러면 국면과 전략이 다른 시세로 판단한다.
 */
export async function fetchDailyCloses(
  symbol: string, limit = 120,
): Promise<number[] | null> {
  return closesOf(await fetchDailyBars(symbol, limit));
}

export interface RegimeFacts {
  verdict: RegimeGateVerdict;
  mode: RegimeFilterMode;
  /** 설정 오타 등 알려야 할 것 */
  note: string;
  /** 필터가 켜져 있는가 — 체크리스트에 항목을 넣을지 정한다 */
  enabled: boolean;
  /**
   * 이 판정에 쓴 봉 전체. **못 받았으면 null** — 빈 배열이 아니다.
   *
   * 호출자가 `closes`만 넘긴 경우에도 null이다. 종가만 가지고 고가·저가를
   * 지어낼 수는 없고, 지어내면 봉이 필요한 전략이 거짓 신호를 낸다.
   */
  bars: Bar[] | null;
}

/**
 * 지금 국면과 그 판정.
 *
 * `closes`를 넘기면 그것을 쓴다 (호출자가 이미 일봉을 받아 둔 경우 —
 * daily-ladder가 그렇다). 없으면 여기서 받아온다.
 */
export async function collectRegime(args: {
  symbol: string;
  side: 'LONG' | 'SHORT';
  closes?: number[] | null;
  env?: (k: string) => string | undefined;
}): Promise<RegimeFacts> {
  const { mode, note } = readRegimeFilter(args.env ?? ((k) => process.env[k]));

  // 호출자가 종가를 이미 들고 있으면 그것을 쓴다(daily-ladder가 그렇다).
  // 그때는 봉이 없으므로 `bars`는 null이다 — 종가로 고가·저가를 지어내지 않는다.
  const bars = args.closes !== undefined ? null : await fetchDailyBars(args.symbol);
  const closes = args.closes !== undefined ? args.closes : closesOf(bars);

  return {
    verdict: judgeRegime(closes, args.side, mode),
    mode, note,
    enabled: mode !== 'off',
    bars,
  };
}
