/**
 * src/lib/api/client.ts
 * Centralised data-fetching layer for client components.
 * Components NEVER call external APIs directly — always call these helpers.
 * Each helper returns { data, status, source } so the UI can show LIVE / MOCK / ERROR.
 */

export type DataStatus = 'live' | 'mock' | 'error' | 'loading';

export interface ApiResult<T> {
  data: T;
  status: DataStatus;
  source: string;
  message?: string;
}

/** Generic internal-fetch with timeout + fallback */
async function apiFetch<T>(
  url: string,
  fallback: T,
  timeoutMs = 5000,
): Promise<ApiResult<T>> {
  const ctrl = new AbortController();
  const tid   = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { data: json, status: 'live', source: url };
  } catch (e: unknown) {
    clearTimeout(tid);
    const msg = e instanceof Error ? e.message : 'unknown';
    return { data: fallback, status: 'error', source: url, message: msg };
  }
}

/* ════════════════════════════════════════════════════════════════
   PRICES
   ════════════════════════════════════════════════════════════════ */
export interface PriceItem {
  id: string; symbol: string; nameKr: string;
  price: number; change24h: number; volume: string;
  source: 'binance' | 'mock';
}

export async function fetchPrices(action = 'coin', extra = ''): Promise<ApiResult<PriceItem[]>> {
  const url = `/api/prices?action=${action}${extra ? '&' + extra : ''}`;
  const r   = await apiFetch<any>(url, null);
  if (r.status === 'error' || !r.data) {
    return { data: [], status: 'mock', source: 'mock', message: r.message };
  }
  const raw: any[] = Array.isArray(r.data.results)
    ? r.data.results
    : Array.isArray(r.data) ? r.data : [];
  const items: PriceItem[] = raw.map(t => ({
    id:        t.id       || t.symbol || t.id,
    symbol:    t.symbol   || t.id,
    nameKr:    t.nameKr   || t.name   || t.symbol || t.id,
    price:     t.price    ?? t.p      ?? 0,
    change24h: t.change24h ?? t.c     ?? 0,
    volume:    t.volume24h ?? t.v     ?? '-',
    source:    r.data.source === 'binance' ? 'binance' : 'mock',
  }));
  return { data: items, status: items.length > 0 ? 'live' : 'mock', source: r.data.source || 'api' };
}

export async function fetchCandles(symbol: string, interval = '1h'): Promise<ApiResult<any[]>> {
  return apiFetch<any[]>(`/api/prices?action=candles&symbol=${symbol}&interval=${interval}`, []);
}

export async function fetchGainers(): Promise<ApiResult<PriceItem[]>> {
  return fetchPrices('gainers');
}
export async function fetchLosers(): Promise<ApiResult<PriceItem[]>> {
  return fetchPrices('losers');
}
export async function fetchTrending(): Promise<ApiResult<PriceItem[]>> {
  return fetchPrices('trending');
}

/* ════════════════════════════════════════════════════════════════
   ECONOMIC CALENDAR
   ════════════════════════════════════════════════════════════════ */
export interface CalendarEvent {
  id: string; event: string; country: string;
  date: string; time: string;
  impact: 'high' | 'medium' | 'low';
  forecast?: string; previous?: string; actual?: string; unit?: string;
}

export async function fetchCalendar(): Promise<ApiResult<CalendarEvent[]>> {
  return apiFetch<CalendarEvent[]>('/api/calendar', []);
}

/* ════════════════════════════════════════════════════════════════
   ORDERS (placeOrder — real API plugged in later)
   ════════════════════════════════════════════════════════════════ */
export interface OrderRequest {
  assetId: string; nameKr: string; symbol: string;
  side: 'buy' | 'sell'; amount: number; leverage: number;
  price: number; mode: 'paper' | 'real';
  tp?: number; sl?: number;
}
export interface OrderResult {
  orderId: string; status: 'filled' | 'pending' | 'failed';
  filledPrice: number; fee: number; pnl: number;
  timestamp: number; mode: 'paper' | 'real';
}

export async function placeOrder(req: OrderRequest): Promise<ApiResult<OrderResult>> {
  // Paper-mode: always resolve locally without API call
  if (req.mode === 'paper') {
    const fee = req.amount * 0.001;
    const result: OrderResult = {
      orderId:     'PAPER-' + Date.now().toString(36).toUpperCase(),
      status:      'filled',
      filledPrice: req.price,
      fee,
      pnl:         0,
      timestamp:   Date.now(),
      mode:        'paper',
    };
    // Persist to localStorage
    try {
      const key = 'tg_orders_v1';
      const prev = JSON.parse(localStorage.getItem(key) || '[]');
      prev.unshift({ ...req, ...result, openedAt: new Date().toISOString() });
      if (prev.length > 500) prev.length = 500;
      localStorage.setItem(key, JSON.stringify(prev));
    } catch {}
    return { data: result, status: 'live', source: 'paper' };
  }

  // Real-mode: call internal API route (wires to exchange later)
  return apiFetch<OrderResult>('/api/order', {
    orderId: '', status: 'failed', filledPrice: 0, fee: 0, pnl: 0,
    timestamp: Date.now(), mode: 'real',
  });
}

