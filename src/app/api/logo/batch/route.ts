// /api/logo/batch — resolve multiple logos in ONE request
// POST { symbols: ["AAPL","NVDA","BTC",...], type?: "auto" }
import { NextRequest, NextResponse } from 'next/server';

export const runtime  = 'nodejs';
export const dynamic  = 'force-dynamic';

interface BatchItem {
  symbol:   string;
  logoUrl:  string | null;
  source:   string;
  fallback: boolean;
}

/* Lightweight HEAD-ish probe (Range: 0-0). Returns truthy URL when content-type is image. */
async function probeUrl(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-0', 'User-Agent': 'TRAIGO-LogoBot/1.0' },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok && res.status !== 206) return false;
    const ct = res.headers.get('content-type') || '';
    return ct.startsWith('image/');
  } catch { return false; }
}

/* In-memory cache shared with /api/logo (lambda-scoped) */
const CACHE = new Map<string, BatchItem>();
const CACHE_TS = new Map<string, number>();
const CACHE_TTL = 6 * 60 * 60 * 1000;

function cacheGet(key: string): BatchItem | null {
  const ts = CACHE_TS.get(key);
  if (ts && Date.now() - ts < CACHE_TTL) return CACHE.get(key) || null;
  CACHE.delete(key); CACHE_TS.delete(key);
  return null;
}
function cacheSet(key: string, v: BatchItem) {
  CACHE.set(key, v); CACHE_TS.set(key, Date.now());
}

const COIN_IDS: Record<string,string> = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', XRP:'ripple', BNB:'binancecoin',
  ADA:'cardano', AVAX:'avalanche-2', DOGE:'dogecoin', SHIB:'shiba-inu',
  DOT:'polkadot', LINK:'chainlink', MATIC:'matic-network', LTC:'litecoin',
  TRX:'tron', ATOM:'cosmos', NEAR:'near', UNI:'uniswap', APT:'aptos',
};

const FALLBACK_URL = '/fallback-logo.svg';

function detectType(sym: string): 'crypto' | 'stock' {
  if (COIN_IDS[sym]) return 'crypto';
  // Korean stock = 6 digits
  if (/^\d{6}$/.test(sym)) return 'stock';
  return 'stock';
}

async function resolveSingle(sym: string, defaultType: string): Promise<BatchItem> {
  const cacheKey = `${defaultType}:${sym}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const type = defaultType === 'auto' ? detectType(sym) : defaultType;

  if (type === 'crypto') {
    // For batch we skip CoinGecko call (rate-limited) and use cryptologos CDN
    // Symbol-based predictable URL
    const id = COIN_IDS[sym];
    if (id) {
      // Try CoinGecko direct image URL (CDN)
      const url = `https://assets.coingecko.com/coins/images/1/large/bitcoin.png`;
      // We can't predict the CG image ID without API, so use a known list of asset URLs.
      // For now, fall back to a deterministic /api/logo single call (one extra hop but cached).
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`,
          { signal: AbortSignal.timeout(3500) });
        if (r.ok) {
          const d = await r.json();
          const logo = d?.image?.large || d?.image?.small;
          if (logo) {
            const item: BatchItem = { symbol: sym, logoUrl: logo, source: 'coingecko', fallback: false };
            cacheSet(cacheKey, item);
            return item;
          }
        }
      } catch {}
    }
    const item: BatchItem = { symbol: sym, logoUrl: FALLBACK_URL, source: 'fallback', fallback: true };
    cacheSet(cacheKey, item);
    return item;
  }

  // Stock: FMP CDN (no key needed for image)
  const fmpUrl = `https://financialmodelingprep.com/image-stock/${sym}.png`;
  if (await probeUrl(fmpUrl)) {
    const item: BatchItem = { symbol: sym, logoUrl: fmpUrl, source: 'fmp', fallback: false };
    cacheSet(cacheKey, item);
    return item;
  }
  // EODHD fallback
  if (process.env.EODHD_API_KEY) {
    const eodUrl = `https://eodhd.com/img/logos/US/${sym}.png`;
    if (await probeUrl(eodUrl)) {
      const item: BatchItem = { symbol: sym, logoUrl: eodUrl, source: 'eodhd', fallback: false };
      cacheSet(cacheKey, item);
      return item;
    }
  }
  const item: BatchItem = { symbol: sym, logoUrl: FALLBACK_URL, source: 'fallback', fallback: true };
  cacheSet(cacheKey, item);
  return item;
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); }
  catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }

  const rawSymbols = Array.isArray(body?.symbols) ? body.symbols : [];
  if (rawSymbols.length === 0) {
    return NextResponse.json({ ok: true, items: {} });
  }
  // Limit batch size to prevent abuse
  const symbols = rawSymbols
    .map((s: any) => String(s || '').trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);
  const defaultType = String(body?.type || 'auto').toLowerCase();

  // Resolve in parallel with concurrency 10 (avoid hammering CDN)
  const results: Record<string, BatchItem> = {};
  const queue = [...symbols];
  const CONCURRENCY = 10;

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const sym = queue.shift();
      if (!sym) continue;
      try {
        const item = await resolveSingle(sym, defaultType);
        results[sym] = item;
      } catch {
        results[sym] = { symbol: sym, logoUrl: FALLBACK_URL, source: 'fallback', fallback: true };
      }
    }
  }));

  return NextResponse.json(
    { ok: true, items: results, count: symbols.length },
    { headers: { 'Cache-Control': 'public, max-age=3600' } }
  );
}
