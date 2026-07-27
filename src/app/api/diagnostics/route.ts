// /api/diagnostics — Live test of all external APIs
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

interface DiagResult {
  id:         string;
  name:       string;
  category:   'market' | 'news' | 'fx' | 'ai' | 'misc';
  hasKey:     boolean;
  status:     'live' | 'mock' | 'error' | 'disabled';
  latencyMs:  number;
  testedAt:   string;
  error?:     string;
  sample?:    string;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T | null; ms: number; err?: string }> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, ms: Date.now() - t0 };
  } catch (e: any) {
    return { result: null, ms: Date.now() - t0, err: e?.message || 'unknown' };
  }
}

async function testBinance(): Promise<DiagResult> {
  const r = await timed(async () => {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    id:'binance', name:'Binance', category:'market',
    hasKey: true, // public endpoint, no key needed
    status: r.result ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result ? `BTC = $${Number(r.result.price).toLocaleString()}` : undefined,
  };
}

async function testFMP(): Promise<DiagResult> {
  const key = process.env.FMP_API_KEY || '';
  if (!key) return {
    id:'fmp', name:'Financial Modeling Prep', category:'market',
    hasKey:false, status:'disabled', latencyMs:0, testedAt:new Date().toISOString(),
  };
  const r = await timed(async () => {
    const res = await fetch(`https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=${key}`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (!Array.isArray(d) || d.length === 0) throw new Error('Empty response');
    return d[0];
  });
  return {
    id:'fmp', name:'Financial Modeling Prep', category:'market',
    hasKey:true,
    status: r.result ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result ? `AAPL = $${r.result.price?.toFixed(2)}` : undefined,
  };
}

async function testEODHD(): Promise<DiagResult> {
  const key = process.env.EODHD_API_KEY || '';
  if (!key) return {
    id:'eodhd', name:'EODHD', category:'market',
    hasKey:false, status:'disabled', latencyMs:0, testedAt:new Date().toISOString(),
  };
  const r = await timed(async () => {
    const res = await fetch(`https://eodhistoricaldata.com/api/real-time/AAPL.US?api_token=${key}&fmt=json`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    id:'eodhd', name:'EODHD', category:'market',
    hasKey:true,
    status: r.result ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result?.close ? `AAPL = $${r.result.close}` : undefined,
  };
}

async function testFinnhub(): Promise<DiagResult> {
  const key = process.env.FINNHUB_API_KEY || '';
  if (!key) return {
    id:'finnhub', name:'Finnhub', category:'market',
    hasKey:false, status:'disabled', latencyMs:0, testedAt:new Date().toISOString(),
  };
  const r = await timed(async () => {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${key}`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    id:'finnhub', name:'Finnhub', category:'market',
    hasKey:true,
    status: r.result?.c ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result?.c ? `AAPL = $${r.result.c}` : undefined,
  };
}

async function testExchangeRate(): Promise<DiagResult> {
  const r = await timed(async () => {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD',
      { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    id:'exchangerate', name:'ExchangeRate-API', category:'fx',
    hasKey: true, // free, no key
    status: r.result?.rates?.KRW ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result?.rates?.KRW ? `USD/KRW = ${Math.round(r.result.rates.KRW)}` : undefined,
  };
}

async function testNewsAPI(): Promise<DiagResult> {
  const key = process.env.NEWS_API_KEY || '';
  if (!key) return {
    id:'newsapi', name:'NewsAPI', category:'news',
    hasKey:false, status:'disabled', latencyMs:0, testedAt:new Date().toISOString(),
  };
  const r = await timed(async () => {
    const res = await fetch(`https://newsapi.org/v2/top-headlines?category=business&pageSize=1&apiKey=${key}`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    id:'newsapi', name:'NewsAPI', category:'news',
    hasKey:true,
    status: r.result?.articles?.length ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result?.totalResults ? `${r.result.totalResults} articles available` : undefined,
  };
}

async function testFinancialJuice(): Promise<DiagResult> {
  // FinancialJuice is widget-based (iframe), no API test
  const mode = process.env.FINANCIALJUICE_MODE || '';
  return {
    id:'financialjuice', name:'FinancialJuice', category:'news',
    hasKey: mode === 'widget' || !!process.env.FINANCIALJUICE_API_KEY,
    status: mode === 'widget' ? 'live' : 'disabled',
    latencyMs: 0, testedAt: new Date().toISOString(),
    sample: mode === 'widget' ? 'Widget embed mode' : undefined,
  };
}

async function testOpenAI(): Promise<DiagResult> {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return {
    id:'openai', name:'OpenAI (Claude API)', category:'ai',
    hasKey:false, status:'disabled', latencyMs:0, testedAt:new Date().toISOString(),
  };
  const r = await timed(async () => {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    id:'openai', name:'OpenAI', category:'ai',
    hasKey:true,
    status: r.result ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result?.data?.length ? `${r.result.data.length} models available` : undefined,
  };
}

async function testPolygon(): Promise<DiagResult> {
  const key = process.env.POLYGON_API_KEY || '';
  if (!key) return {
    id:'polygon', name:'Polygon.io', category:'market',
    hasKey:false, status:'disabled', latencyMs:0, testedAt:new Date().toISOString(),
  };
  const r = await timed(async () => {
    const res = await fetch(`https://api.polygon.io/v3/reference/tickers/AAPL?apiKey=${key}`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  return {
    id:'polygon', name:'Polygon.io', category:'market',
    hasKey:true,
    status: r.result?.results ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result?.results?.name ? `${r.result.results.name}` : undefined,
  };
}


async function testSupabase(): Promise<DiagResult> {
  const hasUrl  = !!process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasAnon = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const hasSrv  = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!hasUrl || !hasAnon) {
    return {
      id:'supabase', name:'Supabase', category:'misc',
      hasKey:false, status:'disabled', latencyMs:0,
      testedAt: new Date().toISOString(),
      sample: 'NEXT_PUBLIC_SUPABASE_URL/ANON_KEY 미설정',
    };
  }
  const r = await timed(async () => {
    const { getSupabaseAdmin } = await import('@/lib/supabase/server');
    const sb = getSupabaseAdmin();
    if (!sb) throw new Error('Admin client init failed');
    const { error } = await sb.from('profiles').select('id').limit(1);
    // PGRST116 means table empty — still a successful connection
    if (error && error.code !== 'PGRST116') throw new Error(error.message);
    return true;
  });
  return {
    id:'supabase', name:'Supabase', category:'misc',
    hasKey: hasUrl && hasAnon && hasSrv,
    status: r.result ? 'live' : 'error',
    latencyMs: r.ms, testedAt: new Date().toISOString(),
    error: r.err,
    sample: r.result ? `DB 연결 정상 (anon✓ ${hasSrv ? '+ service✓' : ''})` : undefined,
  };
}

export async function GET() {
  const tests = await Promise.all([
    testBinance(),
    testExchangeRate(),
    testFMP(),
    testEODHD(),
    testFinnhub(),
    testPolygon(),
    testNewsAPI(),
    testFinancialJuice(),
    testOpenAI(),
    testSupabase(),
  ]);

  const liveCount     = tests.filter(t => t.status === 'live').length;
  const disabledCount = tests.filter(t => t.status === 'disabled').length;
  const errorCount    = tests.filter(t => t.status === 'error').length;
  const avgLatency    = tests
    .filter(t => t.latencyMs > 0)
    .reduce((s, t) => s + t.latencyMs, 0) / Math.max(1, tests.filter(t => t.latencyMs > 0).length);

  return NextResponse.json({
    ok: true,
    summary: {
      total: tests.length,
      live: liveCount,
      disabled: disabledCount,
      error: errorCount,
      avgLatencyMs: Math.round(avgLatency),
    },
    providers: tests,
    testedAt: new Date().toISOString(),
  });
}
