// /api/derivatives
// 파생시장 데이터 (펀딩비 + 미결제약정) 조회 및 분석.
// 5v5 전략의 파생 축이 실데이터를 쓸 수 있게 한다.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get('symbols') || url.searchParams.get('symbol') || 'BTCUSDT';
  const exchange = (url.searchParams.get('exchange') || 'binance').toLowerCase() as 'binance' | 'gate';
  const testnet = url.searchParams.get('testnet') === '1';

  const symbols = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);

  try {
    const { getDerivatives, analyzeDerivatives } = await import('@/lib/derivatives');

    const results = await Promise.all(symbols.map(async sym => {
      const snap = await getDerivatives(sym, exchange, testnet);
      const signal = analyzeDerivatives(snap);
      return {
        symbol: sym,
        data: {
          fundingRate: snap.fundingRate,
          nextFundingTime: snap.nextFundingTime,
          openInterest: snap.openInterest,
          openInterestValue: snap.openInterestValue,
          oiChangePct24h: snap.oiChangePct24h,
          priceChangePct24h: snap.priceChangePct24h,
          markPrice: snap.markPrice,
          source: snap.source,
          error: snap.error,
        },
        signal: {
          pattern: signal.pattern,
          patternLabel: signal.patternLabel,
          patternMeaning: signal.patternMeaning,
          longConfirmation: Number(signal.longConfirmation.toFixed(1)),
          shortConfirmation: Number(signal.shortConfirmation.toFixed(1)),
          crowding: signal.crowding,
          crowdingNote: signal.crowdingNote,
          reliability: signal.reliability,
          notes: signal.notes,
        },
      };
    }));

    const anyOk = results.some(r => r.data.fundingRate != null || r.data.openInterest != null);

    return NextResponse.json({
      ok: anyOk,
      exchange, testnet,
      results,
      fetchedAt: new Date().toISOString(),
      note: anyOk ? undefined : '파생 데이터를 가져오지 못했습니다. 거래소 API 접근을 확인하세요.',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || '조회 실패' }, { status: 500 });
  }
}
