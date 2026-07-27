// /api/market/news — Aggregated news (NewsAPI + Finnhub + mock fallback)
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

interface NewsItem {
  id:        string;
  title:     string;
  source:    string;
  publishedAt: string;
  category:  'coin' | 'stock' | 'macro' | 'korea' | 'etf' | 'general';
  sentiment: 'bullish' | 'bearish' | 'neutral';
  tags:      string[];
  summary:   string;
  content:   string;
  url?:      string;
}

const MOCK_NEWS: NewsItem[] = [
  { id:'n1', title:'비트코인, 9만 4천 달러 돌파… 기관 매수세 강세',
    source:'TRAIGO', publishedAt: new Date().toISOString(),
    category:'coin', sentiment:'bullish', tags:['BTC','암호화폐','기관'],
    summary:'BTC가 사상 최고가에 근접하며 ETF 자금 유입이 가속화되고 있습니다.',
    content:'블랙록 IBIT, 피델리티 FBTC 등 현물 ETF로의 자금 유입이 일주일 만에 23억 달러를 넘어섰습니다. 마이크로스트래티지는 추가로 BTC를 매입했고, 일본·홍콩에서도 현물 ETF 승인이 잇따르고 있습니다.',
    url:'#' },
  { id:'n2', title:'엔비디아 분기 매출 사상 최대… AI 칩 수요 폭증',
    source:'TRAIGO', publishedAt: new Date(Date.now()-3600_000).toISOString(),
    category:'stock', sentiment:'bullish', tags:['NVDA','AI','반도체'],
    summary:'데이터센터 매출이 전년 대비 154% 급증했습니다.',
    content:'엔비디아는 분기 매출 351억 달러, EPS 4.93달러로 시장 컨센서스를 크게 상회했습니다. 블랙웰 GPU 출하가 본격화되며 차분기 가이던스도 상향 조정되었습니다.',
    url:'#' },
  { id:'n3', title:'FOMC, 5월 금리 동결 시사… 시장 안도',
    source:'TRAIGO', publishedAt: new Date(Date.now()-7200_000).toISOString(),
    category:'macro', sentiment:'neutral', tags:['FOMC','금리','달러'],
    summary:'파월 의장은 인플레이션 진정 시 인하 가능성을 언급했습니다.',
    content:'연준은 기준금리를 5.25-5.50%로 유지했습니다. 핵심 PCE가 목표치에 근접하고 있어 하반기 인하 기대감이 커지고 있습니다.',
    url:'#' },
  { id:'n4', title:'삼성전자, HBM3E 양산 본격화… 외인 매수 유입',
    source:'TRAIGO', publishedAt: new Date(Date.now()-10800_000).toISOString(),
    category:'korea', sentiment:'bullish', tags:['삼성전자','HBM','반도체'],
    summary:'엔비디아 공급 승인 임박 소식에 7만 5천원선 회복.',
    content:'삼성전자가 8단 HBM3E 양산을 시작했다는 외신 보도에 외국인 순매수가 3거래일 연속 이어지고 있습니다. SK하이닉스와의 격차 축소가 기대됩니다.',
    url:'#' },
  { id:'n5', title:'SOXL, 반도체 ETF 거래량 폭증',
    source:'TRAIGO', publishedAt: new Date(Date.now()-14400_000).toISOString(),
    category:'etf', sentiment:'bullish', tags:['SOXL','반도체','ETF'],
    summary:'엔비디아 어닝 서프라이즈에 3배 레버리지 ETF 강세.',
    content:'필라델피아 반도체 지수가 4% 상승하며 SOXL은 12% 급등했습니다. 기관 자금 유입이 이어지고 있습니다.',
    url:'#' },
  { id:'n6', title:'이더리움 ETF 승인, 8월 거래 개시 유력',
    source:'TRAIGO', publishedAt: new Date(Date.now()-18000_000).toISOString(),
    category:'coin', sentiment:'bullish', tags:['ETH','ETF','SEC'],
    summary:'SEC가 8개 발행사의 S-1 수정안을 검토 중입니다.',
    content:'블랙록, 피델리티, 그레이스케일 등이 출시한 이더리움 현물 ETF가 NYSE 등록 절차를 진행 중입니다. 스테이킹은 제외될 가능성이 높습니다.',
    url:'#' },
];

