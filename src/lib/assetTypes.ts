// ─────────────────────────────────────────────────────────────
// TRAIGO 확장 가능한 자산 아키텍처 타입 정의
// ─────────────────────────────────────────────────────────────

export type AssetType =
  | 'coin' | 'stock' | 'krstock' | 'jpstock'
  | 'cnstock' | 'eustock' | 'etf' | 'index'
  | 'commodity' | 'forex';

export type Exchange =
  | 'NASDAQ' | 'NYSE' | 'KRX' | 'KOSDAQ'
  | 'TSE' | 'SSE' | 'HKEX' | 'XETRA'
  | 'BINANCE' | 'COINBASE' | 'UPBIT'
  | 'FOREX' | 'COMMODITY' | 'INDEX';

export type DataProvider =
  | 'binance'       // Crypto realtime
  | 'coingecko'     // Crypto fallback
  | 'polygon'       // US stocks
  | 'finnhub'       // US stocks fallback
  | 'alpha_vantage' // US stocks fallback 2
  | 'kis'           // Korean stocks (KIS Open API)
  | 'naver_finance' // Korean stocks fallback
  | 'exchangerate'  // Forex
  | 'commodity_api' // Commodities
  | 'mock';         // Offline fallback

// ── Core Asset (featured / cached / searched) ────────────────
export interface Asset {
  id: string;           // Unique identifier (ticker or coin id)
  nameKr: string;       // Korean name
  name: string;         // English name
  sym: string;          // Display symbol (e.g. "BTC/USDT", "AAPL")
  p: number;            // Current price in KRW
  c: number;            // 24h change %
  v: string;            // Volume string
  t: AssetType;
  clr: string;          // Brand color
  cap?: string;         // Market cap
  sector?: string;      // Sector/category
  exchange?: Exchange;
  currency?: string;    // Native currency of the asset
  provider?: DataProvider;
  isFeatured?: boolean; // Part of built-in featured list
  isWatchOnly?: boolean;// Cannot be paper-traded (indices, etc.)
}

// ── Cached Asset (saved to local/Supabase) ───────────────────
export interface CachedAsset {
  symbol: string;
  name: string;
  nameKr?: string;
  exchange: Exchange | string;
  asset_type: AssetType;
  currency: string;
  logo_url?: string;
  last_price?: number;
  change_pct?: number;
  updated_at: string;   // ISO timestamp
  source: DataProvider;
  is_favorite?: boolean;
}

// ── Search result from external API ──────────────────────────
export interface SearchResult {
  symbol: string;
  name: string;
  nameKr?: string;
  exchange: string;
  asset_type: AssetType;
  currency: string;
  provider: DataProvider;
  logo_url?: string;
  isWatchOnly?: boolean;
}

// ── Provider config ───────────────────────────────────────────
export interface ProviderConfig {
  name: DataProvider;
  label: string;
  assetTypes: AssetType[];
  apiBase: string;
  requiresKey: boolean;
  available: boolean; // runtime check
}

export const PROVIDERS: ProviderConfig[] = [
  { name:'binance',      label:'Binance',        assetTypes:['coin'],                       apiBase:'https://api.binance.com',         requiresKey:false, available:true },
  { name:'coingecko',    label:'CoinGecko',      assetTypes:['coin'],                       apiBase:'https://api.coingecko.com',       requiresKey:false, available:true },
  { name:'polygon',      label:'Polygon.io',     assetTypes:['stock','etf'],                apiBase:'https://api.polygon.io',          requiresKey:true,  available:false },
  { name:'finnhub',      label:'Finnhub',        assetTypes:['stock','etf','forex'],        apiBase:'https://finnhub.io/api/v1',       requiresKey:true,  available:false },
  { name:'alpha_vantage',label:'Alpha Vantage',  assetTypes:['stock','etf','forex'],        apiBase:'https://www.alphavantage.co',     requiresKey:true,  available:false },
  { name:'kis',          label:'KIS Open API',   assetTypes:['krstock'],                    apiBase:'https://openapi.koreainvestment.com', requiresKey:true, available:false },
  { name:'naver_finance',label:'Naver Finance',  assetTypes:['krstock','index'],            apiBase:'https://finance.naver.com',       requiresKey:false, available:false },
  { name:'exchangerate', label:'ExchangeRate',   assetTypes:['forex'],                      apiBase:'https://api.exchangerate-api.com',requiresKey:false, available:true },
  { name:'commodity_api',label:'Commodity API',  assetTypes:['commodity'],                  apiBase:'https://commodities-api.com',     requiresKey:true,  available:false },
  { name:'mock',         label:'Mock (Offline)', assetTypes:['coin','stock','krstock','etf','forex','commodity','index'], apiBase:'', requiresKey:false, available:true },
];
