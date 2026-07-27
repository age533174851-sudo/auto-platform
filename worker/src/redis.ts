// worker/src/redis.ts — Upstash REST. 미설정 시 available()=false → Supabase 락 폴백
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

// SET key val EX ttl NX → 'OK' 면 락 획득
export async function lockNxEx(key: string, val: string, ttlSec: number): Promise<boolean> {
  const r = await cmd(['SET', key, val, 'EX', ttlSec, 'NX']);
  return r === 'OK';
}
export async function unlock(key: string): Promise<void> { await cmd(['DEL', key]); }
