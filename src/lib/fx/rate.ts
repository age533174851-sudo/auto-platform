// src/lib/fx/rate.ts
// 실시간 USD/KRW 환율 — 서버 캐시 (10분). 실패 시 fallback 1375.
let _cache: { rate: number; at: number } | null = null;
const TTL = 10 * 60 * 1000;
const FALLBACK = 1375;

export async function getUsdKrw(): Promise<number> {
  if (_cache && Date.now() - _cache.at < TTL) return _cache.rate;
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const krw = d?.rates?.KRW;
      if (krw && krw > 500 && krw < 3000) { _cache = { rate: Math.round(krw), at: Date.now() }; return _cache.rate; }
    }
  } catch {}
  try {
    const r2 = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4000) });
    if (r2.ok) {
      const d2 = await r2.json();
      const krw2 = d2?.rates?.KRW;
      if (krw2 && krw2 > 500 && krw2 < 3000) { _cache = { rate: Math.round(krw2), at: Date.now() }; return _cache.rate; }
    }
  } catch {}
  return _cache?.rate ?? FALLBACK;
}

export async function krwToUsdt(krw: number): Promise<number> {
  const rate = await getUsdKrw();
  return krw / rate;
}
