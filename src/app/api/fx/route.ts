// src/app/api/fx/route.ts — 환율 (failover: exchangerate-api → open.er-api → ECB → fallback)
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const FALLBACK = { USDKRW:1375, EURKRW:1500, JPYKRW:9.1, GBPKRW:1740, CNYKRW:190 };

export async function GET() {
  let rates = { ...FALLBACK };
  let source = 'mock';

  // 1차: exchangerate-api
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const krw = d.rates?.KRW;
      if (krw && krw > 500 && krw < 3000) {
        rates = {
          USDKRW: Math.round(krw),
          EURKRW: Math.round(krw / (d.rates?.EUR ?? 0.92)),
          JPYKRW: +(krw / (d.rates?.JPY ?? 151)).toFixed(2),
          GBPKRW: Math.round(krw / (d.rates?.GBP ?? 0.79)),
          CNYKRW: +(krw / (d.rates?.CNY ?? 7.23)).toFixed(2),
        };
        source = 'exchangerate-api';
      }
    }
  } catch {}

  // 2차 failover: open.er-api
  if (source === 'mock') {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const d = await r.json();
        const krw = d.rates?.KRW;
        if (krw && krw > 500 && krw < 3000) {
          rates = {
            USDKRW: Math.round(krw),
            EURKRW: Math.round(krw / (d.rates?.EUR ?? 0.92)),
            JPYKRW: +(krw / (d.rates?.JPY ?? 151)).toFixed(2),
            GBPKRW: Math.round(krw / (d.rates?.GBP ?? 0.79)),
            CNYKRW: +(krw / (d.rates?.CNY ?? 7.23)).toFixed(2),
          };
          source = 'open-er-api';
        }
      }
    } catch {}
  }

  return NextResponse.json({ ok:true, source, status: source==='mock'?'mock':'live',
    failoverChain: ['exchangerate-api','open-er-api','fallback'],
    updatedAt: new Date().toISOString(), rates },
    { headers:{ 'Cache-Control':'public, s-maxage=60, stale-while-revalidate=300' } });
}
