/**
 * src/lib/api.ts — Client-side API helpers
 * Components import ONLY these; never fetch external APIs directly.
 * All calls go through /api/* internal routes.
 */

export type DataStatus = 'live' | 'mixed' | 'mock' | 'error' | 'loading';

export interface MarketRow {
  id:        string;
  nameKr:    string;
  nameEn:    string;
  sym:       string;
  price:     number;
  priceUsd:  number;
  change24h: number;
  volume24h: number;
  category:  string;
  logo:      string;
  status:    'live' | 'mock';
}

export interface CalendarEvent {
  id:       string;
  title:    string;
  country:  string;
  date:     string;
  time:     string;
  dateTime: string;
  impact:   'high' | 'medium' | 'low';
  forecast: string | null;
  previous: string | null;
  actual:   string | null;
}

export interface TaxPayload {
  assetType: 'crypto' | 'stock_us' | 'stock_kr' | 'futures';
  profit:    number;
  feesPaid?: number;
  year?:     number;
}

export interface TaxResult {
  ok:            boolean;
  profit:        number;
  feesPaid:      number;
  netProfit:     number;
  deduction:     number;
  taxableProfit: number;
  taxRate:       number;
  estimatedTax:  number;
  localTax:      number;
  totalTax:      number;
  netAfterTax:   number;
  ruleNote:      string;
  note:          string;
}

/** Thin fetch wrapper — returns null on any error */
async function api<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return r.json() as Promise<T>;
  } catch {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Market data
   ═══════════════════════════════════════════════════════════════ */
export async function getMarketData(
  tab:      'list'|'gainers'|'losers'|'trending' = 'list',
  category: string = 'all',
  limit:    number = 50,
): Promise<{ data: MarketRow[]; status: DataStatus; source: string[] }> {
  const res = await api<any>(
    `/api/market?tab=${tab}&category=${category}&limit=${limit}`
  );
  return {
    data:   (res?.data ?? []) as MarketRow[],
    status: (res?.status ?? 'mock') as DataStatus,
    source: res?.source ?? ['mock'],
  };
}

export async function getCryptoData(ids?: string[]): Promise<{ data: MarketRow[]; status: DataStatus }> {
  const q = ids?.length ? `?ids=${ids.join(',')}` : '';
  const res = await api<any>(`/api/crypto${q}`);
  return { data: res?.data ?? [], status: res?.status ?? 'mock' };
}

export async function getStocksData(ids?: string[]): Promise<{ data: MarketRow[]; status: DataStatus }> {
  const q = ids?.length ? `?ids=${ids.join(',')}` : '';
  const res = await api<any>(`/api/stocks${q}`);
  return { data: res?.data ?? [], status: res?.status ?? 'mock' };
}

export async function getFxRates(): Promise<{ rates: Record<string,number>; status: DataStatus }> {
  const res = await api<any>('/api/fx');
  return { rates: res?.rates ?? { USDKRW: 1375 }, status: res?.status ?? 'mock' };
}

/* ═══════════════════════════════════════════════════════════════
   Economic calendar
   ═══════════════════════════════════════════════════════════════ */
export async function getCalendarEvents(
  lang    = 'ko',
  country = 'all',
  impact  = 'all',
): Promise<{ data: CalendarEvent[]; status: DataStatus; source: string }> {
  const res = await api<any>(
    `/api/calendar?lang=${lang}&country=${country}&impact=${impact}`
  );
  return {
    data:   res?.data ?? [],
    status: res?.status ?? 'mock',
    source: res?.source ?? 'mock',
  };
}

/* ═══════════════════════════════════════════════════════════════
   Tax calculation
   ═══════════════════════════════════════════════════════════════ */
export async function calculateTax(payload: TaxPayload): Promise<TaxResult | null> {
  return api<TaxResult>('/api/tax', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
}

/* ═══════════════════════════════════════════════════════════════
   Provider status
   ═══════════════════════════════════════════════════════════════ */
export async function getProviderStatus(): Promise<Record<string,any>> {
  const res = await api<any>('/api/providers/status');
  return res ?? {};
}

/* ═══════════════════════════════════════════════════════════════
   TradingView symbol helper (client-safe)
   ═══════════════════════════════════════════════════════════════ */
const CRYPTO_SYMS = new Set(['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX',
  'TON','LINK','SHIB','SUI','PEPE','LTC','MATIC','DOT','ARB','OP','UNI','APT','INJ']);
const NASDAQ_SYMS = new Set(['AAPL','MSFT','NVDA','TSLA','GOOGL','GOOG','AMZN',
  'META','AMD','INTC','AVGO','QCOM','PLTR','COIN','MSTR','RIVN','SNOW','CRWD',
  'SHOP','ORCL','ADBE','NFLX','SMCI','PYPL','HOOD']);
const AMEX_SYMS = new Set(['SPY','QQQ','IWM','DIA','TQQQ','SQQQ','SOXL','SOXS',
  'ARKK','GLD','TLT','USO','UVXY','VXX']);

export function toTVSymbol(id: string): string {
  const s = (id || '').toUpperCase().trim().replace(/[-/\s]/g, '');
  if (CRYPTO_SYMS.has(s))  return `BINANCE:${s}USDT`;
  if (NASDAQ_SYMS.has(s))  return `NASDAQ:${s}`;
  if (AMEX_SYMS.has(s))    return `AMEX:${s}`;
  if (/^\d{6}$/.test(s))   return `KRX:${s}`;
  return `BINANCE:${s}USDT`; // default: try as crypto
}
