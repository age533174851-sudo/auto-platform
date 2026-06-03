// /api/backtest — run backtest server-side using Binance kline data + engine
import { NextRequest, NextResponse } from 'next/server';
import { runBacktest, generateSyntheticCandles, type Strategy, type Candle } from '@/lib/backtest/engine';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/* Binance interval map */
const TF_MAP: Record<string, string> = {
  '15m':'15m', '1h':'1h', '4h':'4h', '1d':'1d', '1w':'1w',
};

async function fetchBinanceCandles(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  const interval = TF_MAP[tf] || '1d';
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error('Invalid response');
  return arr.map((k: any[]): Candle => ({
    t: Number(k[0]),
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
  })).filter(c => Number.isFinite(c.c));
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok:false, error:'Invalid JSON body' }, { status: 400 });
  }

  const symbol      = String(body?.symbol || 'BTCUSDT').toUpperCase();
  const strategy    = String(body?.strategy || 'ema-cross') as Strategy;
  const timeframe   = String(body?.timeframe || '1d');
  const initialCash = Number(body?.initialCash) || 1_000_000;
  const feeRate     = Number(body?.feeRate)     || 0.001;
  const leverage    = Number(body?.leverage)    || 1;
  const periodDays  = Number(body?.periodDays)  || 365;

  // Calculate limit based on timeframe + period
  const candlesPerDay: Record<string, number> = {
    '15m': 96, '1h': 24, '4h': 6, '1d': 1, '1w': 1/7,
  };
  const limit = Math.min(1000, Math.ceil(periodDays * (candlesPerDay[timeframe] ?? 1)));

  let candles: Candle[] = [];
  let dataSource: 'binance' | 'synthetic' = 'synthetic';

  try {
    candles = await fetchBinanceCandles(symbol, timeframe, limit);
    if (candles.length >= 30) dataSource = 'binance';
  } catch (e) {
    console.error('[backtest] Binance fetch failed:', e);
  }

  // Fallback: synthetic candles
  if (candles.length < 30) {
    candles = generateSyntheticCandles({
      startPrice: symbol.startsWith('BTC') ? 50_000 : 100,
      count: Math.min(periodDays, 365),
      trend: 0.3,
      volatility: 0.6,
    });
    dataSource = 'synthetic';
  }

  const result = runBacktest(candles, {
    symbol, strategy, initialCash, feeRate, leverage,
    emaFast: body?.emaFast, emaSlow: body?.emaSlow,
    rsiPeriod: body?.rsiPeriod, rsiOversold: body?.rsiOversold, rsiOverbought: body?.rsiOverbought,
    bbPeriod: body?.bbPeriod, bbStd: body?.bbStd,
    dcaIntervalDays: body?.dcaIntervalDays,
  });

  // Sample equity curve (max 100 points)
  const step = Math.max(1, Math.floor(result.equityCurve.length / 100));
  const sampledEquity = result.equityCurve.filter((_, i) => i % step === 0);

  return NextResponse.json({
    ok: true,
    source: dataSource,
    symbol, strategy, timeframe,
    candleCount: result.candleCount,
    summary: {
      finalEquity:    result.finalEquity,
      totalReturnPct: result.totalReturnPct,
      maxDrawdownPct: result.maxDrawdownPct,
      winRate:        result.winRate,
      totalTrades:    result.totalTrades,
      winTrades:      result.winTrades,
      loseTrades:     result.loseTrades,
      avgWinPct:      result.avgWinPct,
      avgLossPct:     result.avgLossPct,
      profitFactor:   result.profitFactor,
      sharpe:         result.sharpe,
    },
    equityCurve: sampledEquity,
    trades: result.trades.slice(-50), // last 50
  });
}
