// /api/fmp/news — Financial Modeling Prep news
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

const MOCK_NEWS = [
  { symbol:'BTC',  title:'비트코인, 9만 4천 달러 돌파… 기관 매수세 강세',
    site:'TRAIGO', publishedDate: new Date().toISOString(),
    text:'BTC가 신고가를 경신하며 기관 자금 유입이 가속화되고 있습니다.', url:'#', image:null },
  { symbol:'NVDA', title:'엔비디아, AI 칩 수요 폭증으로 분기 매출 사상 최대',
    site:'TRAIGO', publishedDate: new Date(Date.now()-3600_000).toISOString(),
    text:'데이터센터 매출이 전년 동기 대비 154% 증가했습니다.', url:'#', image:null },
  { symbol:'TSLA', title:'테슬라, 차세대 로보택시 공개… 자율주행 가속',
    site:'TRAIGO', publishedDate: new Date(Date.now()-7200_000).toISOString(),
    text:'완전 자율주행 차량 양산이 2026년 초로 앞당겨졌습니다.', url:'#', image:null },
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || '';
  const limit  = parseInt(searchParams.get('limit') || '20');
  const key = process.env.FMP_API_KEY || '';

  if (!key) {
    return NextResponse.json({ ok:true, source:'mock', data: MOCK_NEWS.slice(0, limit) });
  }

  try {
    const url = symbol
      ? `${FMP_BASE}/stock_news?tickers=${symbol}&limit=${limit}&apikey=${key}`
      : `${FMP_BASE}/stock_news?limit=${limit}&apikey=${key}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = await r.json();
    const data = Array.isArray(arr) ? arr.slice(0, limit) : [];
    if (data.length === 0) throw new Error('Empty');
    return NextResponse.json({ ok:true, source:'live', data });
  } catch (e) {
    console.error('[fmp/news]', e);
    return NextResponse.json({ ok:true, source:'mock', data: MOCK_NEWS.slice(0, limit) });
  }
}
