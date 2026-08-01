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

/** 공개 엔드포인트라 키가 없어도 읽는다. 못 받으면 null */
export async function fetchDailyCloses(
  symbol: string, limit = 120,
): Promise<number[] | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${limit}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const closes = data
      .map((k: any) => (Array.isArray(k) ? parseFloat(k[4]) : NaN))
      .filter((c: number) => Number.isFinite(c) && c > 0);
    return closes.length ? closes : null;
  } catch { return null; }
}

export interface RegimeFacts {
  verdict: RegimeGateVerdict;
  mode: RegimeFilterMode;
  /** 설정 오타 등 알려야 할 것 */
  note: string;
  /** 필터가 켜져 있는가 — 체크리스트에 항목을 넣을지 정한다 */
  enabled: boolean;
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

  const closes = args.closes !== undefined
    ? args.closes
    : await fetchDailyCloses(args.symbol);

  return {
    verdict: judgeRegime(closes, args.side, mode),
    mode, note,
    enabled: mode !== 'off',
  };
}
