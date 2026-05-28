// src/app/api/stocks/route.ts — US stocks via Polygon or Finnhub, mock fallback
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const KRW_FALLBACK = 1375;

const STOCKS = [
  { id:'AMD',  nameKr:'AMD',         nameEn:'Advanced Micro Devices', logo:'amd'       },
  { id:'NVDA', nameKr:'엔비디아',    nameEn:'NVIDIA',                  logo:'nvidia'    },
  { id:'PLTR', nameKr:'팔란티어',    nameEn:'Palantir',               logo:'palantir'  },
  { id:'SMCI', nameKr:'슈퍼마이크로',nameEn:'Super Micro Computer',   logo:'smci'      },
  { id:'COIN', nameKr:'코인베이스',  nameEn:'Coinbase',               logo:'coinbase'  },
  { id:'AAPL', nameKr:'애플',        nameEn:'Apple',                  logo:'apple'     },
  { id:'TSLA', nameKr:'테슬라',      nameEn:'Tesla',                  logo:'tesla'     },
  { id:'MSFT', nameKr:'마이크로소프트',nameEn:'Microsoft',            logo:'microsoft' },
  { id:'GOOGL',nameKr:'구글',        nameEn:'Google',                 logo:'google'    },
  { id:'META', nameKr:'메타',        nameEn:'Meta',                   logo:'meta'      },
];

const MOCK_USD: Record<string,{p:number;c:number}> = {
  AMD:{p:156.4,c:2.1}, NVDA:{p:875.2,c:3.4}, PLTR:{p:24.8,c:1.8}, SMCI:{p:38.5,c:-1.2},
  COIN:{p:215.3,c:4.1}, AAPL:{p:192.5,c:0.8}, TSLA:{p:187.2,c:-1.5},
  MSFT:{p:421.8,c:1.1}, GOOGL:{p:175.3,c:0.9}, META:{p:512.4,c:2.3},
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ids = (searchParams.get('ids') || '').split(',').filter(Boolean);
  const stocks = ids.length ? STOCKS.filter(s => ids.includes(s.id)) : STOCKS;

  let krw = KRW_FALLBACK;
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const d = await r.json(); krw = d.rates?.KRW ?? KRW_FALLBACK; }
  } catch { /* fallback */ }

  const polyKey  = process.env.POLYGON_API_KEY  || '';
  const finnKey  = process.env.FINNHUB_API_KEY  || '';
  const data: any[] = [];
  let source = 'mock';

  if (polyKey) {
    try {
      const tickers = stocks.map(s => s.id).join(',');
      const r = await fetch(
        `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers}&apiKey=${polyKey}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const d = await r.json();
        const snaps: any[] = d.tickers || [];
        source = 'polygon';
        for (const stock of stocks) {
          const snap = snaps.find(x => x.ticker === stock.id);
          const m = MOCK_USD[stock.id] ?? { p: 0, c: 0 };
          if (!snap) {
            data.push({ ...stock, price: Math.round(m.p * krw), priceUsd: m.p, change24h: m.c, category:'stock', status:'mock' });
          } else {
            const usd = snap.day?.c ?? snap.prevDay?.c ?? m.p;
            const ch  = snap.todaysChangePerc ?? m.c;
            data.push({ ...stock, price: Math.round(usd * krw), priceUsd: +usd.toFixed(2), change24h: +ch.toFixed(2), category:'stock', status:'live' });
          }
        }
      }
    } catch { /* fall to finnhub */ }
  }

  if (data.length === 0 && finnKey) {
    try {
      source = 'finnhub';
      const results = await Promise.allSettled(
        stocks.map(stock =>
          fetch(`https://finnhub.io/api/v1/quote?symbol=${stock.id}&token=${finnKey}`, { signal: AbortSignal.timeout(4000) })
            .then(r => r.ok ? r.json() : null)
            .then(d => ({ stock, d }))
        )
      );
      for (const res of results) {
        if (res.status !== 'fulfilled' || !res.value.d) continue;
        const { stock, d } = res.value;
        const usd = d.c ?? 0;
        const m   = MOCK_USD[stock.id] ?? { p: 0, c: 0 };
        data.push({ ...stock, price: Math.round((usd || m.p) * krw), priceUsd: +(usd || m.p).toFixed(2),
          change24h: +((d.dp ?? m.c)).toFixed(2), category:'stock', status: usd > 0 ? 'live' : 'mock' });
      }
    } catch { /* fall to mock */ }
  }

  if (data.length === 0) {
    source = 'mock';
    for (const stock of stocks) {
      const m = MOCK_USD[stock.id] ?? { p: 0, c: 0 };
      data.push({ ...stock, price: Math.round(m.p * krw), priceUsd: m.p, change24h: m.c, category:'stock', status:'mock' });
    }
  }

  return NextResponse.json({ ok:true, source, status: source==='mock'?'mock':'live',
    updatedAt: new Date().toISOString(), krw, data },
    { headers:{ 'Cache-Control':'public, s-maxage=30, stale-while-revalidate=60' } });
}
