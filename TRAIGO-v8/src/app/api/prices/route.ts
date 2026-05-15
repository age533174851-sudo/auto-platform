import { NextRequest, NextResponse } from 'next/server';

async function fetchBinance(): Promise<Record<string,number>> {
  const symbols = ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','TON','LINK','DOT','MATIC','LTC','ARB','OP'];
  const pairs = symbols.map(s => `"${s}USDT"`).join(',');
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=[${pairs}]`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    const prices: Record<string,number> = {};
    for (const item of data) prices[item.symbol.replace('USDT','')] = parseFloat(item.price);
    return prices;
  } catch { return {}; }
}

export async function GET() {
  const prices = await fetchBinance();
  return NextResponse.json({ source: Object.keys(prices).length > 0 ? 'binance' : 'mock', prices, timestamp: Date.now() }, {
    headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' },
  });
}
