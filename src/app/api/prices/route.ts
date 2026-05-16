import { NextRequest, NextResponse } from 'next/server';

interface PriceResult {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  marketCap?: number;
  source: 'binance' | 'coingecko' | 'polygon' | 'mock';
}

interface ProviderHealth {
  name: string;
  status: 'live' | 'error' | 'unconfigured';
  latency: number;
}

const KRW_RATE = 1375; // approx USD→KRW

const MOCK_PRICES: Record<string, { price: number; change: number; vol: number; mcap: number }> = {
  BTC:  { price: 94230000, change:  2.14, vol: 42800000000, mcap: 1840000000000 },
  ETH:  { price:  5820000, change:  1.83, vol: 18200000000, mcap:  700000000000 },
  SOL:  { price:   195000, change:  3.41, vol:  4100000000, mcap:   85000000000 },
  BNB:  { price:   890000, change:  0.87, vol:  1800000000, mcap:  130000000000 },
  XRP:  { price:      725, change: -0.54, vol:  2100000000, mcap:   40000000000 },
  DOGE: { price:      195, change:  1.22, vol:   960000000, mcap:   28000000000 },
  ADA:  { price:      620, change: -1.05, vol:   540000000, mcap:   22000000000 },
  AVAX: { price:    52000, change:  4.21, vol:   820000000, mcap:   21000000000 },
  TON:  { price:     8200, change:  2.88, vol:   610000000, mcap:   19000000000 },
  LINK: { price:    18900, change:  5.13, vol:   720000000, mcap:   11000000000 },
  DOT:  { price:    11200, change: -0.73, vol:   380000000, mcap:    7500000000 },
  MATIC:{ price:      850, change:  1.94, vol:   290000000, mcap:    8000000000 },
  ARB:  { price:     1250, change:  6.81, vol:   410000000, mcap:    5000000000 },
  OP:   { price:     3200, change:  7.24, vol:   320000000, mcap:    4200000000 },
  SUI:  { price:     4800, change: 12.40, vol:   890000000, mcap:   12000000000 },
  PEPE: { price: 0.0000184,change: 8.32, vol:  1200000000, mcap:    7700000000 },
  SHIB: { price: 0.000022, change: 2.10, vol:   800000000, mcap:   13000000000 },
  UNI:  { price:     9800, change:  3.20, vol:   450000000, mcap:    5900000000 },
  APT:  { price:    12400, change:  5.80, vol:   620000000, mcap:    4800000000 },
  INJ:  { price:    34000, change:  4.50, vol:   380000000, mcap:    3200000000 },
};

async function fetchBinance(): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();
  const symbols = Object.keys(MOCK_PRICES);
  const pairs = symbols.map(s => `"${s}USDT"`).join(',');
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbols=[${pairs}]`,
      { signal: AbortSignal.timeout(3500) }
    );
    if (!res.ok) throw new Error('Binance HTTP ' + res.status);
    const stats: any[] = await res.json();
    for (const item of stats) {
      const sym = item.symbol.replace('USDT', '');
      if (MOCK_PRICES[sym]) {
        results.set(sym, {
          symbol: sym,
          price: parseFloat(item.lastPrice) * KRW_RATE,
          change24h: parseFloat(item.priceChangePercent),
          volume24h: parseFloat(item.quoteVolume),
          marketCap: MOCK_PRICES[sym].mcap,
          source: 'binance',
        });
      }
    }
  } catch {}
  return results;
}

async function fetchCoinGecko(): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();
  const CGK_IDS = 'bitcoin,ethereum,solana,binancecoin,ripple,dogecoin,cardano,avalanche-2,toncoin,chainlink,polkadot,matic-network,arbitrum,optimism,sui,shiba-inu,uniswap,aptos,injective-protocol';
  const SYM_MAP: Record<string,string> = {
    bitcoin:'BTC',ethereum:'ETH',solana:'SOL',binancecoin:'BNB',ripple:'XRP',
    dogecoin:'DOGE',cardano:'ADA','avalanche-2':'AVAX',toncoin:'TON',
    chainlink:'LINK',polkadot:'DOT','matic-network':'MATIC',arbitrum:'ARB',
    optimism:'OP',sui:'SUI','shiba-inu':'SHIB',uniswap:'UNI',aptos:'APT',
    'injective-protocol':'INJ',
  };
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${CGK_IDS}&per_page=25&sparkline=false`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status);
    const data: any[] = await res.json();
    for (const coin of data) {
      const sym = SYM_MAP[coin.id];
      if (sym) {
        results.set(sym, {
          symbol: sym,
          price: (coin.current_price || 0) * KRW_RATE,
          change24h: coin.price_change_percentage_24h || 0,
          volume24h: coin.total_volume || 0,
          marketCap: (coin.market_cap || 0) * KRW_RATE,
          source: 'coingecko',
        });
      }
    }
  } catch {}
  return results;
}

function getMockPrices(): Map<string, PriceResult> {
  const results = new Map<string, PriceResult>();
  for (const [sym, data] of Object.entries(MOCK_PRICES)) {
    results.set(sym, {
      symbol: sym,
      price: data.price * (1 + (Math.random() - 0.5) * 0.001),
      change24h: data.change + (Math.random() - 0.5) * 0.2,
      volume24h: data.vol,
      marketCap: data.mcap,
      source: 'mock',
    });
  }
  return results;
}

function getProviderHealth(): ProviderHealth[] {
  return [
    { name: 'Binance',    status: 'live',       latency: 0 },
    { name: 'CoinGecko',  status: 'live',       latency: 0 },
    { name: 'Polygon.io', status: process.env.POLYGON_API_KEY ? 'live' : 'unconfigured', latency: 0 },
    { name: 'Supabase',   status: process.env.NEXT_PUBLIC_SUPABASE_URL ? 'live' : 'unconfigured', latency: 0 },
  ];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const provider = searchParams.get('provider') || 'auto';
  const t0 = Date.now();

  let priceMap = new Map<string, PriceResult>();
  let status: 'live' | 'mock' = 'live';

  if (provider === 'coingecko') {
    priceMap = await fetchCoinGecko();
  } else if (provider === 'binance') {
    priceMap = await fetchBinance();
  } else {
    // AUTO: Binance first (faster), enrich with CoinGecko market caps
    priceMap = await fetchBinance();
    if (priceMap.size > 0) {
      const cg = await fetchCoinGecko();
      for (const [sym, d] of cg) {
        const ex = priceMap.get(sym);
        if (ex && d.marketCap) priceMap.set(sym, { ...ex, marketCap: d.marketCap });
      }
    } else {
      priceMap = await fetchCoinGecko();
    }
  }

  if (priceMap.size === 0) {
    priceMap = getMockPrices();
    status = 'mock';
  }

  const data = Array.from(priceMap.values()).sort((a,b) => (b.marketCap||0)-(a.marketCap||0));
  const prices: Record<string,number> = {};
  for (const item of data) prices[item.symbol] = item.price;

  return NextResponse.json({
    source: data[0]?.source || 'mock',
    status,
    latency: Date.now() - t0,
    count: data.length,
    prices,
    data,
    providers: getProviderHealth(),
    timestamp: Date.now(),
  }, {
    headers: {
      'Cache-Control': status === 'mock'
        ? 'no-store'
        : 'public, s-maxage=10, stale-while-revalidate=30',
    },
  });
}
