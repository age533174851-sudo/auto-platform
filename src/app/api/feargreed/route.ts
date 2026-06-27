// /api/feargreed — 공포·탐욕 지수
// 코인: alternative.me Crypto Fear & Greed (무료, 키 불필요)
// 주식: CNN F&G는 비공식이라 코인 지수 기반 + VIX 대용

import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  let crypto: { value: number; label: string } | null = null;
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      const item = d?.data?.[0];
      if (item) {
        const v = parseInt(item.value, 10);
        crypto = { value: v, label: item.value_classification || classify(v) };
      }
    }
  } catch {}

  if (!crypto) crypto = { value: 50, label: 'Neutral' };

  // 공포 구간 판정
  const zone = crypto.value <= 20 ? 'extreme_fear'
    : crypto.value <= 40 ? 'fear'
    : crypto.value <= 60 ? 'neutral'
    : crypto.value <= 80 ? 'greed' : 'extreme_greed';

  return NextResponse.json({
    crypto,
    zone,
    isFearBuyZone: crypto.value <= 20,   // 분할매수 신호
    isGreedSellZone: crypto.value >= 60, // 청산 신호
    at: Date.now(),
  }, { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' } });
}

function classify(v: number): string {
  if (v <= 20) return 'Extreme Fear';
  if (v <= 40) return 'Fear';
  if (v <= 60) return 'Neutral';
  if (v <= 80) return 'Greed';
  return 'Extreme Greed';
}
