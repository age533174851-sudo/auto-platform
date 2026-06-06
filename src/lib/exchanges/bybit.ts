// Bybit API Adapter (server-side only)
// Docs: https://bybit-exchange.github.io/docs/v5/
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.bybit.com';

function sign(payload: string, secret: string, ts: string, recvWindow: string): string {
  return createHmac('sha256', secret).update(ts + payload + recvWindow).digest('hex');
}

async function bbFetch(path: string, key: string, secret: string, params: Record<string,string> = {}) {
  const ts  = Date.now().toString();
  const rw  = '5000';
  const qs  = new URLSearchParams(params).toString();
  const sig = sign(qs, secret, ts, rw);

  const r = await fetch(`${BASE}${path}?${qs}`, {
    headers: {
      'X-BAPI-API-KEY':     key,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-RECV-WINDOW': rw,
      'X-BAPI-SIGN':        sig,
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  if (data.retCode !== 0) throw new Error(data.retMsg || 'Bybit error');
  return data.result;
}

export async function testBybit(key: string, secret: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const result = await bbFetch('/v5/account/wallet-balance', key, secret, { accountType: 'UNIFIED' });
    const list = result?.list?.[0]?.coin || [];
    const balances: ExchangeBalance[] = list
      .filter((c: any) => parseFloat(c.equity) > 0)
      .slice(0, 20)
      .map((c: any) => ({
        currency: c.coin,
        free:     parseFloat(c.availableToWithdraw || c.availableToBorrow || '0'),
        locked:   parseFloat(c.locked || '0'),
        total:    parseFloat(c.equity || '0'),
      }));
    return { success: true, message: `연결 성공 · ${balances.length}개 자산`, balances,
      permissions: { read: true, trading: false, withdrawal: false }, latencyMs: Date.now()-t0 };
  } catch (e: any) {
    return { success: false, message: e.message || 'Bybit 연결 실패' };
  }
}

export async function getBalancesBybit(key: string, secret: string): Promise<ExchangeBalance[]> {
  const result = await bbFetch('/v5/account/wallet-balance', key, secret, { accountType: 'UNIFIED' });
  return (result?.list?.[0]?.coin || [])
    .filter((c: any) => parseFloat(c.equity) > 0)
    .map((c: any) => ({
      currency: c.coin,
      free:  parseFloat(c.availableToWithdraw || '0'),
      locked: parseFloat(c.locked || '0'),
      total:  parseFloat(c.equity || '0'),
    }));
}
