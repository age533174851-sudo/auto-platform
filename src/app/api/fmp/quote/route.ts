// /api/fmp/quote — Financial Modeling Prep quote (server-side, key safe)
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

const MOCK: Record<string, { price: number; change: number; changesPercentage: number; name: string }> = {
  AAPL: { price: 192.5, change: 1.2,  changesPercentage: 0.63,  name: 'Apple Inc.' },
  NVDA: { price: 875.2, change: 28.4, changesPercentage: 3.36,  name: 'NVIDIA Corp.' },
  AMD:  { price: 156.4, change: 3.2,  changesPercentage: 2.09,  name: 'Advanced Micro Devices' },
  PLTR: { price: 24.8,  change: 0.4,  changesPercentage: 1.64,  name: 'Palantir Technologies' },
  COIN: { price: 215.3, change: 8.5,  changesPercentage: 4.11,  name: 'Coinbase Global' },
  SMCI: { price: 38.5,  change: -0.5, changesPercentage: -1.28, name: 'Super Micro Computer' },
  TSLA: { price: 187.2, change: -2.8, changesPercentage: -1.47, name: 'Tesla Inc.' },
  MSFT: { price: 421.8, change: 4.6,  changesPercentage: 1.10,  name: 'Microsoft Corp.' },
  GOOGL:{ price: 175.3, change: 1.5,  changesPercentage: 0.86,  name: 'Alphabet Inc.' },
  META: { price: 512.4, change: 11.5, changesPercentage: 2.30,  name: 'Meta Platforms' },
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') || 'AAPL').toUpperCase().trim();
  const key = process.env.FMP_API_KEY || '';

  if (!key) {
    const m = MOCK[symbol] ?? { price: 0, change: 0, changesPercentage: 0, name: symbol };
    return NextResponse.json({
      ok: true, source: 'mock', symbol,
      data: [{ symbol, name: m.name, price: m.price, change: m.change,
        changesPercentage: m.changesPercentage, image: null }],
    });
  }

  try {
    const [qRes, pRes] = await Promise.all([
      fetch(`${FMP_BASE}/quote/${symbol}?apikey=${key}`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${FMP_BASE}/profile/${symbol}?apikey=${key}`,{ signal: AbortSignal.timeout(5000) }),
    ]);
    const quote   = qRes.ok ? await qRes.json() : null;
    const profile = pRes.ok ? await pRes.json() : null;
    const q = Array.isArray(quote)   ? quote[0]   : null;
    const p = Array.isArray(profile) ? profile[0] : null;

    if (!q) throw new Error('No quote');
    return NextResponse.json({
      ok: true, source: 'live', symbol,
      data: [{
        symbol:            q.symbol            ?? symbol,
        name:              q.name              ?? p?.companyName ?? symbol,
        price:             q.price             ?? 0,
        change:            q.change            ?? 0,
        changesPercentage: q.changesPercentage ?? 0,
        dayHigh:           q.dayHigh           ?? 0,
        dayLow:            q.dayLow            ?? 0,
        volume:            q.volume            ?? 0,
        image:             p?.image            ?? null,
        sector:            p?.sector           ?? null,
      }],
    });
  } catch (e) {
    console.error('[fmp/quote]', e);
    const m = MOCK[symbol] ?? { price: 0, change: 0, changesPercentage: 0, name: symbol };
    return NextResponse.json({
      ok: true, source: 'mock', symbol,
      data: [{ symbol, name: m.name, price: m.price, change: m.change,
        changesPercentage: m.changesPercentage, image: null }],
    });
  }
}
