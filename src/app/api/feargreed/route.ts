// /api/feargreed — 공포·탐욕 지수
// 코인: alternative.me Crypto Fear & Greed (무료, 키 불필요)
//
// 이 값은 돈을 쓰는 판단에 들어간다. 그래서 **못 읽은 값을 50(중립)으로
// 꾸며서 통과시키지 않는다.** 공급원이 실패하면 unavailable로 답하고
// 화면/전략은 판단을 멈춘다.

import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type CryptoFearGreed = {
  value: number;
  label: string;
  /** 공급원이 이 값을 만든 시각. 응답을 받은 시각으로 세탁하지 않는다. */
  observedAt: number | null;
  /** 공급원이 알려 준 다음 갱신까지 남은 초. 없으면 null. */
  timeUntilUpdateSec: number | null;
  source: 'alternative.me';
};

export async function GET() {
  let crypto: CryptoFearGreed | null = null;
  let upstreamError: string | null = null;

  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', {
      // Next Data Cache에 오래 남기지 않는다. 아래 응답 CDN 캐시가 60초만
      // 공유하므로 사용자가 새로 열거나 자동 갱신하면 최신값을 다시 본다.
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      upstreamError = `upstream_http_${r.status}`;
    } else {
      const d = await r.json();
      const item = d?.data?.[0];
      const v = Number.parseInt(String(item?.value ?? ''), 10);
      if (item && Number.isFinite(v) && v >= 0 && v <= 100) {
        const tsSec = Number(item.timestamp);
        const until = Number(item.time_until_update);
        crypto = {
          value: v,
          label: item.value_classification || classify(v),
          observedAt: Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : null,
          timeUntilUpdateSec: Number.isFinite(until) && until >= 0 ? until : null,
          source: 'alternative.me',
        };
      } else {
        upstreamError = 'upstream_bad_payload';
      }
    }
  } catch {
    upstreamError = 'upstream_unavailable';
  }

  if (!crypto) {
    return NextResponse.json({
      crypto: null,
      zone: null,
      isFearBuyZone: false,
      isGreedSellZone: false,
      source: 'alternative.me',
      error: 'fear_greed_unavailable',
      upstreamError,
      at: Date.now(),
    }, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const zone = crypto.value <= 20 ? 'extreme_fear'
    : crypto.value <= 40 ? 'fear'
    : crypto.value <= 60 ? 'neutral'
    : crypto.value <= 80 ? 'greed' : 'extreme_greed';

  return NextResponse.json({
    crypto,
    zone,
    isFearBuyZone: crypto.value <= 20,
    isGreedSellZone: crypto.value >= 60,
    source: 'alternative.me',
    at: Date.now(),
  }, {
    // 10분 + stale 30분은 지수가 바뀌어도 예전 숫자를 오래 보여줬다.
    // 같은 1분 안의 요청만 공유하고 그 다음 요청은 반드시 재검증한다.
    headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, must-revalidate' },
  });
}

function classify(v: number): string {
  if (v <= 20) return 'Extreme Fear';
  if (v <= 40) return 'Fear';
  if (v <= 60) return 'Neutral';
  if (v <= 80) return 'Greed';
  return 'Extreme Greed';
}
