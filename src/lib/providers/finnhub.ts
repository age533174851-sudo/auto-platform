/**
 * Finnhub API Provider (server-side only)
 * FINNHUB_API_KEY — never expose to client
 */

const BASE = 'https://finnhub.io/api/v1';

async function fhFetch(path: string, params: Record<string,string> = {}): Promise<any> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  try {
    const p = new URLSearchParams({ ...params, token: key });
    const r = await fetch(`${BASE}${path}?${p}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Market news by category: general | forex | crypto | merger */
export async function getMarketNews(category = 'general', minId = 0) {
  const data = await fhFetch('/news', { category, minId: String(minId) });
  if (!Array.isArray(data)) return [];
  return data.slice(0, 20).map((n:any) => ({
    id:       String(n.id),
    title:    n.headline,
    summary:  n.summary,
    source:   n.source,
    url:      n.url,
    image:    n.image || null,
    time:     n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
    category: n.category,
    related:  n.related || '',
    sentiment: null,
  }));
}

/** Company news for a specific ticker */
export async function getCompanyNews(symbol: string, from: string, to: string) {
  const data = await fhFetch('/company-news', { symbol, from, to });
  if (!Array.isArray(data)) return [];
  return data.slice(0, 15).map((n:any) => ({
    id:      String(n.id),
    title:   n.headline,
    summary: n.summary,
    source:  n.source,
    url:     n.url,
    image:   n.image || null,
    time:    n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
    symbol,
  }));
}

/** Economic calendar events */
export async function getEconomicCalendar(from: string, to: string) {
  const data = await fhFetch('/calendar/economic', { from, to });
  if (!data?.economicCalendar) return [];
  return data.economicCalendar.slice(0, 30).map((e:any) => ({
    id:       e.id || String(Math.random()),
    event:    e.event,
    country:  e.country || 'US',
    date:     e.date,
    time:     e.time || '00:00',
    impact:   e.impact === 3 ? 'high' : e.impact === 2 ? 'medium' : 'low',
    previous: e.prev != null ? String(e.prev) : undefined,
    forecast: e.estimate != null ? String(e.estimate) : undefined,
    actual:   e.actual != null ? String(e.actual) : undefined,
    unit:     e.unit,
  }));
}

/** Earnings calendar */
export async function getEarningsCalendar(from: string, to: string) {
  const data = await fhFetch('/calendar/earnings', { from, to, symbol: '' });
  if (!data?.earningsCalendar) return [];
  return data.earningsCalendar.slice(0, 20).map((e:any) => ({
    symbol:     e.symbol,
    date:       e.date,
    hour:       e.hour,
    epsActual:  e.epsActual,
    epsEstimate:e.epsEstimate,
    revenueActual:  e.revenueActual,
    revenueEstimate:e.revenueEstimate,
    quarter:    e.quarter,
    year:       e.year,
  }));
}

/** Company profile */
export async function getCompanyProfile(symbol: string) {
  return await fhFetch('/stock/profile2', { symbol });
}

/** Analyst recommendations */
export async function getRecommendations(symbol: string) {
  const data = await fhFetch('/stock/recommendation', { symbol });
  if (!Array.isArray(data)) return [];
  return data.slice(0, 3);
}

/** News sentiment for a symbol */
export async function getNewsSentiment(symbol: string) {
  return await fhFetch('/news-sentiment', { symbol });
}

/** IPO calendar */
export async function getIPOCalendar(from: string, to: string) {
  const data = await fhFetch('/calendar/ipo', { from, to });
  return data?.ipoCalendar?.slice(0, 10) || [];
}
