// src/lib/logoLookup.ts
// 로고 원격 조회 — FMP / EODHD / CoinGecko 순으로 시도하고 실패하면 폴백.
// 서버 전용(API 키를 읽는다). 클라이언트 큐레이션 DB는 logoResolver.ts 쪽.
//
// 이 로직은 원래 src/app/api/logo/route.ts에 있었고 batch/route.ts가
// `import { lookupLogo } from '../route'`로 가져다 썼다. App Router의 route
// 파일은 HTTP 메서드와 정해진 설정값 외의 export를 허용하지 않아
// (.next/types 생성 시 TS2344) 공용 모듈로 분리한다.
//
// 모듈 단위 캐시라 route.ts와 batch/route.ts가 같은 인스턴스를 공유한다 —
// 분리 전과 동일한 동작.

export type AssetType = 'stock' | 'etf' | 'crypto' | 'auto';

export interface LogoResponse {
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

/* Lightweight HEAD-ish check — verify URL actually returns an image. */
async function probeUrl(url: string, timeoutMs = 3000): Promise<boolean> {
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
  } catch {
    return false;
  }
}

const FALLBACK_URL = '';

const COIN_IDS: Record<string,string> = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', XRP:'ripple', BNB:'binancecoin',
  ADA:'cardano', AVAX:'avalanche-2', DOGE:'dogecoin', SHIB:'shiba-inu',
  DOT:'polkadot', LINK:'chainlink', MATIC:'matic-network', LTC:'litecoin',
  TRX:'tron', ATOM:'cosmos', NEAR:'near', UNI:'uniswap', APT:'aptos',
};

// ── 공개 룩업 함수 (/api/logo, /api/logo/batch에서 사용) ─────
export async function lookupLogo(symbolRaw: string, typeRaw: AssetType = 'auto'): Promise<LogoResponse> {
  symbolRaw = (symbolRaw || '').trim().toUpperCase();
  if (!symbolRaw) {
    return { symbol: '', type: 'auto', logoUrl: null, source: 'fallback', fallback: true };
  }
  const cacheKey = `${typeRaw}:${symbolRaw}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Crypto
  if (typeRaw === 'crypto') {
    const id = COIN_IDS[symbolRaw];
    if (id) {
      try {
        const r = await fetch(
          `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`,
          { signal: AbortSignal.timeout(4000) },
        );
        if (r.ok) {
          const d = await r.json();
          const logo = d?.image?.large || d?.image?.small;
          if (logo) {
            const resp: LogoResponse = { symbol: symbolRaw, type: 'crypto', logoUrl: logo, source: 'coingecko', fallback: false };
            cacheSet(cacheKey, resp);
            return resp;
          }
        }
      } catch {}
    }
    const resp: LogoResponse = { symbol: symbolRaw, type: 'crypto', logoUrl: null, source: 'fallback', fallback: true };
    cacheSet(cacheKey, resp);
    return resp;
  }

  // Stock/ETF: FMP → EODHD → fallback
  const EODHD_KEY = process.env.EODHD_API_KEY || '';
  const fmpUrl = `https://site.financialmodelingprep.com/image-stock/${symbolRaw}.png`;
  if (await probeUrl(fmpUrl)) {
    const resp: LogoResponse = { symbol: symbolRaw, type: typeRaw, logoUrl: fmpUrl, source: 'fmp', fallback: false };
    cacheSet(cacheKey, resp);
    return resp;
  }
  if (EODHD_KEY) {
    const eodhdUrl = `https://eodhd.com/img/logos/US/${symbolRaw}.png`;
    if (await probeUrl(eodhdUrl)) {
      const resp: LogoResponse = { symbol: symbolRaw, type: typeRaw, logoUrl: eodhdUrl, source: 'eodhd', fallback: false };
      cacheSet(cacheKey, resp);
      return resp;
    }
  }
  const resp: LogoResponse = { symbol: symbolRaw, type: typeRaw, logoUrl: FALLBACK_URL || null, source: 'fallback', fallback: true };
  cacheSet(cacheKey, resp);
  return resp;
}
