// Bithumb API Adapter (server-side only)
// Docs: https://apidocs.bithumb.com/
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.bithumb.com';

function signBithumb(endpoint: string, params: string, secret: string, nonce: string): string {
  const str = endpoint + '\0' + params + '\0' + nonce;
  const hmac = createHmac('sha512', secret);
  return Buffer.from(hmac.update(str).digest('hex')).toString('base64');
}

async function bithumbFetch(path: string, key: string, secret: string) {
  const nonce  = Date.now().toString();
  const params = '';
  const sig    = signBithumb(path, params, secret, nonce);

  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Api-Key':   key,
      'Api-Sign':  sig,
      'Api-Nonce': nonce,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== '0000') throw new Error(data.message || '빗썸 오류');
  return data.data;
}

export async function testBithumb(key: string, secret: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const data = await bithumbFetch('/info/balance', key, secret);
    const balances: ExchangeBalance[] = [];
    if (data?.available_krw) {
      balances.push({ currency: 'KRW', free: parseFloat(data.available_krw), locked: parseFloat(data.in_use_krw||'0'), total: parseFloat(data.total_krw||data.available_krw) });
    }
    return { success: true, message: `연결 성공 · KRW 잔고 확인`, balances,
      permissions: { read: true, trading: false, withdrawal: false }, latencyMs: Date.now()-t0 };
  } catch (e: any) {
    return { success: false, message: e.message || '빗썸 연결 실패' };
  }
}

export async function getBalancesBithumb(key: string, secret: string): Promise<ExchangeBalance[]> {
  const data = await bithumbFetch('/info/balance', key, secret);
  if (!data?.available_krw) return [];
  return [{ currency: 'KRW', free: parseFloat(data.available_krw), locked: parseFloat(data.in_use_krw||'0'), total: parseFloat(data.total_krw||data.available_krw) }];
}
