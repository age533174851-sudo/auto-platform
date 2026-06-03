// src/lib/auth/geoip.ts
// IP → country / city 조회 (서버 사이드 전용)
//
// 제공: ip-api.com (무료, 분당 45회 제한, HTTPS는 유료 — http만 사용)
// 폴백: Vercel 헤더 (x-vercel-ip-country, x-vercel-ip-city)
//
// IP가 사설망/loopback이면 조회 안 함.

interface GeoResult { country: string | null; city: string | null; }

const memCache = new Map<string, { result: GeoResult; at: number }>();
const TTL_MS = 24 * 60 * 60 * 1000;   // 24시간

function isPrivateIP(ip: string): boolean {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('10.'))      return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // IPv6 ULA
  return false;
}

// Vercel/Cloudflare 헤더에서 조회 (가장 빠름, 비용 0)
export function geoFromHeaders(headers: Headers): GeoResult {
  const country = headers.get('x-vercel-ip-country') ||
                  headers.get('cf-ipcountry') ||
                  null;
  const cityRaw = headers.get('x-vercel-ip-city') ||
                  headers.get('cf-ipcity') || null;
  // 도시는 URL-encoded 일 수 있음
  const city = cityRaw ? decodeURIComponent(cityRaw) : null;
  return { country, city };
}

// 외부 API 조회 (Vercel 헤더 없을 때)
// ipwho.is — HTTPS, 무료, 키 불필요 (rate limit 10k/월)
export async function lookupGeoIP(ip: string): Promise<GeoResult> {
  if (!ip || isPrivateIP(ip)) return { country: null, city: null };

  // 캐시
  const cached = memCache.get(ip);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.result;

  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,country,city`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return { country: null, city: null };
    const d = await r.json();
    if (d?.success !== true) return { country: null, city: null };
    const result: GeoResult = {
      country: d.country_code || d.country || null,
      city:    d.city || null,
    };
    memCache.set(ip, { result, at: Date.now() });
    return result;
  } catch {
    return { country: null, city: null };
  }
}

// 통합: 헤더 우선, 없으면 외부 조회
export async function resolveGeoIP(req: Request, ip: string): Promise<GeoResult> {
  const fromHeaders = geoFromHeaders(req.headers);
  if (fromHeaders.country || fromHeaders.city) return fromHeaders;
  return lookupGeoIP(ip);
}
