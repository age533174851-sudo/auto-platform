import { NextRequest, NextResponse } from 'next/server';

// ─── Types ───────────────────────────────────────────────────────
interface PriceResult {
  symbol:    string;
  price:     number;
  change24h: number;
  volume24h: number;
  marketCap?: number;
  source:    'binance' | 'polygon' | 'mock';
}

const KRW = 1375;

// ─── Static market cap estimates (KRW) — no API needed ──────────
const MCAP: Record<string, number> = {
  BTC:1_840_000_000_000_000, ETH:700_000_000_000_000,  SOL:85_000_000_000_000,
  BNB:130_000_000_000_000,   XRP:40_000_000_000_000,   DOGE:28_000_000_000_000,
  ADA:22_000_000_000_000,    AVAX:21_000_000_000_000,  TON:19_000_000_000_000,
  LINK:11_000_000_000_000,   DOT:7_500_000_000_000,    MATIC:8_000_000_000_000,
  ARB:5_000_000_000_000,     OP:4_200_000_000_000,     SUI:12_000_000_000_000,
  PEPE:7_700_000_000_000,    SHIB:13_000_000_000_000,  UNI:5_900_000_000_000,
  APT:4_800_000_000_000,     INJ:3_200_000_000_000,
};

// ─── Mock seed prices (used as fallback) ─────────────────────────
const MOCK_BASE: Record<string, {p:number;c:number;v:number}> = {
  BTC: {p:94_230_000, c:2.14,  v:42_800_000_000},
  ETH: {p:5_820_000,  c:1.83,  v:18_200_000_000},
  SOL: {p:195_000,    c:3.41,  v:4_100_000_000},
  BNB: {p:890_000,    c:0.87,  v:1_800_000_000},
  XRP: {p:725,        c:-0.54, v:2_100_000_000},
  DOGE:{p:195,        c:1.22,  v:960_000_000},
  ADA: {p:620,        c:-1.05, v:540_000_000},
  AVAX:{p:52_000,     c:4.21,  v:820_000_000},
  TON: {p:8_200,      c:2.88,  v:610_000_000},
  LINK:{p:18_900,     c:5.13,  v:720_000_000},
  DOT: {p:11_200,     c:-0.73, v:380_000_000},
  MATIC:{p:850,       c:1.94,  v:290_000_000},
  ARB: {p:1_250,      c:6.81,  v:410_000_000},
  OP:  {p:3_200,      c:7.24,  v:320_000_000},
  SUI: {p:4_800,      c:12.40, v:890_000_000},
  PEPE:{p:0.0000184,  c:8.32,  v:1_200_000_000},
  SHIB:{p:0.000022,   c:2.10,  v:800_000_000},
  UNI: {p:9_800,      c:3.20,  v:450_000_000},
  APT: {p:12_400,     c:5.80,  v:620_000_000},
  INJ: {p:34_000,     c:4.50,  v:380_000_000},
  // US stocks in USD
  NVDA:{p:875,  c:4.10, v:32_000_000_000},
  AAPL:{p:188,  c:1.17, v:28_000_000_000},
  MSFT:{p:414,  c:0.63, v:22_000_000_000},
  TSLA:{p:248,  c:-1.20,v:18_000_000_000},
  GOOGL:{p:174, c:0.84, v:20_000_000_000},
  META:{p:495,  c:1.35, v:19_000_000_000},
  AMZN:{p:183,  c:0.72, v:24_000_000_000},
  AMD: {p:161,  c:2.41, v:7_800_000_000},
  PLTR:{p:22,   c:3.20, v:2_400_000_000},
  COIN:{p:235,  c:5.80, v:3_200_000_000},
  INTC:{p:31,   c:-0.80,v:5_200_000_000},
  MSTR:{p:1650, c:8.20, v:2_100_000_000},
};
const US_STOCKS = new Set(['NVDA','AAPL','MSFT','TSLA','GOOGL','META','AMZN','AMD','PLTR','COIN','INTC','MSTR']);
const CRYPTO    = Object.keys(MOCK_BASE).filter(k => !US_STOCKS.has(k));

