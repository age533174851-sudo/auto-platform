// /api/logo — Stock/ETF/Crypto logo proxy
// Hides API keys from client, falls back gracefully when sources fail.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type AssetType = 'stock' | 'etf' | 'crypto' | 'auto';

interface LogoResponse {
  symbol:   string;
  type:     AssetType;
  logoUrl:  string | null;
  source:   'fmp' | 'eodhd' | 'coingecko' | 'clearbit' | 'naver' | 'fallback';
  fallback: boolean;
  cached?:  boolean;
}

/* In-memory cache for the lifetime of the lambda. Cleared on cold start. */
const CACHE = new Map<string, LogoResponse>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_TS = new Map<string, number>();

function cacheGet(key: string): LogoResponse | null {
  const ts = CACHE_TS.get(key);
  if (ts && Date.now() - ts < CACHE_TTL_MS) {
    const v = CACHE.get(key);
    if (v) return { ...v, cached: true };
  }
  CACHE.delete(key); CACHE_TS.delete(key);
  return null;
}

function cacheSet(key: string, v: LogoResponse) {
  CACHE.set(key, v); CACHE_TS.set(key, Date.now());
}

/* Lightweight HEAD check — verify URL actually returns an image. */
async function probeUrl(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    // Use GET range to avoid 405 on hosts that block HEAD
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Range': 'bytes=0-0', 'User-Agent': 'TRAIGO-LogoBot/1.0' },
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok && res.status !== 206) return false;
    const ct = res.headers.get('content-type') || '';
    return ct.startsWith('image/');
  } catch {
    return false;
  }
}

const FALLBACK_URL = '/fallback-logo.svg';

export async function GET(req: NextRequest) {
  const url    = req.nextUrl;
  const symbolRaw = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  const typeRaw   = (url.searchParams.get('type')   || 'auto').toLowerCase() as AssetType;

  if (!symbolRaw) {
    return NextResponse.json({
      symbol: '', type: 'auto', logoUrl: null, source: 'fallback', fallback: true,
      error: 'Missing symbol',
    }, { status: 400 });
  }

  const cacheKey = `${typeRaw}:${symbolRaw}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return NextResponse.json(cached, {
      headers: { 'Cache-Control': 'public, max-age=21600' }, // 6h browser cache
    });
  }

  /* Crypto logo via CoinGecko */
  if (typeRaw === 'crypto') {
    const cgUrl = `https://assets.coingecko.com/coins/images/1/large/bitcoin.png`; // placeholder
    // Better: try a known symbol→id mapping (simple set)
    const COIN_IDS: Record<string,string> = {
      BTC:'bitcoin', ETH:'ethereum', SOL:'solana', XRP:'ripple', BNB:'binancecoin',
      ADA:'cardano', AVAX:'avalanche-2', DOGE:'dogecoin', SHIB:'shiba-inu',
      DOT:'polkadot', LINK:'chainlink', MATIC:'matic-network', LTC:'litecoin',
      TRX:'tron', ATOM:'cosmos', NEAR:'near', UNI:'uniswap', APT:'aptos',
    };
    const id = COIN_IDS[symbolRaw];
    if (id) {
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`,
          { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const d = await r.json();
          const logo = d?.image?.large || d?.image?.small;
          if (logo) {
            const resp: LogoResponse = { symbol: symbolRaw, type: 'crypto', logoUrl: logo, source: 'coingecko', fallback: false };
            cacheSet(cacheKey, resp);
            return NextResponse.json(resp, { headers: { 'Cache-Control': 'public, max-age=21600' } });
          }
        }
      } catch {}
    }
    const resp: LogoResponse = { symbol: symbolRaw, type: 'crypto', logoUrl: FALLBACK_URL, source: 'fallback', fallback: true };
    cacheSet(cacheKey, resp);
    return NextResponse.json(resp);
  }

  /* Stock/ETF logo cascade: FMP → EODHD → Clearbit → fallback */
  const FMP_KEY   = process.env.FMP_API_KEY   || '';
  const EODHD_KEY = process.env.EODHD_API_KEY || '';

  // 1. FMP public CDN (no key needed for image)
  const fmpUrl = `https://site.financialmodelingprep.com/image-stock/${symbolRaw}.png`;
  if (await probeUrl(fmpUrl)) {
    const resp: LogoResponse = { symbol: symbolRaw, type: typeRaw, logoUrl: fmpUrl, source: 'fmp', fallback: false };
    cacheSet(cacheKey, resp);
    return NextResponse.json(resp, { headers: { 'Cache-Control': 'public, max-age=21600' } });
  }

  // 2. EODHD logo (with key)
  if (EODHD_KEY) {
    const eodhdUrl = `https://eodhd.com/img/logos/US/${symbolRaw}.png`;
    if (await probeUrl(eodhdUrl)) {
      const resp: LogoResponse = { symbol: symbolRaw, type: typeRaw, logoUrl: eodhdUrl, source: 'eodhd', fallback: false };
      cacheSet(cacheKey, resp);
      return NextResponse.json(resp, { headers: { 'Cache-Control': 'public, max-age=21600' } });
    }
  }

  // 3. Clearbit fallback by domain hint (skip — needs domain)
  // 4. Final fallback
  const resp: LogoResponse = { symbol: symbolRaw, type: typeRaw, logoUrl: FALLBACK_URL, source: 'fallback', fallback: true };
  cacheSet(cacheKey, resp);
  return NextResponse.json(resp);
}
