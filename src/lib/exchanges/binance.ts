// ─────────────────────────────────────────────────────────────
// Binance API Adapter (server-side only)
// Docs: https://binance-docs.github.io/apidocs/spot/en/
// ─────────────────────────────────────────────────────────────
import { createHmac } from 'crypto';
import type { TestResult, ExchangeBalance } from './types';

const BASE = 'https://api.binance.com';

function sign(query: string, secret: string): string {
  return createHmac('sha256', secret).update(query).digest('hex');
}

async function bnFetch(path: string, key: string, secret: string, params: Record<string,string> = {}) {
  const ts  = Date.now().toString();
  const qs  = new URLSearchParams({ ...params, timestamp: ts });
  const sig = sign(qs.toString(), secret);
  qs.set('signature', sig);

  const r = await fetch(`${BASE}${path}?${qs}`, {
    headers: { 'X-MBX-APIKEY': key },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.msg || `HTTP ${r.status}`);
  }
  return r.json();
}

export async function testBinance(key: string, secret: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    // 1. Check account info (requires read permission)
    const account = await bnFetch('/api/v3/account', key, secret);
    const permissions = {
      read:       true,
      trading:    account.canTrade   ?? false,
      withdrawal: account.enableWithdrawals ?? false,
    };

    // 2. Parse balances (non-zero)
    const balances: ExchangeBalance[] = (account.balances || [])
      .filter((b: any) => parseFloat(b.free) + parseFloat(b.locked) > 0)
      .slice(0, 20)
      .map((b: any) => ({
        currency: b.asset,
        free:     parseFloat(b.free),
        locked:   parseFloat(b.locked),
        total:    parseFloat(b.free) + parseFloat(b.locked),
      }));

    return {
      success: true,
      message: `연결 성공 · ${balances.length}개 자산 확인`,
      balances,
      permissions,
      latencyMs: Date.now() - t0,
    };
  } catch (e: any) {
    return { success: false, message: e.message || '연결 실패' };
  }
}

export async function getBalancesBinance(key: string, secret: string): Promise<ExchangeBalance[]> {
  const account = await bnFetch('/api/v3/account', key, secret);
  return (account.balances || [])
    .filter((b: any) => parseFloat(b.free) + parseFloat(b.locked) > 0.000001)
    .map((b: any) => ({
      currency: b.asset,
      free:     parseFloat(b.free),
      locked:   parseFloat(b.locked),
      total:    parseFloat(b.free) + parseFloat(b.locked),
    }));
}
