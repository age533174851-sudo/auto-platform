import { NextRequest, NextResponse } from 'next/server';

// ── Mock search DB (server-side subset) ──────────────────────
const MOCK_DB = [
  {symbol:'BTC',name:'Bitcoin',nameKr:'비트코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'mock'},
  {symbol:'ETH',name:'Ethereum',nameKr:'이더리움',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'mock'},
  {symbol:'SOL',name:'Solana',nameKr:'솔라나',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'mock'},
  {symbol:'AAPL',name:'Apple Inc.',nameKr:'애플',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'mock'},
  {symbol:'MSFT',name:'Microsoft Corp.',nameKr:'마이크로소프트',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'mock'},
  {symbol:'NVDA',name:'NVIDIA Corp.',nameKr:'엔비디아',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'mock'},
  {symbol:'TSLA',name:'Tesla Inc.',nameKr:'테슬라',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'mock'},
  {symbol:'005930',name:'Samsung Electronics',nameKr:'삼성전자',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'mock'},
  {symbol:'035420',name:'NAVER Corp.',nameKr:'네이버',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'mock'},
  {symbol:'035720',name:'Kakao Corp.',nameKr:'카카오',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'mock'},
  {symbol:'QQQ',name:'Invesco QQQ Trust',nameKr:'나스닥100 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'mock'},
  {symbol:'SPY',name:'SPDR S&P 500 ETF',nameKr:'S&P500 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'mock'},
  {symbol:'USDKRW',name:'USD/KRW',nameKr:'달러/원',exchange:'FOREX',asset_type:'forex',currency:'KRW',provider:'mock',isWatchOnly:true},
  {symbol:'GOLD',name:'Gold Spot',nameKr:'금',exchange:'COMMODITY',asset_type:'commodity',currency:'USD',provider:'mock',isWatchOnly:true},
];

async function searchBinance(query: string) {
  try {
    const res = await fetch('https://api.binance.com/api/v3/exchangeInfo', {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const Q = query.toUpperCase();
    return (data.symbols as any[])
      .filter((s: any) => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.baseAsset.includes(Q))
      .slice(0, 10)
      .map((s: any) => ({
        symbol: s.baseAsset,
        name: s.baseAsset,
        exchange: 'BINANCE',
        asset_type: 'coin',
        currency: 'USDT',
        provider: 'binance',
      }));
  } catch {
    return [];
  }
}

async function searchPolygon(query: string) {
  const apiKey = (globalThis as any).process?.env?.POLYGON_API_KEY as string | undefined;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(query)}&active=true&limit=10&apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(2500) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r: any) => ({
      symbol: r.ticker,
      name: r.name,
      exchange: r.primary_exchange || 'NASDAQ',
      asset_type: r.type === 'ETF' ? 'etf' : 'stock',
      currency: 'USD',
      provider: 'polygon',
    }));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim() || '';
  if (!q || q.length < 1) {
    return NextResponse.json({ results: [], source: 'mock', total: 0 });
  }

  const lq = q.toLowerCase();
  const localResults = MOCK_DB.filter(a =>
    a.symbol.toLowerCase().includes(lq) ||
    a.name.toLowerCase().includes(lq) ||
    (a.nameKr || '').includes(q)
  );

  const isCrypto = /btc|eth|sol|xrp|bnb|doge|ada|avax|coin/i.test(q) ||
    localResults.some(r => r.asset_type === 'coin');

  let apiResults: any[] = [];
  let source = 'mock';

  if (isCrypto) {
    apiResults = await searchBinance(q);
    if (apiResults.length > 0) source = 'binance';
  } else {
    apiResults = await searchPolygon(q);
    if (apiResults.length > 0) source = 'polygon';
  }

  const seen = new Set(localResults.map(r => r.symbol));
  const combined = [
    ...localResults,
    ...apiResults.filter((r: any) => !seen.has(r.symbol)),
  ].slice(0, 20);

  return NextResponse.json({
    results: combined,
    source,
    total: combined.length,
    timestamp: Date.now(),
  }, {
    headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
  });
}