function getMock(): Map<string, PriceResult> {
  const m = new Map<string, PriceResult>();
  for (const [sym, d] of Object.entries(MOCK_BASE)) {
    const isStock = US_STOCKS.has(sym);
    m.set(sym, { symbol:sym, price: isStock ? d.p * KRW : d.p,
      change24h:d.c, volume24h:d.v, marketCap:MCAP[sym], source:'mock' });
  }
  return m;
}

// ─── Binance 24hr ticker batch ─────────────────────────────────
async function fetchBinance(): Promise<Map<string, PriceResult>> {
  const res = new Map<string, PriceResult>();
  const pairs = CRYPTO.map(s => `"${s}USDT"`).join(',');
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbols=[${pairs}]`,
      { signal: AbortSignal.timeout(3500),
        headers: { 'Accept-Encoding': 'gzip' } }
    );
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const stats: any[] = await r.json();
    for (const item of stats) {
      const sym = item.symbol.replace('USDT', '');
      if (!MOCK_BASE[sym]) continue;
      res.set(sym, {
        symbol: sym,
        price:     parseFloat(item.lastPrice) * KRW,
        change24h: parseFloat(item.priceChangePercent),
        volume24h: parseFloat(item.quoteVolume),
        marketCap: MCAP[sym],
        source:    'binance',
      });
    }
  } catch {}
  return res;
}

// ─── CoinGecko 폴백 (Binance 실패/차단 시, 키 불필요) ───────────
const CG_ID: Record<string,string> = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin', XRP:'ripple',
  DOGE:'dogecoin', ADA:'cardano', AVAX:'avalanche-2', TON:'the-open-network',
  LINK:'chainlink', DOT:'polkadot', MATIC:'matic-network', ARB:'arbitrum',
  OP:'optimism', SUI:'sui', PEPE:'pepe', SHIB:'shiba-inu', UNI:'uniswap',
  APT:'aptos', INJ:'injective-protocol',
};
async function fetchCoinGecko(krw: number): Promise<Map<string, PriceResult>> {
  const res = new Map<string, PriceResult>();
  const ids = Object.values(CG_ID).join(',');
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
      { signal: AbortSignal.timeout(4500), headers: { 'Accept': 'application/json' } }
    );
    if (!r.ok) throw new Error(`CoinGecko ${r.status}`);
    const d = await r.json();
    for (const [sym, id] of Object.entries(CG_ID)) {
      const row = d[id];
      if (!row || row.usd == null) continue;
      res.set(sym, {
        symbol: sym,
        price:     row.usd * krw,
        change24h: row.usd_24h_change ?? 0,
        volume24h: row.usd_24h_vol ?? 0,
        marketCap: MCAP[sym],
        source:    'coingecko' as any,
      });
    }
  } catch {}
  return res;
}

// ─── Binance top gainers / losers / trending ───────────────────
async function fetchBinanceAll(): Promise<any[]> {
  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/ticker/24hr?type=MINI',
      { signal: AbortSignal.timeout(4000) }
    );
    if (!r.ok) return [];
    const all: any[] = await r.json();
    return all
      .filter((t:any) => t.symbol.endsWith('USDT') && !t.symbol.includes('UP') && !t.symbol.includes('DOWN') && !t.symbol.includes('BEAR') && !t.symbol.includes('BULL'))
      .map((t:any) => ({
        symbol:    t.symbol.replace('USDT',''),
        price:     parseFloat(t.lastPrice) * KRW,
        change24h: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
        source:    'binance',
      }));
  } catch { return []; }
}

// ─── Binance aggregate trade (volume-based trending) ──────────
async function fetchTrending(): Promise<any[]> {
  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/ticker/24hr?type=MINI',
      { signal: AbortSignal.timeout(4000) }
    );
    if (!r.ok) return [];
    const all: any[] = await r.json();
    return all
      .filter((t:any) => t.symbol.endsWith('USDT') && !t.symbol.match(/UP|DOWN|BEAR|BULL/))
      .sort((a:any,b:any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 20)
      .map((t:any) => ({
        symbol:    t.symbol.replace('USDT',''),
        price:     parseFloat(t.lastPrice) * KRW,
        change24h: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
        source:    'binance',
      }));
  } catch { return []; }
}

// ─── Polygon US stocks (server-only) ──────────────────────────
async function fetchPolygon(tickers: string[]): Promise<Map<string, PriceResult>> {
  const key = process.env.POLYGON_API_KEY || '';
  const res  = new Map<string, PriceResult>();
  if (!key || !tickers.length) return res;
  try {
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${key}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!r.ok) return res;
    const data = await r.json();
    for (const t of data.tickers || []) {
      const priceUSD  = t.day?.c || t.lastTrade?.p || t.prevDay?.c || 0;
      const openUSD   = t.day?.o || t.prevDay?.c || priceUSD;
      const changePct = openUSD > 0 ? ((priceUSD - openUSD) / openUSD) * 100 : 0;
      res.set(t.ticker, { symbol:t.ticker, price:priceUSD*KRW, change24h:changePct, volume24h:t.day?.v||0, source:'polygon' });
    }
  } catch {}
  return res;
}

// ─── Binance candle (klines) ───────────────────────────────────
async function fetchBinanceCandles(symbol: string, interval: string, limit: number) {
  const pair = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return [];
    const data: any[][] = await r.json();
    return data.map(k => ({
      t: k[0],          // open time ms
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
      v: parseFloat(k[5]),
    }));
  } catch { return []; }
}

// ─── Binance coin info (exchangeInfo) ─────────────────────────
async function fetchBinanceCoinInfo(symbol: string) {
  const base = symbol.toUpperCase().replace('USDT','');
  try {
    const [tickerR, bookR] = await Promise.allSettled([
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${base}USDT`, { signal: AbortSignal.timeout(3000) }),
      fetch(`https://api.binance.com/api/v3/depth?symbol=${base}USDT&limit=5`, { signal: AbortSignal.timeout(2000) }),
    ]);
    let price=0, change=0, vol=0, high=0, low=0;
    if (tickerR.status==='fulfilled' && tickerR.value.ok) {
      const t = await tickerR.value.json();
      price  = parseFloat(t.lastPrice) * KRW;
      change = parseFloat(t.priceChangePercent);
      vol    = parseFloat(t.quoteVolume);
      high   = parseFloat(t.highPrice) * KRW;
      low    = parseFloat(t.lowPrice)  * KRW;
    }
    return { symbol: base, price, change24h:change, volume24h:vol, high24h:high, low24h:low, source:'binance' };
  } catch { return null; }
}