/* ════════════════════════════════════════════════════════════════
   TAX CALCULATION (pure client-side)
   ════════════════════════════════════════════════════════════════ */
export interface TaxInput {
  assetType: 'coin' | 'us_stock' | 'kr_stock';
  sellPrice: number; buyPrice: number; qty: number;
  feeRate: number;   // e.g. 0.0025 for 0.25%
  exchangeRate?: number; // USD→KRW, default 1
}
export interface TaxResult {
  totalSell: number; totalBuy: number; totalFee: number;
  grossGain: number; deduction: number; taxBase: number;
  taxRate: number;   estTax: number;   netGain: number;
  gainPct: number;
}

export function calcTax(input: TaxInput): TaxResult {
  const fx   = input.exchangeRate ?? 1;
  const sell = input.sellPrice * input.qty * fx;
  const buy  = input.buyPrice  * input.qty * fx;
  const fee  = (sell + buy) * input.feeRate;
  const gross = sell - buy - fee;
  // Korean tax rules (2025, reference only)
  const deduction = input.assetType === 'kr_stock' ? 0 : 2_500_000;
  const taxRate   = input.assetType === 'us_stock' ? 0.22
                  : input.assetType === 'coin'     ? 0.20
                  : 0;
  const taxBase = Math.max(0, gross - deduction);
  const estTax  = Math.round(taxBase * taxRate);
  return {
    totalSell: sell, totalBuy: buy, totalFee: fee,
    grossGain: gross, deduction, taxBase, taxRate, estTax,
    netGain: gross - estTax,
    gainPct: buy > 0 ? (gross / buy) * 100 : 0,
  };
}

/* ════════════════════════════════════════════════════════════════
   PROVIDER STATUS
   ════════════════════════════════════════════════════════════════ */
export interface ProviderStatus {
  name: string; nameKr: string; type: string;
  connected: boolean; note: string;
}

export async function fetchProviderStatus(): Promise<ApiResult<Record<string, ProviderStatus>>> {
  return apiFetch<Record<string, ProviderStatus>>('/api/providers/status', {});
}

/* ════════════════════════════════════════════════════════════════
   SYMBOL → TRADINGVIEW FORMAT
   ════════════════════════════════════════════════════════════════ */
const CRYPTO_TV: Record<string, string> = {
  BTC:'BINANCE:BTCUSDT', ETH:'BINANCE:ETHUSDT', SOL:'BINANCE:SOLUSDT',
  XRP:'BINANCE:XRPUSDT', BNB:'BINANCE:BNBUSDT', DOGE:'BINANCE:DOGEUSDT',
  ADA:'BINANCE:ADAUSDT', AVAX:'BINANCE:AVAXUSDT', TON:'BINANCE:TONUSDT',
  LINK:'BINANCE:LINKUSDT', SHIB:'BINANCE:SHIBUSDT', SUI:'BINANCE:SUIUSDT',
  PEPE:'BINANCE:PEPEUSDT', DOT:'BINANCE:DOTUSDT', MATIC:'BINANCE:MATICUSDT',
  LTC:'BINANCE:LTCUSDT', UNI:'BINANCE:UNIUSDT', ARB:'BINANCE:ARBUSDT',
  OP:'BINANCE:OPUSDT', INJ:'BINANCE:INJUSDT', APT:'BINANCE:APTUSDT',
};
const NASDAQ_STOCKS = new Set([
  'AAPL','MSFT','NVDA','TSLA','GOOGL','GOOG','AMZN','META','AMD','INTC',
  'AVGO','QCOM','PLTR','COIN','MSTR','RIVN','SNOW','CRWD','SHOP','ORCL',
  'ADBE','NFLX','SMCI','PYPL','HOOD',
]);
const AMEX_ETFS = new Set([
  'SPY','QQQ','IWM','DIA','TQQQ','SQQQ','SOXL','SOXS','ARKK',
  'GLD','TLT','USO','UVXY','VXX',
]);

export function toTVSymbol(id: string): string {
  const s = (id || '').toUpperCase().trim().replace(/[-/\s]/g, '');
  if (CRYPTO_TV[s]) return CRYPTO_TV[s];
  if (NASDAQ_STOCKS.has(s)) return `NASDAQ:${s}`;
  if (AMEX_ETFS.has(s))     return `AMEX:${s}`;
  if (/^\d{6}$/.test(s))    return `KRX:${s}`;     // Korean stock
  // Unknown: try crypto first
  return `BINANCE:${s}USDT`;
}
