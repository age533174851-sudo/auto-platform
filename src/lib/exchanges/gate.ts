// Gate.io API Adapter (server-side only)
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.gateio.ws';

function signGate(method: string, path: string, qs: string, body: string, secret: string, ts: string): string {
  const bodyHash = createHmac('sha512','').update(body).digest('hex'); // gate uses sha512 for body
  const payload = `${method}\n${path}\n${qs}\n${bodyHash}\n${ts}`;
  return createHmac('sha512', secret).update(payload).digest('hex');
}

async function gateFetch(path: string, key: string, secret: string) {
  const ts  = Math.floor(Date.now()/1000).toString();
  const sig = signGate('GET', path, '', '', secret, ts);

  const r = await fetch(`${BASE}${path}`, {
    headers: {
      'KEY': key, 'SIGN': sig, 'Timestamp': ts,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function testGate(key: string, secret: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const data = await gateFetch('/api/v4/spot/accounts', key, secret);
    const balances: ExchangeBalance[] = (Array.isArray(data) ? data : [])
      .filter((b: any) => parseFloat(b.available) + parseFloat(b.locked) > 0)
      .slice(0, 20)
      .map((b: any) => ({ currency: b.currency, free: parseFloat(b.available), locked: parseFloat(b.locked), total: parseFloat(b.available)+parseFloat(b.locked) }));
    return { success: true, message: `연결 성공 · ${balances.length}개 자산`, balances,
      permissions: { read: true, trading: false, withdrawal: false }, latencyMs: Date.now()-t0 };
  } catch (e: any) {
    return { success: false, message: e.message || 'Gate.io 연결 실패' };
  }
}

export async function getBalancesGate(key: string, secret: string): Promise<ExchangeBalance[]> {
  const data = await gateFetch('/api/v4/spot/accounts', key, secret);
  return (Array.isArray(data) ? data : [])
    .filter((b: any) => parseFloat(b.available)+parseFloat(b.locked)>0)
    .map((b: any) => ({ currency: b.currency, free: parseFloat(b.available), locked: parseFloat(b.locked), total: parseFloat(b.available)+parseFloat(b.locked) }));
}
