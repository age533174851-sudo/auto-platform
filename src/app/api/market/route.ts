// src/app/api/market/route.ts — aggregates crypto + stocks + fx, supports tab/gainers/losers/trending
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const BASE = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

async function fetchInternal(path: string): Promise<any> {
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(6000) });
    if (r.ok) return r.json();
  } catch { /* fall through */ }
  return null;
}

// Convert internal format → unified market row
function toRow(item: any, category: string): any {
  return {
    id:        item.id,
    nameKr:    item.nameKr,
    nameEn:    item.nameEn || item.id,
    sym:       item.sym  || item.id,
    price:     item.price ?? 0,
    priceUsd:  item.priceUsd ?? 0,
    change24h: item.change24h ?? 0,
    volume24h: item.volume24h ?? 0,
    category:  item.category || category,
    logo:      item.logo || item.logoId || item.id.toLowerCase(),
    status:    item.status || 'mock',
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tab      = searchParams.get('tab')      || 'list';
  const category = searchParams.get('category') || 'all';
  const limit    = parseInt(searchParams.get('limit') || '50');

  // Fetch in parallel
  const [cryptoRes, stocksRes] = await Promise.all([
    fetchInternal('/api/crypto'),
    fetchInternal('/api/stocks'),
  ]);

  const cryptoRows = (cryptoRes?.data || []).map((x: any) => toRow(x, 'crypto'));
  const stockRows  = (stocksRes?.data  || []).map((x: any) => toRow(x, 'stock'));

  let all = [...cryptoRows, ...stockRows];

  // Category filter
  if (category !== 'all') {
    all = all.filter(r => r.category === category);
  }

  // Tab / sort
  let sorted = [...all];
  if (tab === 'gainers') {
    sorted = all.sort((a, b) => b.change24h - a.change24h);
  } else if (tab === 'losers') {
    sorted = all.sort((a, b) => a.change24h - b.change24h);
  } else if (tab === 'trending') {
    sorted = all.sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  } else {
    // list: crypto first, then stocks, sorted by marketcap proxy (volume)
    sorted = all.sort((a, b) => {
      if (a.category !== b.category) return a.category === 'crypto' ? -1 : 1;
      return b.volume24h - a.volume24h;
    });
  }

  const data = sorted.slice(0, limit);

  // Determine overall status
  const statuses = new Set([cryptoRes?.status, stocksRes?.status].filter(Boolean));
  const overallStatus = statuses.has('live') && statuses.size > 1 ? 'mixed'
    : statuses.has('live') ? 'live' : 'mock';

  const sources: string[] = [];
  if (cryptoRes?.source) sources.push(cryptoRes.source);
  if (stocksRes?.source)  sources.push(stocksRes.source);

  return NextResponse.json({
    ok: true,
    status: overallStatus,
    source: sources.length ? sources : ['mock'],
    updatedAt: new Date().toISOString(),
    tab, category,
    total: all.length,
    data,
  }, { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20' } });
}
