import { NextRequest, NextResponse } from 'next/server';
import { getMarketNews, getCompanyNews, getEconomicCalendar, getEarningsCalendar,
         getCompanyProfile, getRecommendations, getNewsSentiment, getIPOCalendar }
  from '@/lib/providers/finnhub';

// Fallback economic events (shown when Finnhub unavailable)
const MOCK_ECON = [
  {id:'1',event:'미국 CPI (소비자물가지수)',country:'US',date:new Date().toISOString().split('T')[0],time:'21:30',impact:'high',forecast:'3.2%',previous:'3.4%'},
  {id:'2',event:'FOMC 회의록',country:'US',date:new Date(Date.now()+2*86400000).toISOString().split('T')[0],time:'03:00',impact:'high'},
  {id:'3',event:'미국 NFP (비농업고용)',country:'US',date:new Date(Date.now()+5*86400000).toISOString().split('T')[0],time:'21:30',impact:'high',forecast:'185K',previous:'175K'},
  {id:'4',event:'미국 GDP 성장률',country:'US',date:new Date(Date.now()+7*86400000).toISOString().split('T')[0],time:'21:30',impact:'high'},
  {id:'5',event:'ECB 금리 결정',country:'EU',date:new Date(Date.now()+3*86400000).toISOString().split('T')[0],time:'20:15',impact:'high'},
  {id:'6',event:'한국 금통위',country:'KR',date:new Date(Date.now()+4*86400000).toISOString().split('T')[0],time:'10:00',impact:'high'},
  {id:'7',event:'미국 PPI (생산자물가지수)',country:'US',date:new Date(Date.now()+6*86400000).toISOString().split('T')[0],time:'21:30',impact:'medium'},
  {id:'8',event:'미국 실업급여청구건수',country:'US',date:new Date(Date.now()+8*86400000).toISOString().split('T')[0],time:'21:30',impact:'medium',forecast:'215K'},
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'news';
  const symbol = searchParams.get('symbol') || '';

  // ── Market news ──
  if (action === 'news') {
    const cat = searchParams.get('cat') || 'general';
    const data = await getMarketNews(cat);
    return NextResponse.json({
      news:   data.length > 0 ? data : [],
      source: data.length > 0 ? 'finnhub' : 'empty',
      cached: false,
    }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } });
  }

  // ── Company news ──
  if (action === 'company-news') {
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
    const data = await getCompanyNews(symbol, from, to);
    return NextResponse.json({ news: data, symbol, source: data.length > 0 ? 'finnhub' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  }

  // ── Economic calendar ──
  if (action === 'calendar') {
    const from = new Date().toISOString().split('T')[0];
    const to   = new Date(Date.now() + 14*86400000).toISOString().split('T')[0];
    const data = await getEconomicCalendar(from, to);
    return NextResponse.json({
      events: data.length > 0 ? data : MOCK_ECON,
      source: data.length > 0 ? 'finnhub' : 'mock',
    }, { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' } });
  }

  // ── Earnings calendar ──
  if (action === 'earnings') {
    const from = new Date().toISOString().split('T')[0];
    const to   = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
    const data = await getEarningsCalendar(from, to);
    return NextResponse.json({ earnings: data, source: data.length > 0 ? 'finnhub' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    });
  }

  // ── Company profile ──
  if (action === 'profile') {
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const data = await getCompanyProfile(symbol);
    return NextResponse.json({ profile: data, symbol, source: data ? 'finnhub' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=172800' },
    });
  }

  // ── Analyst recommendations ──
  if (action === 'recommendations') {
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const data = await getRecommendations(symbol);
    return NextResponse.json({ recommendations: data, symbol, source: data.length > 0 ? 'finnhub' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    });
  }

  // ── News sentiment ──
  if (action === 'sentiment') {
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const data = await getNewsSentiment(symbol);
    return NextResponse.json({ sentiment: data, symbol, source: data ? 'finnhub' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600' },
    });
  }

  // ── IPO calendar ──
  if (action === 'ipo') {
    const from = new Date().toISOString().split('T')[0];
    const to   = new Date(Date.now() + 60*86400000).toISOString().split('T')[0];
    const data = await getIPOCalendar(from, to);
    return NextResponse.json({ ipos: data, source: data.length > 0 ? 'finnhub' : 'empty' }, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' },
    });
  }

  return NextResponse.json({ error: 'Unknown action', actions: ['news','company-news','calendar','earnings','profile','recommendations','sentiment','ipo'] }, { status: 400 });
}