function sentimentFromTitle(title: string): 'bullish'|'bearish'|'neutral' {
  const t = title.toLowerCase();
  const bull = ['surge','rally','jump','soar','beat','high','상승','급등','돌파','강세'];
  const bear = ['fall','drop','plunge','crash','miss','low','하락','급락','약세','폭락'];
  if (bull.some(k => t.includes(k))) return 'bullish';
  if (bear.some(k => t.includes(k))) return 'bearish';
  return 'neutral';
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const category = (searchParams.get('category') || 'all').toLowerCase();
  const query    = searchParams.get('q') || searchParams.get('query') || '';
  const limit    = parseInt(searchParams.get('limit') || '30');

  const newsKey = process.env.NEWS_API_KEY || '';
  const finnKey = process.env.FINNHUB_API_KEY || '';
  const items: NewsItem[] = [];
  let source = 'mock';

  // Try NewsAPI first
  if (newsKey && items.length === 0) {
    try {
      const q = query || (category === 'coin' ? 'cryptocurrency' :
                          category === 'korea' ? 'samsung OR korea stock' :
                          category === 'macro' ? 'federal reserve OR inflation' :
                          'stock market');
      const r = await fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=${limit}&apiKey=${newsKey}`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const d = await r.json();
        const articles = Array.isArray(d.articles) ? d.articles : [];
        for (const a of articles.slice(0, limit)) {
          items.push({
            id:          a.url || `na-${items.length}`,
            title:       a.title || 'Untitled',
            source:      a.source?.name || 'NewsAPI',
            publishedAt: a.publishedAt || new Date().toISOString(),
            category:    category as any === 'all' ? 'general' : (category as any),
            sentiment:   sentimentFromTitle(a.title || ''),
            tags:        [],
            summary:     a.description || '',
            content:     a.content || a.description || '',
            url:         a.url,
          });
        }
        if (items.length > 0) source = 'newsapi';
      }
    } catch (e) { console.error('[market/news] NewsAPI:', e); }
  }

  // Try Finnhub fallback
  if (finnKey && items.length === 0) {
    try {
      const cat = category === 'coin' ? 'crypto' :
                  category === 'macro' ? 'general' :
                  category === 'korea' ? 'general' : 'general';
      const r = await fetch(
        `https://finnhub.io/api/v1/news?category=${cat}&token=${finnKey}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const arr = await r.json();
        const filtered = Array.isArray(arr) ? arr.slice(0, limit) : [];
        for (const a of filtered) {
          const ts = a.datetime ? a.datetime * 1000 : Date.now();
          items.push({
            id:          String(a.id || `fh-${items.length}`),
            title:       a.headline || 'Untitled',
            source:      a.source || 'Finnhub',
            publishedAt: new Date(ts).toISOString(),
            category:    category as any === 'all' ? 'general' : (category as any),
            sentiment:   sentimentFromTitle(a.headline || ''),
            tags:        (a.related || '').split(',').filter(Boolean).slice(0, 5),
            summary:     a.summary || '',
            content:     a.summary || '',
            url:         a.url,
          });
        }
        if (items.length > 0) source = source === 'mock' ? 'finnhub' : source;
      }
    } catch (e) { console.error('[market/news] Finnhub:', e); }
  }

  // Mock fallback
  let data = items.length > 0 ? items : MOCK_NEWS;
  if (category !== 'all') data = data.filter(n => n.category === category);
  if (query) {
    const q = query.toLowerCase();
    data = data.filter(n => n.title.toLowerCase().includes(q) ||
                            (n.tags || []).some(t => t.toLowerCase().includes(q)));
  }
  data = data.slice(0, limit);

  return NextResponse.json({ ok:true, source, total: data.length, data },
    { headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } });
}
