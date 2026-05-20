/**
 * Alpha Vantage Provider — fallback for Polygon
 * ALPHA_VANTAGE_API_KEY — server-side only
 */

const BASE = 'https://www.alphavantage.co/query';

async function avFetch(params: Record<string,string>): Promise<any> {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) return null;
  try {
    const p = new URLSearchParams({ ...params, apikey: key });
    const r = await fetch(`${BASE}?${p}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    if (d['Note'] || d['Information']) return null; // rate limit hit
    return d;
  } catch { return null; }
}

/** Daily OHLCV for a US stock */
export async function getDailyCandles(symbol: string, compact = true) {
  const data = await avFetch({ function:'TIME_SERIES_DAILY', symbol, outputsize: compact ? 'compact' : 'full' });
  if (!data?.['Time Series (Daily)']) return [];
  return Object.entries(data['Time Series (Daily)']).slice(0, 100).reverse().map(([date, v]:any) => ({
    t: new Date(date).getTime(),
    o: parseFloat(v['1. open']),
    h: parseFloat(v['2. high']),
    l: parseFloat(v['3. low']),
    c: parseFloat(v['4. close']),
    v: parseFloat(v['5. volume']),
  }));
}

/** Intraday OHLCV */
export async function getIntradayCandles(symbol: string, interval = '60min') {
  const data = await avFetch({ function:'TIME_SERIES_INTRADAY', symbol, interval, outputsize:'compact' });
  const key  = Object.keys(data||{}).find(k => k.startsWith('Time Series'));
  if (!key || !data?.[key]) return [];
  return Object.entries(data[key]).slice(0, 100).reverse().map(([dt, v]:any) => ({
    t: new Date(dt).getTime(),
    o: parseFloat(v['1. open']),
    h: parseFloat(v['2. high']),
    l: parseFloat(v['3. low']),
    c: parseFloat(v['4. close']),
    v: parseFloat(v['5. volume']),
  }));
}

/** RSI */
export async function getRSI(symbol: string, period = 14, interval = 'daily') {
  const data = await avFetch({ function:'RSI', symbol, interval, time_period:String(period), series_type:'close' });
  if (!data?.['Technical Analysis: RSI']) return [];
  return Object.entries(data['Technical Analysis: RSI']).slice(0, 50).map(([date, v]:any) => ({
    date, value: parseFloat(v.RSI),
  }));
}

/** MACD */
export async function getMACD(symbol: string, interval = 'daily') {
  const data = await avFetch({ function:'MACD', symbol, interval, series_type:'close' });
  if (!data?.['Technical Analysis: MACD']) return [];
  return Object.entries(data['Technical Analysis: MACD']).slice(0, 50).map(([date, v]:any) => ({
    date,
    macd:       parseFloat(v.MACD),
    signal:     parseFloat(v['MACD_Signal']),
    histogram:  parseFloat(v['MACD_Hist']),
  }));
}

/** Bollinger Bands */
export async function getBollingerBands(symbol: string, period = 20, interval = 'daily') {
  const data = await avFetch({ function:'BBANDS', symbol, interval, time_period:String(period), series_type:'close' });
  if (!data?.['Technical Analysis: BBANDS']) return [];
  return Object.entries(data['Technical Analysis: BBANDS']).slice(0, 50).map(([date, v]:any) => ({
    date,
    upper:  parseFloat(v['Real Upper Band']),
    middle: parseFloat(v['Real Middle Band']),
    lower:  parseFloat(v['Real Lower Band']),
  }));
}

/** EMA */
export async function getEMA(symbol: string, period = 20, interval = 'daily') {
  const data = await avFetch({ function:'EMA', symbol, interval, time_period:String(period), series_type:'close' });
  if (!data?.['Technical Analysis: EMA']) return [];
  return Object.entries(data['Technical Analysis: EMA']).slice(0, 50).map(([date, v]:any) => ({
    date, value: parseFloat(v.EMA),
  }));
}

/** SMA */
export async function getSMA(symbol: string, period = 20, interval = 'daily') {
  const data = await avFetch({ function:'SMA', symbol, interval, time_period:String(period), series_type:'close' });
  if (!data?.['Technical Analysis: SMA']) return [];
  return Object.entries(data['Technical Analysis: SMA']).slice(0, 50).map(([date, v]:any) => ({
    date, value: parseFloat(v.SMA),
  }));
}
