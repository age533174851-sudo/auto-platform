/**
 * src/lib/tvSymbol.ts
 * THE ONE AND ONLY TradingView symbol resolver.
 *
 * Idempotent: if input already has EXCHANGE: prefix, returns unchanged.
 * Accepts: 'BTC', 'btc', 'BTCUSDT', 'BTC/USDT', 'bitcoin', 'BINANCE:BTCUSDT',
 *          { symbol: 'BTC' }, { id: 'BTC' }, { sym: 'BTCUSDT' }
 */

type AssetLike = string | null | undefined | {
  symbol?: string;
  sym?:    string;
  ticker?: string;
  id?:     string;
};

// Known valid TradingView exchange prefixes
const VALID_PREFIXES = new Set([
  'BINANCE', 'BYBIT', 'OKX', 'COINBASE', 'KRAKEN', 'BITSTAMP',
  'NASDAQ', 'NYSE', 'AMEX', 'CBOE', 'KRX', 'KOSDAQ',
  'OANDA', 'FX_IDC', 'TVC', 'CME', 'CBOT', 'COMEX',
  'TSE', 'HKEX', 'SSE', 'SZSE', 'LSE', 'XETR', 'EURONEXT',
]);

// Coin name → ticker (handles "bitcoin", "ethereum" etc.)
const COIN_NAMES: Record<string, string> = {
  BITCOIN: 'BTC', ETHEREUM: 'ETH', SOLANA: 'SOL', RIPPLE: 'XRP',
  BINANCECOIN: 'BNB', DOGECOIN: 'DOGE', CARDANO: 'ADA', AVALANCHE: 'AVAX',
  TONCOIN: 'TON', CHAINLINK: 'LINK', SHIBAINU: 'SHIB', SUI: 'SUI',
  PEPE: 'PEPE', POLKADOT: 'DOT', POLYGON: 'MATIC', ARBITRUM: 'ARB',
  OPTIMISM: 'OP', LITECOIN: 'LTC',
};

// Crypto symbols → use BINANCE
const CRYPTO_SYMS = new Set([
  'BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','TON','LINK',
  'SHIB','SUI','PEPE','LTC','MATIC','DOT','ARB','OP','UNI','APT','INJ',
  'NEAR','ATOM','FIL','ETC','XLM','HBAR','TRX','BCH','ICP','VET',
]);

// US stocks → NASDAQ
const NASDAQ_STOCKS = new Set([
  'AAPL','MSFT','NVDA','TSLA','GOOGL','GOOG','AMZN','META','AMD','INTC',
  'AVGO','QCOM','PLTR','COIN','MSTR','RIVN','SNOW','CRWD','SHOP','ORCL',
  'ADBE','NFLX','SMCI','PYPL','HOOD','MU','DELL','SBUX','CSCO','TSM',
  'QQQ','TQQQ','SQQQ',  // some ETFs trade on NASDAQ
]);

// ETFs on AMEX
const AMEX_ETFS = new Set([
  'SPY','IWM','DIA','SOXL','SOXS','ARKK','GLD','TLT','USO','UVXY','VXX',
  'XLF','XLK','XLE','XLV','XLI','XLP','XLY','XLU','XLB','XLRE','XLC',
]);

/** Single source of truth for TradingView symbols */
export function toTradingViewSymbol(asset: AssetLike): string {
  // 1. Extract raw string
  let raw: string;
  if (asset == null) {
    return 'BINANCE:BTCUSDT';
  } else if (typeof asset === 'string') {
    raw = asset;
  } else {
    raw = String(asset.symbol || asset.sym || asset.ticker || asset.id || '');
  }
  raw = raw.toUpperCase().trim();
  if (!raw) return 'BINANCE:BTCUSDT';

  // 2. ALREADY HAS PREFIX → validate and return as-is (idempotent)
  if (raw.includes(':')) {
    const [prefix, ...rest] = raw.split(':');
    const ticker = rest.join(':'); // handle weird cases
    if (VALID_PREFIXES.has(prefix) && ticker) {
      return `${prefix}:${ticker}`;
    }
    // Invalid prefix → strip and re-resolve
    raw = ticker;
  }

  // 3. Clean known suffixes/separators
  let s = raw.replace(/[-/\s]/g, '');

  // 4. Resolve full coin names ("BITCOIN" → "BTC")
  if (COIN_NAMES[s]) s = COIN_NAMES[s];

  // 5. Strip USDT/USD suffix from crypto pairs
  let core = s;
  if (s.endsWith('USDT')) core = s.slice(0, -4);
  else if (s.endsWith('USD') && s.length > 3) core = s.slice(0, -3);

  // 6. Match against known sets
  if (CRYPTO_SYMS.has(core))     return `BINANCE:${core}USDT`;
  if (NASDAQ_STOCKS.has(core))   return `NASDAQ:${core}`;
  if (AMEX_ETFS.has(core))       return `AMEX:${core}`;
  if (/^\d{6}$/.test(core))      return `KRX:${core}`; // Korean stock code

  // 7. Heuristic fallback
  if (/^\d{6}$/.test(s))         return `KRX:${s}`;
  if (s.endsWith('USDT'))        return `BINANCE:${s}`;
  if (s.length >= 1 && s.length <= 5 && /^[A-Z]+$/.test(s)) return `NASDAQ:${s}`;

  // 8. Final fallback
  return `BINANCE:${s || 'BTC'}USDT`;
}

// Convenience alias
export const toTVSymbol = toTradingViewSymbol;
export const resolveTVSym = toTradingViewSymbol;
