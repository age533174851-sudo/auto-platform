import { NextRequest, NextResponse } from 'next/server';
import { getLatestNews, searchNews, getTrendingNews } from '@/lib/providers/newsapi';
import { MOCK_NEWS, ECON_EVENTS } from '@/lib/constants';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action') || 'latest';
  const q      = searchParams.get('q') || '';
  const cat    = searchParams.get('cat') || 'general';

  // ── Latest news ──
  if (action === 'latest') {
    const queryMap: Record<string,string> = {
      '코인':    'bitcoin OR ethereum OR crypto OR solana',
      '주식':    'stock market OR NASDAQ OR S&P 500 OR earnings',
      '매크로':  'Federal Reserve OR CPI OR inflation OR GDP OR FOMC',
      'AI/테크': 'artificial intelligence OR NVIDIA OR semiconductor OR tech',
      '에너지':  'oil OR OPEC OR energy OR crude',
      '국내':    'Korea stock OR KOSPI OR Samsung OR SK Hynix',
      'ETF':     'ETF OR index fund OR S&P ETF',
      'general': 'stock market OR crypto OR finance',
    };
    const newsQ = queryMap[cat] || queryMap.general;
    const news  = await getLatestNews(newsQ);
    return NextResponse.json({
      news:   news.length > 0 ? news : MOCK_NEWS,
      source: news.length > 0 ? 'newsapi' : 'mock',
      count:  news.length,
    }, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } });
  }

  // ── Search ──
  if (action === 'search') {
    if (!q) return NextResponse.json({ articles: [], source: 'empty' });
    const news = await searchNews(q);
    return NextResponse.json({ news, source: news.length > 0 ? 'newsapi' : 'empty', query: q }, {
      headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' },
    });
  }

  // ── Trending ──
  if (action === 'trending') {
    const news = await getTrendingNews();
    return NextResponse.json({ news: news.length > 0 ? news : MOCK_NEWS, source: news.length > 0 ? 'newsapi' : 'mock' }, {
      headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' },
    });
  }

  // ── Default (backward-compat) ──
  // **출처를 반드시 붙인다.** 이 분기는 예시만 돌려주는데 source가 없어서,
  // 받는 쪽은 실물인지 예시인지 알 방법이 없었다(feed.provenanceOf는 모르는
  // 값을 SAMPLE로 읽지만, 키 자체가 없으면 그 판정에 닿지도 못한다).
  return NextResponse.json({ news: MOCK_NEWS, events: ECON_EVENTS, source: 'mock', timestamp: Date.now() }, {
    headers: { 'Cache-Control': 'public, s-maxage=300' },
  });
}
