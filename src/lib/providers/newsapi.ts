/**
 * NewsAPI Provider (server-side only)
 * NEWS_API_KEY — never expose to client
 */

const BASE = 'https://newsapi.org/v2';

async function newsFetch(path: string, params: Record<string,string>): Promise<any> {
  const key = process.env.NEWS_API_KEY || '';
  if (!key) return null;
  try {
    const p = new URLSearchParams({ ...params, apiKey: key, language: 'en', pageSize: '20' });
    const r = await fetch(`${BASE}${path}?${p}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function detectTickers(text: string): string[] {
  const tickerMap: Record<string,string> = {
    bitcoin:'BTC', ethereum:'ETH', solana:'SOL', nvidia:'NVDA', apple:'AAPL',
    microsoft:'MSFT', tesla:'TSLA', amazon:'AMZN', google:'GOOGL', meta:'META',
    'federal reserve':'DXY', fed:'DXY', fomc:'SPX', 'interest rate':'SPX',
    cpi:'SPX', inflation:'SPX', 'oil':'USOIL', gold:'XAUUSD',
  };
  const found: string[] = [];
  const lower = (text || '').toLowerCase();
  for (const [word, ticker] of Object.entries(tickerMap)) {
    if (lower.includes(word) && !found.includes(ticker)) found.push(ticker);
  }
  return found.slice(0, 4);
}

function detectSentiment(text: string): 'bullish'|'bearish'|'neutral' {
  const lower = (text || '').toLowerCase();
  const bull = ['surge','soar','rally','gain','bullish','rise','breakout','record high','growth'];
  const bear = ['crash','plunge','drop','decline','bearish','fall','collapse','recession','fear'];
  const bs = bull.filter(w => lower.includes(w)).length;
  const brs = bear.filter(w => lower.includes(w)).length;
  return bs > brs ? 'bullish' : brs > bs ? 'bearish' : 'neutral';
}

function mapCategory(source: string, title: string): '코인'|'주식'|'ETF'|'매크로'|'국내'|'AI/테크'|'에너지' {
  const lower = title.toLowerCase();
  if (/bitcoin|crypto|ethereum|blockchain|solana|defi|nft/i.test(lower)) return '코인';
  if (/nvidia|ai|artificial intelligence|machine learning|semiconductor|tech/i.test(lower)) return 'AI/테크';
  if (/oil|energy|opec|brent|crude|natural gas/i.test(lower)) return '에너지';
  if (/etf|fund|index/i.test(lower)) return 'ETF';
  if (/korea|samsung|sk hynix|kospi/i.test(lower)) return '국내';
  if (/fed|fomc|cpi|gdp|inflation|interest rate|treasury/i.test(lower)) return '매크로';
  return '주식';
}

export async function getLatestNews(q = 'stock market OR crypto', sources?: string) {
  const params: Record<string,string> = {
    q, sortBy: 'publishedAt',
    ...(sources ? { sources } : { domains: 'reuters.com,bloomberg.com,cnbc.com,wsj.com,ft.com,marketwatch.com,coindesk.com,cointelegraph.com' }),
  };
  const data = await newsFetch('/everything', params);
  if (!data?.articles) return [];
  return data.articles.slice(0, 20).map((a:any, i:number) => ({
    id:        String(i),
    title:     a.title || '',
    summary:   a.description || '',
    content:   a.content?.replace(/\[\+\d+ chars\]/, '') || '',
    source:    a.source?.name || 'NewsAPI',
    url:       a.url || '#',
    image:     a.urlToImage || null,
    time:      a.publishedAt || new Date().toISOString(),
    tickers:   detectTickers((a.title || '') + ' ' + (a.description || '')),
    sentiment: detectSentiment((a.title || '') + ' ' + (a.description || '')),
    category:  mapCategory(a.source?.name || '', a.title || ''),
    aiSummary: null,
  }));
}

export async function searchNews(query: string) {
  const data = await newsFetch('/everything', { q: query, sortBy: 'relevancy' });
  if (!data?.articles) return [];
  return data.articles.slice(0, 10).map((a:any, i:number) => ({
    id:        String(i),
    title:     a.title || '',
    summary:   a.description || '',
    source:    a.source?.name || '',
    url:       a.url || '#',
    image:     a.urlToImage || null,
    time:      a.publishedAt || '',
    tickers:   detectTickers((a.title||'') + ' ' + (a.description||'')),
    sentiment: detectSentiment((a.title||'') + ' ' + (a.description||'')),
    category:  mapCategory(a.source?.name||'', a.title||''),
  }));
}

export async function getTrendingNews() {
  const data = await newsFetch('/top-headlines', {
    category: 'business',
    country: 'us',
  });
  if (!data?.articles) return [];
  return data.articles.slice(0, 15).map((a:any, i:number) => ({
    id:        String(i),
    title:     a.title || '',
    summary:   a.description || '',
    source:    a.source?.name || '',
    url:       a.url || '#',
    image:     a.urlToImage || null,
    time:      a.publishedAt || '',
    tickers:   detectTickers((a.title||'') + ' ' + (a.description||'')),
    sentiment: detectSentiment((a.title||'') + ' ' + (a.description||'')),
    category:  mapCategory(a.source?.name||'', a.title||''),
  }));
}
