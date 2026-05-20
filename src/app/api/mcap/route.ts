import { NextRequest, NextResponse } from 'next/server';

const KRW = 1375;

// ─── Mock data (authoritative fallback) ───────────────────────
const MOCK: Record<string, any> = {
  NVDA:  { name:'엔비디아',   nameEn:'NVIDIA',        mcapT: 3.35, px: 874,    chg: +2.14, country:'🇺🇸', cat:['글로벌','미국','기술주','AI/반도체'] },
  MSFT:  { name:'마이크로소프트', nameEn:'Microsoft',  mcapT: 3.18, px: 428,    chg: +0.63, country:'🇺🇸', cat:['글로벌','미국','기술주','AI/반도체'] },
  AAPL:  { name:'애플',       nameEn:'Apple',         mcapT: 3.10, px: 201,    chg: +0.42, country:'🇺🇸', cat:['글로벌','미국','기술주'] },
  GOOGL: { name:'알파벳',     nameEn:'Alphabet',      mcapT: 2.35, px: 193,    chg: +1.05, country:'🇺🇸', cat:['글로벌','미국','기술주','AI/반도체'] },
  AMZN:  { name:'아마존',     nameEn:'Amazon',        mcapT: 2.25, px: 212,    chg: +0.88, country:'🇺🇸', cat:['글로벌','미국','기술주'] },
  META:  { name:'메타',       nameEn:'Meta',          mcapT: 1.72, px: 683,    chg: +1.35, country:'🇺🇸', cat:['글로벌','미국','기술주','AI/반도체'] },
  AVGO:  { name:'브로드컴',   nameEn:'Broadcom',      mcapT: 1.08, px: 236,    chg: +3.21, country:'🇺🇸', cat:['글로벌','미국','기술주','AI/반도체'] },
  TSLA:  { name:'테슬라',     nameEn:'Tesla',         mcapT: 0.98, px: 305,    chg: -1.20, country:'🇺🇸', cat:['글로벌','미국','기술주'] },
  BRK:   { name:'버크셔해서웨이', nameEn:'Berkshire', mcapT: 1.05, px: 466820, chg: +0.21, country:'🇺🇸', cat:['글로벌','미국'] },
  TSM:   { name:'TSMC',       nameEn:'TSMC',          mcapT: 0.93, px: 181,    chg: +1.88, country:'🇹🇼', cat:['글로벌','AI/반도체'] },
  // Korean stocks (KRX)
  '005930': { name:'삼성전자', nameEn:'Samsung',      mcapT: 0.31, px: 57900,  chg: -0.52, country:'🇰🇷', cat:['글로벌','한국','AI/반도체'], isKRW: true },
  '000660': { name:'SK하이닉스', nameEn:'SK Hynix',   mcapT: 0.12, px: 176500, chg: +2.11, country:'🇰🇷', cat:['한국','AI/반도체'], isKRW: true },
  '035420': { name:'NAVER',   nameEn:'Naver',         mcapT: 0.035,px: 218000, chg: +0.46, country:'🇰🇷', cat:['한국','기술주'], isKRW: true },
  '035720': { name:'카카오',  nameEn:'Kakao',         mcapT: 0.015,px: 38850,  chg: -0.90, country:'🇰🇷', cat:['한국','기술주'], isKRW: true },
  '068270': { name:'셀트리온', nameEn:'Celltrion',    mcapT: 0.025,px: 168000, chg: +1.20, country:'🇰🇷', cat:['한국'], isKRW: true },
};

// ─── Fetch live prices from Polygon (US stocks) ───────────────
async function fetchPolygonPrices(tickers: string[]): Promise<Record<string, number>> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return {};
  try {
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${key}`;
    const r   = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return {};
    const data = await r.json();
    const out: Record<string, number> = {};
    for (const t of data.tickers || []) {
      const px = t.day?.c || t.lastTrade?.p || 0;
      if (px > 0) out[t.ticker] = px;
    }
    return out;
  } catch { return {}; }
}

// ─── GET /api/mcap ─────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const cat   = searchParams.get('cat') || '글로벌';
  const limit = Math.min(20, parseInt(searchParams.get('limit') || '10'));

  // Filter by category
  const filtered = Object.entries(MOCK)
    .filter(([, d]) => cat === '전체' || d.cat.includes(cat))
    .map(([ticker, d]) => ({ ticker, ...d }));

  // Sort by market cap desc
  const sorted = filtered.sort((a, b) => b.mcapT - a.mcapT).slice(0, limit);
  const usTickers = sorted.filter(s => !s.isKRW).map(s => s.ticker);

  // Try to get live prices for US stocks
  let livePrices: Record<string, number> = {};
  if (usTickers.length > 0) {
    livePrices = await fetchPolygonPrices(usTickers);
  }

  const result = sorted.map((s, i) => {
    const livePrice = livePrices[s.ticker];
    const price = livePrice || s.px;
    const priceKRW = s.isKRW ? price : price * KRW;
    const mcapKRW  = s.mcapT * 1e12 * (s.isKRW ? 1 : KRW);

    return {
      rank:    i + 1,
      ticker:  s.ticker,
      name:    s.name,
      nameEn:  s.nameEn,
      country: s.country,
      price,
      priceKRW,
      priceUSD: s.isKRW ? price / KRW : price,
      mcapT:   s.mcapT,
      mcapKRW,
      change:  s.chg,
      isKRW:   !!s.isKRW,
      isLive:  !!livePrice,
      cat:     s.cat,
    };
  });

  return NextResponse.json({
    data:      result,
    cat,
    source:    Object.keys(livePrices).length > 0 ? 'polygon+mock' : 'mock',
    timestamp: Date.now(),
  }, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
  });
}
