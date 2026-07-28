// src/lib/markets/pricing.ts
//
// 현물 자산에 USD 값을 매긴다.
//
// 왜 공용인가
// ───────────
// 통합 자산 트리(/api/wallets)와 현물 전략 평가(/api/strategies/spot)가
// 둘 다 "이 자산이 지금 얼마인가"를 알아야 한다. 각자 계산하면 한 화면은
// 리밸런싱이 돌고 다른 화면은 안 도는 식으로 어긋난다.
//
// 값을 못 구하면 0이 아니라 null이다
// ──────────────────────────────────
// 0으로 두면 총자산에서 조용히 사라지고, 사용자는 자산이 줄었다고
// 오해한다. 비중 계산에서도 분모가 작아져 다른 자산의 비중이 부풀려진다.

export interface RawAsset { asset: string; free: number; locked: number }
export interface PricedAsset extends RawAsset { valueUsd: number | null }

/** 스테이블코인은 1달러로 본다. 시세 조회를 아끼고, 어차피 1에 수렴한다 */
const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);

/**
 * 전체 시세를 한 번에 받는다.
 * 자산마다 부르면 수십 번이 나가고 레이트리밋에 걸린다.
 */
export async function fetchSpotPriceMap(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price',
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return map;
    const list = await r.json();
    for (const t of (Array.isArray(list) ? list : [])) {
      const v = parseFloat(t?.price);
      if (Number.isFinite(v)) map.set(String(t.symbol), v);
    }
  } catch { /* 못 받으면 빈 지도 — 전부 null이 된다 */ }
  return map;
}

export function priceWith(raw: RawAsset[], prices: Map<string, number>): PricedAsset[] {
  return raw.map(b => {
    const total = b.free + b.locked;
    if (STABLE.has(b.asset)) return { ...b, valueUsd: total };
    const px = prices.get(`${b.asset}USDT`);
    return { ...b, valueUsd: px != null ? total * px : null };
  });
}

export async function priceAssets(raw: RawAsset[]): Promise<PricedAsset[]> {
  return priceWith(raw, await fetchSpotPriceMap());
}

/**
 * 포트폴리오 전체 평가액.
 *
 * **값을 못 구한 자산이 하나라도 있으면 null이다.** 그 자산을 빼고
 * 합계를 내면 다른 자산의 비중이 실제보다 크게 나오고, 리밸런싱이
 * 그 비중을 근거로 팔아버린다.
 */
export function totalValueUsd(assets: PricedAsset[]): number | null {
  if (assets.some(a => a.valueUsd == null)) return null;
  return assets.reduce((s, a) => s + (a.valueUsd ?? 0), 0);
}
