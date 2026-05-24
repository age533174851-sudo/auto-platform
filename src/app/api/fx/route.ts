// src/app/api/fx/route.ts — Exchange rates (public API, no key needed)
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const FALLBACK = { USDKRW:1375, EURKRW:1500, JPYKRW:9.1, GBPKRW:1740, CNYKRW:190 };

export async function GET() {
  let rates = { ...FALLBACK };
  let source = 'mock';

  // Try exchangerate-api (free, no key)
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const krw = d.rates?.KRW ?? FALLBACK.USDKRW;
      rates = {
        USDKRW: Math.round(krw),
        EURKRW: Math.round(krw / (d.rates?.EUR ?? 0.92)),
        JPYKRW: +( krw / (d.rates?.JPY ?? 151)).toFixed(2),
        GBPKRW: Math.round(krw / (d.rates?.GBP ?? 0.79)),
        CNYKRW: +( krw / (d.rates?.CNY ?? 7.23)).toFixed(2),
      };
      source = 'exchangerate-api';
    }
  } catch { /* fallback */ }

  return NextResponse.json({ ok:true, source, status: source==='mock'?'mock':'live',
    updatedAt: new Date().toISOString(), rates },
    { headers:{ 'Cache-Control':'public, s-maxage=60, stale-while-revalidate=300' } });
}
