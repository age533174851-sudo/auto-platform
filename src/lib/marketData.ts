/**
 * TRAIGO Unified Market Data Provider
 * Priority: Polygon → Finnhub → Alpha Vantage → Mock
 */

const KRW = 1375;

export interface OHLCV { t:number; o:number; h:number; l:number; c:number; v:number; }
export interface StockQuote { ticker:string; price:number; change:number; changePct:number; volume:number; source:string; }

/** US Stock candles — tries Polygon → Alpha Vantage → null */
export async function getStockCandles(
  ticker: string, interval: string, limit = 200
): Promise<OHLCV[]> {
  // 1. Polygon
  const polyKey = process.env.POLYGON_API_KEY;
  if (polyKey) {
    try {
      const tsMap: Record<string,string> = {'1m':'minute','5m':'minute','15m':'minute','1h':'hour','4h':'hour','1d':'day','1w':'week'};
      const multMap: Record<string,string> = {'5m':'5','15m':'15','4h':'4'};
      const ts  = tsMap[interval] || 'day';
      const mul = multMap[interval] || '1';
      const from = new Date(Date.now()-limit*86400000).toISOString().split('T')[0];
      const to   = new Date().toISOString().split('T')[0];
      const r = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${mul}/${ts}/${from}/${to}?adjusted=true&sort=asc&limit=${limit}&apiKey=${polyKey}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const d = await r.json();
        if (d.results?.length) return d.results.map((b:any) => ({ t:b.t,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v }));
      }
    } catch {}
  }

  // 2. Alpha Vantage fallback
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (avKey) {
    try {
      const fn  = interval === '1d' ? 'TIME_SERIES_DAILY' : interval === '1w' ? 'TIME_SERIES_WEEKLY' : 'TIME_SERIES_DAILY';
      const r = await fetch(
        `https://www.alphavantage.co/query?function=${fn}&symbol=${ticker}&outputsize=compact&apikey=${avKey}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const d = await r.json();
        const key = Object.keys(d).find(k => k.includes('Time Series'));
        if (key && d[key]) {
          return Object.entries(d[key]).slice(0, limit).reverse().map(([date, v]: [string, any]) => ({
            t: new Date(date).getTime(),
            o: parseFloat(v['1. open']),
            h: parseFloat(v['2. high']),
            l: parseFloat(v['3. low']),
            c: parseFloat(v['4. close']),
            v: parseFloat(v['5. volume']),
          }));
        }
      }
    } catch {}
  }

  return [];
}

/** Technical indicators via Alpha Vantage */
export async function getIndicator(
  ticker: string,
  indicator: 'RSI'|'MACD'|'BBANDS'|'EMA'|'SMA',
  period = 14
): Promise<any> {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!avKey) return null;
  const fnMap = { RSI:'RSI', MACD:'MACD', BBANDS:'BBANDS', EMA:'EMA', SMA:'SMA' };
  try {
    const params = new URLSearchParams({
      function: fnMap[indicator],
      symbol:   ticker,
      interval: 'daily',
      time_period: String(period),
      series_type: 'close',
      apikey: avKey,
    });
    const r = await fetch(`https://www.alphavantage.co/query?${params}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
