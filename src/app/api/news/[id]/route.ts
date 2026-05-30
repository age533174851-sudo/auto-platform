// /api/news/[id] — single news item lookup
import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

// In-memory mock store (in production, fetch from DB or news API by ID)
const MOCK_ITEMS: Record<string, any> = {
  'n1': {
    id:'n1',
    title:'비트코인, 9만 4천 달러 돌파… 기관 매수세 강세',
    source:'TRAIGO', publishedAt: new Date().toISOString(),
    category:'coin', sentiment:'bullish',
    tags:['BTC','암호화폐','기관'], tickers:['BTC'],
    summary:'BTC가 사상 최고가에 근접하며 ETF 자금 유입이 가속화되고 있습니다.',
    content:'블랙록 IBIT, 피델리티 FBTC 등 현물 ETF로의 자금 유입이 일주일 만에 23억 달러를 넘어섰습니다. 마이크로스트래티지는 추가로 BTC를 매입했고, 일본·홍콩에서도 현물 ETF 승인이 잇따르고 있습니다.',
    reasons: [
      'BTC 현물 ETF 자금 유입 23억 달러 (1주 기준)',
      '마이크로스트래티지 추가 매입 발표',
      '일본·홍콩 현물 ETF 승인 임박',
    ],
    url:'#',
  },
  'n2': {
    id:'n2',
    title:'엔비디아 분기 매출 사상 최대… AI 칩 수요 폭증',
    source:'TRAIGO', publishedAt: new Date(Date.now()-3600_000).toISOString(),
    category:'stock', sentiment:'bullish',
    tags:['NVDA','AI','반도체'], tickers:['NVDA','AMD'],
    summary:'데이터센터 매출이 전년 대비 154% 급증했습니다.',
    content:'엔비디아는 분기 매출 351억 달러, EPS 4.93달러로 시장 컨센서스를 크게 상회했습니다. 블랙웰 GPU 출하가 본격화되며 차분기 가이던스도 상향 조정되었습니다.',
    reasons: [
      '분기 매출 351억 달러 (컨센서스 상회)',
      'EPS 4.93달러로 어닝 서프라이즈',
      '블랙웰 GPU 출하 본격화 + 가이던스 상향',
    ],
    url:'#',
  },
};

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id = String(params?.id || '').trim();
  if (!id) {
    return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
  }
  const item = MOCK_ITEMS[id];
  if (!item) {
    // Try lookup by hitting the aggregator
    try {
      const url = new URL('/api/market/news', req.nextUrl.origin);
      url.searchParams.set('limit', '50');
      const r = await fetch(url.toString(), { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const d = await r.json();
        const arr = Array.isArray(d?.data) ? d.data : [];
        const hit = arr.find((x: any) => String(x.id) === id);
        if (hit) {
          return NextResponse.json({ ok: true, source: 'aggregator', data: hit });
        }
      }
    } catch (e) {
      console.error('[news/[id]]', e);
    }
    return NextResponse.json({ ok: false, error: 'Not found', id }, { status: 404 });
  }
  return NextResponse.json({ ok: true, source: 'mock', data: item });
}