// ─── Main GET handler ──────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const t0     = Date.now();

  // ── Candles (Binance klines) ──
  if (action === 'candles') {
    const sym      = searchParams.get('symbol') || 'BTC';
    const interval = searchParams.get('interval') || '1h';
    const limit    = Math.min(500, parseInt(searchParams.get('limit') || '200'));
    const isCrypto = !US_STOCKS.has(sym.toUpperCase());
    if (isCrypto) {
      const candles = await fetchBinanceCandles(sym, interval, limit);
      return NextResponse.json({ candles, symbol:sym, source:'binance', count:candles.length }, {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      });
    }
    // US stock candles via Polygon
    const key = process.env.POLYGON_API_KEY || '';
    if (key) {
      const tsMap: Record<string,string> = {'1m':'minute','5m':'minute','15m':'minute','1h':'hour','4h':'hour','1d':'day','1w':'week'};
      const multMap: Record<string,string> = {'5m':'5','15m':'15','4h':'4'};
      const ts   = tsMap[interval] || 'day';
      const mult = multMap[interval] || '1';
      const from = searchParams.get('from') || new Date(Date.now()-90*86400000).toISOString().split('T')[0];
      const to   = searchParams.get('to')   || new Date().toISOString().split('T')[0];
      try {
        const r = await fetch(
          `https://api.polygon.io/v2/aggs/ticker/${sym.toUpperCase()}/range/${mult}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=500&apiKey=${key}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (r.ok) {
          const d = await r.json();
          const candles = (d.results||[]).map((b:any)=>({ t:b.t,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v }));
          return NextResponse.json({ candles, symbol:sym, source:'polygon', count:candles.length }, {
            headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
          });
        }
      } catch {}
    }
    return NextResponse.json({ candles:[], symbol:sym, source:'unavailable' });
  }

  // ── Coin detail ──
  if (action === 'coin') {
    const sym  = searchParams.get('symbol') || 'BTC';
    const info = await fetchBinanceCoinInfo(sym);
    return NextResponse.json(info || { symbol:sym, source:'error' }, {
      headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
    });
  }

  // ── Top gainers / losers ──
  if (action === 'gainers' || action === 'losers') {
    const all = await fetchBinanceAll();
    const sorted = all.sort((a,b) =>
      action === 'gainers' ? b.change24h - a.change24h : a.change24h - b.change24h
    ).slice(0, 20);
    return NextResponse.json({ results:sorted, action, source:'binance', count:sorted.length }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }

  // ── Trending (by volume) ──
  if (action === 'trending') {
    const trending = await fetchTrending();
    return NextResponse.json({ results:trending, source:'binance', count:trending.length }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  // ── All crypto (Binance 전체 USDT 페어, 거래량순) ──
  if (action === 'all_crypto') {
    const limit = Math.min(500, parseInt(searchParams.get('limit') || '200'));
    const all = await fetchBinanceAll();
    const sorted = all
      .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
      .slice(0, limit);
    return NextResponse.json({
      results: sorted,
      source:  'binance',
      count:   sorted.length,
      total:   all.length,
      status:  all.length > 0 ? 'live' : 'error',
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }

  // ── Polygon ticker search (for asset detail) ──
  if (action === 'search') {
    const query = searchParams.get('q') || '';
    const key   = process.env.POLYGON_API_KEY || '';
    if (!key) return NextResponse.json({ results:[], source:'no_key' });
    try {
      const r = await fetch(
        `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(query)}&market=stocks&active=true&limit=10&apiKey=${key}`,
        { signal: AbortSignal.timeout(4000) }
      );
      const d = await r.json();
      const results = (d.results||[]).map((t:any)=>({
        sym:t.ticker, name:t.name, exchange:t.primary_exchange, source:'polygon',
      }));
      return NextResponse.json({ results, source:'polygon', query });
    } catch { return NextResponse.json({ results:[], source:'error' }); }
  }

  // ── Default: batch crypto + stock prices ──
  const mock    = getMock();
  let cryptoM   = await fetchBinance();
  let cryptoSrc = 'binance';
  if (cryptoM.size === 0) {                      // Binance 차단/실패 → CoinGecko 폴백
    cryptoM = await fetchCoinGecko(KRW);
    if (cryptoM.size > 0) cryptoSrc = 'coingecko';
  }
  const stockM  = await fetchPolygon([...US_STOCKS]);

  // Merge: live beats mock
  const merged  = new Map<string, PriceResult>(mock);
  for (const [k,v] of cryptoM) merged.set(k, v);
  for (const [k,v] of stockM)  merged.set(k, v);

  const data   = Array.from(merged.values()).sort((a,b)=>(b.marketCap||0)-(a.marketCap||0));
  const prices: Record<string,number> = {};
  for (const item of data) prices[item.symbol] = item.price;

  const allMock = cryptoM.size === 0 && stockM.size === 0;
  return NextResponse.json({
    source:   cryptoM.size > 0 ? (stockM.size > 0 ? `${cryptoSrc}+polygon` : cryptoSrc) : 'mock',
    status:   allMock ? 'mock' : 'live',
    latency:  Date.now() - t0,
    count:    data.length,
    prices,
    data,
    providers:[
      { name:'Binance',    status:cryptoSrc==='binance'&&cryptoM.size>0?'live':cryptoM.size>0?'fallback':'error' },
      { name:'CoinGecko',  status:cryptoSrc==='coingecko'?'live':'standby' },
      { name:'Polygon.io', status:process.env.POLYGON_API_KEY || '' ? (stockM.size>0?'live':'error') : 'unconfigured' },
    ],
    timestamp: Date.now(),
  }, {
    headers: {
      'Cache-Control': allMock ? 'no-store' : 'public, s-maxage=15, stale-while-revalidate=30',
    },
  });
}
