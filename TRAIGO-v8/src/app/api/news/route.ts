import { NextResponse } from 'next/server';
import { MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';

export async function GET() {
  return NextResponse.json({ news: MOCK_NEWS, events: ECON_EVENTS, timestamp: Date.now() }, {
    headers: { 'Cache-Control': 'public, s-maxage=300' },
  });
}
