// /api/providers/status
// Reads server-side env vars — never expose to client directly
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({
    binance: {
      name: 'Binance',
      nameKr: '바이낸스',
      type: '코인',
      connected: true,           // Always available (public WebSocket)
      note: 'Public WebSocket',
    },
    exchangeRate: {
      name: 'ExchangeRate',
      nameKr: '환율 API',
      type: '환율',
      connected: true,           // Free, no key needed
      note: '무료 API',
    },
    polygon: {
      name: 'Polygon.io',
      nameKr: '폴리곤',
      type: '미국주식',
      connected: !!process.env.POLYGON_API_KEY,
      note: process.env.POLYGON_API_KEY ? 'API 키 설정됨' : 'POLYGON_API_KEY 필요',
    },
    finnhub: {
      name: 'Finnhub',
      nameKr: '핀허브',
      type: '미국주식',
      connected: !!process.env.FINNHUB_API_KEY,
      note: process.env.FINNHUB_API_KEY ? 'API 키 설정됨' : 'FINNHUB_API_KEY 필요',
    },
    kis: {
      name: 'KIS Open API',
      nameKr: '한국투자증권',
      type: '한국주식',
      connected: !!process.env.KIS_APP_KEY && !!process.env.KIS_APP_SECRET,
      note: (!!process.env.KIS_APP_KEY && !!process.env.KIS_APP_SECRET)
        ? 'API 키 설정됨'
        : 'KIS_APP_KEY / KIS_APP_SECRET 필요',
    },
    commodity: {
      name: 'Commodity API',
      nameKr: '원자재 API',
      type: '원자재',
      connected: !!process.env.COMMODITY_API_KEY,
      note: process.env.COMMODITY_API_KEY ? 'API 키 설정됨' : 'COMMODITY_API_KEY 필요',
    },
    gate: {
      name: 'Gate.io',
      nameKr: '게이트',
      type: '코인',
      connected: !!process.env.GATE_API_KEY && !!process.env.GATE_API_SECRET,
      note: (!!process.env.GATE_API_KEY && !!process.env.GATE_API_SECRET)
        ? 'API 키 설정됨'
        : 'GATE_API_KEY 필요 (선택)',
    },
    tradingEconomics: {
      name: 'Trading Economics',
      nameKr: '트레이딩 이코노믹스',
      type: '경제지표',
      connected: !!process.env.TRADING_ECONOMICS_API_KEY,
      note: process.env.TRADING_ECONOMICS_API_KEY ? 'API 키 설정됨' : 'TRADING_ECONOMICS_API_KEY 필요 (선택)',
    },
  });
}
