// ─────────────────────────────────────────────────────────────
// TRAIGO 글로벌 자산 검색 엔진
// Priority: Binance → CoinGecko → Polygon → Mock
// ─────────────────────────────────────────────────────────────
import type { SearchResult, AssetType, DataProvider } from './assetTypes';

// ── Mock search database (offline fallback) ───────────────────
// This is NOT a hardcoded full list — just enough for offline UX
// Real searches go through the provider APIs
const MOCK_SEARCH_DB: SearchResult[] = [
  // Crypto
  {symbol:'BTC',name:'Bitcoin',nameKr:'비트코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'ETH',name:'Ethereum',nameKr:'이더리움',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'SOL',name:'Solana',nameKr:'솔라나',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'XRP',name:'XRP',nameKr:'리플',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'BNB',name:'BNB',nameKr:'바이낸스코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'DOGE',name:'Dogecoin',nameKr:'도지코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'ADA',name:'Cardano',nameKr:'에이다',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'AVAX',name:'Avalanche',nameKr:'아발란체',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'TON',name:'Toncoin',nameKr:'톤코인',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'LINK',name:'Chainlink',nameKr:'체인링크',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'DOT',name:'Polkadot',nameKr:'폴카닷',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'MATIC',name:'Polygon',nameKr:'폴리곤',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'SHIB',name:'Shiba Inu',nameKr:'시바이누',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'PEPE',name:'Pepe',nameKr:'페페',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'UNI',name:'Uniswap',nameKr:'유니스왑',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'ARB',name:'Arbitrum',nameKr:'아비트럼',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'OP',name:'Optimism',nameKr:'옵티미즘',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'SUI',name:'Sui',nameKr:'수이',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'APT',name:'Aptos',nameKr:'앱토스',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  {symbol:'INJ',name:'Injective',nameKr:'인젝티브',exchange:'BINANCE',asset_type:'coin',currency:'USDT',provider:'binance'},
  // US Stocks (mock — real search via Polygon/Finnhub)
  {symbol:'AAPL',name:'Apple Inc.',nameKr:'애플',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/apple.com'},
  {symbol:'MSFT',name:'Microsoft Corp.',nameKr:'마이크로소프트',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/microsoft.com'},
  {symbol:'NVDA',name:'NVIDIA Corp.',nameKr:'엔비디아',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/nvidia.com'},
  {symbol:'GOOGL',name:'Alphabet Inc.',nameKr:'구글',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/google.com'},
  {symbol:'AMZN',name:'Amazon.com',nameKr:'아마존',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/amazon.com'},
  {symbol:'META',name:'Meta Platforms',nameKr:'메타',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/meta.com'},
  {symbol:'TSLA',name:'Tesla Inc.',nameKr:'테슬라',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/tesla.com'},
  {symbol:'AMD',name:'Advanced Micro Devices',nameKr:'AMD',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/amd.com'},
  {symbol:'INTC',name:'Intel Corporation',nameKr:'인텔',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/intel.com'},
  {symbol:'NFLX',name:'Netflix Inc.',nameKr:'넷플릭스',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/netflix.com'},
  {symbol:'PLTR',name:'Palantir Technologies',nameKr:'팔란티어',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/palantir.com'},
  {symbol:'COIN',name:'Coinbase Global',nameKr:'코인베이스',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/coinbase.com'},
  {symbol:'SMCI',name:'Super Micro Computer',nameKr:'슈퍼마이크로',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon'},
  {symbol:'AVGO',name:'Broadcom Inc.',nameKr:'브로드컴',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/broadcom.com'},
  {symbol:'ORCL',name:'Oracle Corporation',nameKr:'오라클',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/oracle.com'},
  {symbol:'CRM',name:'Salesforce Inc.',nameKr:'세일즈포스',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/salesforce.com'},
  {symbol:'ADBE',name:'Adobe Inc.',nameKr:'어도비',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/adobe.com'},
  {symbol:'SNOW',name:'Snowflake Inc.',nameKr:'스노우플레이크',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/snowflake.com'},
  {symbol:'NET',name:'Cloudflare Inc.',nameKr:'클라우드플레어',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/cloudflare.com'},
  {symbol:'CRWD',name:'CrowdStrike Holdings',nameKr:'크라우드스트라이크',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/crowdstrike.com'},
  {symbol:'JPM',name:'JPMorgan Chase',nameKr:'JP모건',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/jpmorganchase.com'},
  {symbol:'V',name:'Visa Inc.',nameKr:'비자',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/visa.com'},
  {symbol:'MA',name:'Mastercard Inc.',nameKr:'마스터카드',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/mastercard.com'},
  {symbol:'WMT',name:'Walmart Inc.',nameKr:'월마트',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/walmart.com'},
  {symbol:'LLY',name:'Eli Lilly',nameKr:'일라이릴리',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/lilly.com'},
  {symbol:'UNH',name:'UnitedHealth Group',nameKr:'유나이티드헬스',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/unitedhealthgroup.com'},
  {symbol:'XOM',name:'ExxonMobil',nameKr:'엑슨모빌',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/exxonmobil.com'},
  {symbol:'BAC',name:'Bank of America',nameKr:'뱅크오브아메리카',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/bankofamerica.com'},
  {symbol:'UBER',name:'Uber Technologies',nameKr:'우버',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/uber.com'},
  {symbol:'SHOP',name:'Shopify Inc.',nameKr:'쇼피파이',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/shopify.com'},
  {symbol:'SPOT',name:'Spotify Technology',nameKr:'스포티파이',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/spotify.com'},
  {symbol:'RBLX',name:'Roblox Corporation',nameKr:'로블록스',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/roblox.com'},
  {symbol:'HOOD',name:'Robinhood Markets',nameKr:'로빈후드',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/robinhood.com'},
  {symbol:'NIO',name:'NIO Inc.',nameKr:'니오',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon'},
  {symbol:'BABA',name:'Alibaba Group',nameKr:'알리바바',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/alibaba.com'},
  {symbol:'TSM',name:'Taiwan Semiconductor',nameKr:'TSMC',exchange:'NYSE',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/tsmc.com'},
  {symbol:'ASML',name:'ASML Holding',nameKr:'ASML',exchange:'NASDAQ',asset_type:'stock',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/asml.com'},
  // Korean stocks (via KIS / Naver)
  {symbol:'005930',name:'Samsung Electronics',nameKr:'삼성전자',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/samsung.com'},
  {symbol:'000660',name:'SK Hynix',nameKr:'SK하이닉스',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/skhynix.com'},
  {symbol:'035420',name:'NAVER Corp.',nameKr:'네이버',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/navercorp.com'},
  {symbol:'035720',name:'Kakao Corp.',nameKr:'카카오',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/kakao.com'},
  {symbol:'373220',name:'LG Energy Solution',nameKr:'LG에너지솔루션',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/lg.com'},
  {symbol:'005380',name:'Hyundai Motor',nameKr:'현대차',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/hyundai.com'},
  {symbol:'068270',name:'Celltrion',nameKr:'셀트리온',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/celltrion.com'},
  {symbol:'000270',name:'Kia Corporation',nameKr:'기아차',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis',logo_url:'https://logo.clearbit.com/kia.com'},
  {symbol:'105560',name:'KB Financial',nameKr:'KB금융',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
  {symbol:'005490',name:'POSCO Holdings',nameKr:'포스코홀딩스',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
  {symbol:'055550',name:'Shinhan Financial',nameKr:'신한지주',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
  {symbol:'259960',name:'Krafton Inc.',nameKr:'크래프톤',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
  {symbol:'323410',name:'KakaoBank',nameKr:'카카오뱅크',exchange:'KRX',asset_type:'krstock',currency:'KRW',provider:'kis'},
  // ETFs
  {symbol:'QQQ',name:'Invesco QQQ Trust',nameKr:'나스닥100 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/invesco.com'},
  {symbol:'SPY',name:'SPDR S&P 500 ETF',nameKr:'S&P500 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/ssga.com'},
  {symbol:'ARKK',name:'ARK Innovation ETF',nameKr:'ARK 혁신 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/ark-invest.com'},
  {symbol:'SOXL',name:'Direxion SOXL',nameKr:'반도체 3배 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/direxion.com'},
  {symbol:'TQQQ',name:'ProShares Ultra QQQ',nameKr:'나스닥 3배 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/proshares.com'},
  {symbol:'SQQQ',name:'ProShares Short QQQ',nameKr:'나스닥 역3배 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon',logo_url:'https://logo.clearbit.com/proshares.com'},
  {symbol:'GDX',name:'VanEck Gold Miners',nameKr:'금광주 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon'},
  {symbol:'TLT',name:'iShares 20Y Treasury',nameKr:'미국채 20년 ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon'},
  {symbol:'DIA',name:'SPDR Dow Jones',nameKr:'다우 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon'},
  {symbol:'IWM',name:'iShares Russell 2000',nameKr:'러셀2000 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon'},
  {symbol:'BOTZ',name:'Global X Robotics',nameKr:'로봇·AI ETF',exchange:'NASDAQ',asset_type:'etf',currency:'USD',provider:'polygon'},
  {symbol:'FNGU',name:'MicroSectors FANG+',nameKr:'FANG+ 3배 ETF',exchange:'NYSE',asset_type:'etf',currency:'USD',provider:'polygon'},
  // Forex
  {symbol:'USDKRW',name:'USD/KRW',nameKr:'달러/원',exchange:'FOREX',asset_type:'forex',currency:'KRW',provider:'exchangerate',isWatchOnly:true},
  {symbol:'USDJPY',name:'USD/JPY',nameKr:'달러/엔',exchange:'FOREX',asset_type:'forex',currency:'JPY',provider:'exchangerate',isWatchOnly:true},
  {symbol:'EURUSD',name:'EUR/USD',nameKr:'유로/달러',exchange:'FOREX',asset_type:'forex',currency:'USD',provider:'exchangerate',isWatchOnly:true},
  {symbol:'GBPUSD',name:'GBP/USD',nameKr:'파운드/달러',exchange:'FOREX',asset_type:'forex',currency:'USD',provider:'exchangerate',isWatchOnly:true},
  {symbol:'USDCNY',name:'USD/CNY',nameKr:'달러/위안',exchange:'FOREX',asset_type:'forex',currency:'CNY',provider:'exchangerate',isWatchOnly:true},
  // Commodities
  {symbol:'GOLD',name:'Gold Spot',nameKr:'금',exchange:'COMMODITY',asset_type:'commodity',currency:'USD',provider:'commodity_api',isWatchOnly:true},
  {symbol:'SILVER',name:'Silver Spot',nameKr:'은',exchange:'COMMODITY',asset_type:'commodity',currency:'USD',provider:'commodity_api',isWatchOnly:true},
  {symbol:'WTI',name:'WTI Crude Oil',nameKr:'원유 WTI',exchange:'COMMODITY',asset_type:'commodity',currency:'USD',provider:'commodity_api',isWatchOnly:true},
  {symbol:'BRENT',name:'Brent Crude Oil',nameKr:'브렌트유',exchange:'COMMODITY',asset_type:'commodity',currency:'USD',provider:'commodity_api',isWatchOnly:true},
  // Indices
  {symbol:'NDX',name:'NASDAQ 100',nameKr:'나스닥100',exchange:'NASDAQ',asset_type:'index',currency:'USD',provider:'mock',isWatchOnly:true},
  {symbol:'SPX',name:'S&P 500',nameKr:'S&P500',exchange:'NYSE',asset_type:'index',currency:'USD',provider:'mock',isWatchOnly:true},
  {symbol:'KSP',name:'KOSPI',nameKr:'코스피',exchange:'KRX',asset_type:'index',currency:'KRW',provider:'mock',isWatchOnly:true},
  {symbol:'KSD',name:'KOSDAQ',nameKr:'코스닥',exchange:'KOSDAQ',asset_type:'index',currency:'KRW',provider:'mock',isWatchOnly:true},
  {symbol:'NKY',name:'Nikkei 225',nameKr:'닛케이225',exchange:'TSE',asset_type:'index',currency:'JPY',provider:'mock',isWatchOnly:true},
  {symbol:'HSI',name:'Hang Seng',nameKr:'항셍',exchange:'HKEX',asset_type:'index',currency:'HKD',provider:'mock',isWatchOnly:true},
  {symbol:'DAX',name:'DAX 40',nameKr:'독일 DAX',exchange:'XETRA',asset_type:'index',currency:'EUR',provider:'mock',isWatchOnly:true},
];

// ── Normalize query for matching ─────────────────────────────
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-\.\/]/g, '');
}

// ── Local mock search ─────────────────────────────────────────
function searchMock(query: string, limit = 20): SearchResult[] {
  const q = normalize(query);
  if (!q || q.length < 1) return [];

  return MOCK_SEARCH_DB.filter(a =>
    normalize(a.symbol).includes(q) ||
    normalize(a.name).includes(q) ||
    normalize(a.nameKr || '').includes(q)
  ).slice(0, limit);
}

// ── Binance symbol search (crypto) ────────────────────────────
async function searchBinance(query: string): Promise<SearchResult[]> {
  try {
    const res = await fetch('https://api.binance.com/api/v3/exchangeInfo', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const q = query.toUpperCase();
    const matches = (data.symbols as any[])
      .filter((s: any) =>
        s.quoteAsset === 'USDT' &&
        s.status === 'TRADING' &&
        (s.baseAsset.includes(q) || s.symbol.includes(q))
      )
      .slice(0, 10)
      .map((s: any): SearchResult => ({
        symbol: s.baseAsset,
        name: s.baseAsset,
        nameKr: MOCK_SEARCH_DB.find(a => a.symbol === s.baseAsset)?.nameKr,
        exchange: 'BINANCE',
        asset_type: 'coin',
        currency: 'USDT',
        provider: 'binance',
        logo_url: MOCK_SEARCH_DB.find(a => a.symbol === s.baseAsset)?.logo_url,
      }));
    return matches;
  } catch {
    return [];
  }
}

// ── CoinGecko search (crypto fallback) ───────────────────────
async function searchCoinGecko(query: string): Promise<SearchResult[]> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.coins || []).slice(0, 8).map((c: any): SearchResult => ({
      symbol: c.symbol?.toUpperCase() || c.id,
      name: c.name,
      exchange: 'BINANCE',
      asset_type: 'coin',
      currency: 'USDT',
      provider: 'coingecko',
      logo_url: c.thumb,
    }));
  } catch {
    return [];
  }
}

// ── Polygon.io search (US stocks) — requires API key ─────────
async function searchPolygon(query: string): Promise<SearchResult[]> {
  const apiKey = (globalThis as any).process?.env?.NEXT_PUBLIC_POLYGON_API_KEY as string | undefined;
  if (!apiKey) return [];
  try {
    const res = await fetch(
      `https://api.polygon.io/v3/reference/tickers?search=${encodeURIComponent(query)}&active=true&limit=10&apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r: any): SearchResult => ({
      symbol: r.ticker,
      name: r.name,
      exchange: r.primary_exchange || 'NASDAQ',
      asset_type: r.type === 'ETF' ? 'etf' : 'stock',
      currency: r.currency_name === 'usd' ? 'USD' : (r.currency_name || 'USD').toUpperCase(),
      provider: 'polygon',
      logo_url: `https://logo.clearbit.com/${r.ticker.toLowerCase()}.com`,
    }));
  } catch {
    return [];
  }
}

// ── Deduplicate results by symbol ─────────────────────────────
function dedup(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter(r => {
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });
}

// ── Main search function ───────────────────────────────────────
export async function searchAssets(
  query: string,
  options: { types?: AssetType[]; limit?: number } = {}
): Promise<{ results: SearchResult[]; source: DataProvider }> {
  const { limit = 20 } = options;
  const q = query.trim();
  if (!q) return { results: [], source: 'mock' };

  // 1. Always start with local mock (instant)
  const localResults = searchMock(q, limit);

  // 2. Try API enrichment (crypto first, then stocks)
  const isCryptoQuery = /btc|eth|sol|xrp|bnb|doge|ada|avax|ton|coin/i.test(q) ||
    localResults.some(r => r.asset_type === 'coin');

  try {
    if (isCryptoQuery) {
      // Try Binance first for crypto
      const binanceResults = await searchBinance(q);
      if (binanceResults.length > 0) {
        return {
          results: dedup([...localResults, ...binanceResults]).slice(0, limit),
          source: 'binance',
        };
      }
      // Fallback to CoinGecko
      const geckoResults = await searchCoinGecko(q);
      if (geckoResults.length > 0) {
        return {
          results: dedup([...localResults, ...geckoResults]).slice(0, limit),
          source: 'coingecko',
        };
      }
    } else {
      // Try Polygon for stocks
      const polygonResults = await searchPolygon(q);
      if (polygonResults.length > 0) {
        return {
          results: dedup([...localResults, ...polygonResults]).slice(0, limit),
          source: 'polygon',
        };
      }
    }
  } catch {}

  // 3. Fall back to local results only
  return {
    results: dedup(localResults).slice(0, limit),
    source: 'mock',
  };
}

// ── Get logo URL with fallback chain ─────────────────────────
export function resolveLogoUrl(
  symbol: string,
  cachedLogoUrl?: string,
  providerLogoUrl?: string
): string | null {
  // 1. Cached logo (user-confirmed)
  if (cachedLogoUrl) return cachedLogoUrl;
  // 2. Provider-supplied logo
  if (providerLogoUrl) return providerLogoUrl;
  // 3. Mock DB lookup
  const mock = MOCK_SEARCH_DB.find(a => a.symbol === symbol);
  if (mock?.logo_url) return mock.logo_url;
  // 4. Clearbit by symbol (best effort)
  const clearbitMap: Record<string, string> = {
    AAPL:'apple.com', MSFT:'microsoft.com', NVDA:'nvidia.com',
    TSLA:'tesla.com', AMZN:'amazon.com', GOOGL:'google.com',
    META:'meta.com', NFLX:'netflix.com', AMD:'amd.com',
    INTC:'intel.com', ORCL:'oracle.com', CRM:'salesforce.com',
  };
  if (clearbitMap[symbol]) return `https://logo.clearbit.com/${clearbitMap[symbol]}`;
  // 5. CoinGecko CDN for crypto
  const geckoMap: Record<string,string> = {
    BTC:'1', ETH:'279', SOL:'4128', BNB:'825', XRP:'44',
    DOGE:'5', ADA:'975', AVAX:'12559', TON:'17980', LINK:'877',
    DOT:'12171', MATIC:'4713', SHIB:'11939', ARB:'16547',
  };
  if (geckoMap[symbol]) return `https://assets.coingecko.com/coins/images/${geckoMap[symbol]}/small/${symbol.toLowerCase()}.png`;
  // 6. Return null → caller shows ticker fallback
  return null;
}

export { MOCK_SEARCH_DB };
export type { SearchResult };
