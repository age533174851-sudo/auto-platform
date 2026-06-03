import { NextRequest, NextResponse } from 'next/server';
import { getRSI, getMACD, getBollingerBands, getEMA, getSMA, getDailyCandles, getIntradayCandles } from '@/lib/providers/alphavantage';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action   = searchParams.get('action') || 'candles';
  const symbol   = (searchParams.get('symbol') || 'AAPL').toUpperCase();
  const interval = searchParams.get('interval') || 'daily';
  const period   = parseInt(searchParams.get('period') || '14');

  if (!process.env.ALPHA_VANTAGE_API_KEY || '') {
    return NextResponse.json({ error: 'ALPHA_VANTAGE_API_KEY not configured', source: 'unconfigured' }, { status: 503 });
  }

  // ── Candles ──
  if (action === 'candles') {
    const candles = interval === 'daily'
      ? await getDailyCandles(symbol)
      : await getIntradayCandles(symbol, interval);
    return NextResponse.json({ candles, symbol, interval, source: candles.length > 0 ? 'alphavantage' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }

  // ── RSI ──
  if (action === 'rsi') {
    const data = await getRSI(symbol, period, interval === 'daily' ? 'daily' : '60min');
    return NextResponse.json({ rsi: data, symbol, period, source: data && data.length > 0 ? 'alphavantage' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }

  // ── MACD ──
  if (action === 'macd') {
    const data = await getMACD(symbol, interval === 'daily' ? 'daily' : '60min');
    return NextResponse.json({ macd: data, symbol, source: data && data.length > 0 ? 'alphavantage' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }

  // ── Bollinger Bands ──
  if (action === 'bbands') {
    const data = await getBollingerBands(symbol, period, interval === 'daily' ? 'daily' : '60min');
    return NextResponse.json({ bbands: data, symbol, period, source: data && data.length > 0 ? 'alphavantage' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }

  // ── EMA ──
  if (action === 'ema') {
    const data = await getEMA(symbol, period, interval === 'daily' ? 'daily' : '60min');
    return NextResponse.json({ ema: data, symbol, period, source: data && data.length > 0 ? 'alphavantage' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }

  // ── SMA ──
  if (action === 'sma') {
    const data = await getSMA(symbol, period, interval === 'daily' ? 'daily' : '60min');
    return NextResponse.json({ sma: data, symbol, period, source: data && data.length > 0 ? 'alphavantage' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }

  return NextResponse.json({ error: 'Unknown action', actions: ['candles','rsi','macd','bbands','ema','sma'] }, { status: 400 });
}
