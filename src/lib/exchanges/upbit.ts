// Upbit API Adapter (server-side only)
// Docs: https://docs.upbit.com/
import { createHmac, createHash, randomUUID } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.upbit.com';

function makeJWT(key: string, secret: string): string {
  // Build JWT manually (no external dep)
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    access_key: key,
    nonce: randomUUID(),
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function upbitFetch(path: string, key: string, secret: string) {
  const token = makeJWT(key, secret);
  const r = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(()=>({}));
    throw new Error(err.error?.message || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function testUpbit(key: string, secret: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const data = await upbitFetch('/v1/accounts', key, secret);
    const balances: ExchangeBalance[] = (Array.isArray(data) ? data : [])
      .filter((b: any) => parseFloat(b.balance) + parseFloat(b.locked) > 0)
      .slice(0, 20)
      .map((b: any) => ({
        currency: b.currency,
        free:     parseFloat(b.balance),
        locked:   parseFloat(b.locked),
        total:    parseFloat(b.balance)+parseFloat(b.locked),
        valueKRW: parseFloat(b.avg_buy_price||'0') * (parseFloat(b.balance)+parseFloat(b.locked)),
      }));
    return {
      success: true, message: `연결 성공 · ${balances.length}개 자산`, balances,
      permissions: { read: true, trading: false, withdrawal: false },
      latencyMs: Date.now()-t0,
    };
  } catch (e: any) {
    return { success: false, message: e.message || '업비트 연결 실패' };
  }
}

export async function getBalancesUpbit(key: string, secret: string): Promise<ExchangeBalance[]> {
  const data = await upbitFetch('/v1/accounts', key, secret);
  return (Array.isArray(data) ? data : [])
    .filter((b: any) => parseFloat(b.balance)+parseFloat(b.locked)>0)
    .map((b: any) => ({
      currency: b.currency,
      free:     parseFloat(b.balance),
      locked:   parseFloat(b.locked),
      total:    parseFloat(b.balance)+parseFloat(b.locked),
      valueKRW: parseFloat(b.avg_buy_price||'0')*(parseFloat(b.balance)+parseFloat(b.locked)),
    }));
}
