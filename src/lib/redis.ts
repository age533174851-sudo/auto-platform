// src/lib/redis.ts
// Upstash Redis REST 래퍼 (의존성 없이 fetch). 미설정 시 모든 명령 no-op(null) → fail-open
// 환경변수: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const URL = process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

export function redisAvailable(): boolean { return !!(URL && TOKEN); }

async function cmd(args: (string | number)[]): Promise<any> {
  if (!redisAvailable()) return null;
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.result ?? null;
  } catch { return null; }
}

export const redis = {
  available: redisAvailable,
  ping:    () => cmd(['PING']),
  get:     (k: string) => cmd(['GET', k]),
  setEx:   (k: string, v: string, ex: number) => cmd(['SET', k, v, 'EX', ex]),
  setNxEx: (k: string, v: string, ex: number) => cmd(['SET', k, v, 'EX', ex, 'NX']),  // 'OK' | null
  incr:    (k: string) => cmd(['INCR', k]),
  expire:  (k: string, ex: number) => cmd(['EXPIRE', k, ex]),
  ttl:     (k: string) => cmd(['TTL', k]),
  del:     (k: string) => cmd(['DEL', k]),
  rpush:   (k: string, v: string) => cmd(['RPUSH', k, v]),
  lrange:  (k: string, a: number, b: number) => cmd(['LRANGE', k, a, b]),
  llen:    (k: string) => cmd(['LLEN', k]),
};
