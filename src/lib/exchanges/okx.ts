// OKX API Adapter (server-side only)
// Docs: https://www.okx.com/docs-v5/en/
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://www.okx.com';

function signOKX(ts: string, method: string, path: string, body: string, secret: string): string {
  return createHmac('sha256', secret).update(ts + method + path + body).digest('base64');
}

async function okxFetch(path: string, key: string, secret: string, passphrase: string) {
  const ts  = new Date().toISOString();
  const sig = signOKX(ts, 'GET', path, '', secret);

  const r = await fetch(`${BASE}${path}`, {
    headers: {
      'OK-ACCESS-KEY':        key,
      'OK-ACCESS-SIGN':       sig,
      'OK-ACCESS-TIMESTAMP':  ts,
      'OK-ACCESS-PASSPHRASE': passphrase,
      'x-simulated-trading':  '0',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.code !== '0') throw new Error(data.msg || 'OKX error');
  return data.data;
}

export async function testOKX(key: string, secret: string, passphrase: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const data = await okxFetch('/api/v5/account/balance', key, secret, passphrase);
    const details = data?.[0]?.details || [];
    const balances: ExchangeBalance[] = details
      .filter((d: any) => parseFloat(d.eq) > 0)
      .slice(0, 20)
      .map((d: any) => ({
        currency: d.ccy,
        free:  parseFloat(d.availBal || '0'),
        locked: parseFloat(d.frozenBal || '0'),
        total:  parseFloat(d.eq || '0'),
      }));
    return { success: true, message: `연결 성공 · ${balances.length}개 자산`, balances,
      permissions: { read: true, trading: false, withdrawal: false }, latencyMs: Date.now()-t0 };
  } catch (e: any) {
    return { success: false, message: e.message || 'OKX 연결 실패' };
  }
}

export async function getBalancesOKX(key: string, secret: string, passphrase: string): Promise<ExchangeBalance[]> {
  const data = await okxFetch('/api/v5/account/balance', key, secret, passphrase);
  return (data?.[0]?.details || [])
    .filter((d: any) => parseFloat(d.eq) > 0)
    .map((d: any) => ({ currency: d.ccy, free: parseFloat(d.availBal||'0'), locked: parseFloat(d.frozenBal||'0'), total: parseFloat(d.eq||'0') }));
}
