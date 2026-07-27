// /api/regime — 현재 시장 상태(레짐) 판별
import { NextRequest, NextResponse } from 'next/server';
import { detectRegime } from '@/lib/risk/regime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') || 'BTCUSDT').toUpperCase();
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=200`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return NextResponse.json({ error: 'fetch_failed', regime: null });
    const klines: any[] = await r.json();
    const closes = klines.map(k => parseFloat(k[4])).filter(n => !isNaN(n));
    if (closes.length < 60) return NextResponse.json({ error: 'insufficient_data', regime: null });

    const regime = detectRegime(closes);
    let recommendedStrategy = '';
    if (regime.volatility === 'high_vol') recommendedStrategy = '관망 / 포지션 축소';
    else if (regime.trend === 'uptrend') recommendedStrategy = '추세추종 (EMA/MACD)';
    else if (regime.trend === 'downtrend') recommendedStrategy = '숏 또는 관망';
    else recommendedStrategy = '반전매매 (RSI/볼린저)';

    return NextResponse.json({ symbol, regime, recommendedStrategy, source: 'binance', at: Date.now() },
      { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'error', regime: null });
  }
}
