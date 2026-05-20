import { NextResponse } from 'next/server';
import { fetchMarketScore } from '@/lib/market';

export async function GET() {
  const score = await fetchMarketScore('BTCUSDT');
  return NextResponse.json(score, {
    headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' },
  });
}
