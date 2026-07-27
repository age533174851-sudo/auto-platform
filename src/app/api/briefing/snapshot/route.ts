// /api/briefing/snapshot
// 실시간 시장 스냅샷 — BTC/ETH 가격, Fear&Greed, 펀딩비, 시장 점수
//
// 외부 API:
// - Binance ticker  (BTC/ETH 가격, 24h 변동)
// - alternative.me (Crypto Fear & Greed Index — 공개, 무료)
// - Binance futures premiumIndex (펀딩비)
//
// 실패는 부분 응답 — 가능한 만큼만 반환

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Snapshot {
  btc: { price: number; change24h: number; volume24h: number } | null;
  eth: { price: number; change24h: number; volume24h: number } | null;
  fearGreed: { value: number; classification: string; updatedAt: string } | null;
  funding:   { btc: number; eth: number } | null;       // 펀딩비 %
  marketScore: number;     // 0~100 종합 점수
  scoreLabel:  'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';
  signals: string[];       // 자동 추론 시그널 (예: "F&G 75 — 과열")
  updatedAt: number;
  partial: boolean;
}

async function fetchBinanceTicker(symbol: string) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();
    return {
      price:     parseFloat(d.lastPrice),
      change24h: parseFloat(d.priceChangePercent),
      volume24h: parseFloat(d.quoteVolume),
    };
  } catch { return null; }
}

async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1',
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();
    const item = d?.data?.[0];
    if (!item) return null;
    return {
      value:          parseInt(item.value, 10),
      classification: String(item.value_classification || ''),
      updatedAt:      item.timestamp ? new Date(parseInt(item.timestamp) * 1000).toISOString() : '',
    };
  } catch { return null; }
}

async function fetchFundingRate(symbol: string) {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat(d.lastFundingRate) * 100;   // 비율 → %
  } catch { return null; }
}

function classifyFG(v: number): Snapshot['scoreLabel'] {
  if (v < 25) return 'extreme_fear';
  if (v < 45) return 'fear';
  if (v < 55) return 'neutral';
  if (v < 75) return 'greed';
  return 'extreme_greed';
}

function buildSignals(snap: Omit<Snapshot,'signals'|'marketScore'|'scoreLabel'|'partial'>): string[] {
  const out: string[] = [];

  if (snap.fearGreed) {
    if (snap.fearGreed.value < 25)      out.push(`공포 지수 ${snap.fearGreed.value} — 극도의 공포, 역발상 매수 구간`);
    else if (snap.fearGreed.value > 75) out.push(`공포·탐욕 ${snap.fearGreed.value} — 극도의 탐욕, 조정 가능성`);
    else if (snap.fearGreed.value > 60) out.push(`공포·탐욕 ${snap.fearGreed.value} — 탐욕 진입, 과열 주의`);
    else if (snap.fearGreed.value < 40) out.push(`공포·탐욕 ${snap.fearGreed.value} — 공포 우세, 분할 매수 고려`);
  }

  if (snap.btc) {
    if (snap.btc.change24h >  5) out.push(`BTC 24시간 +${snap.btc.change24h.toFixed(2)}% — 강한 상승`);
    if (snap.btc.change24h < -5) out.push(`BTC 24시간 ${snap.btc.change24h.toFixed(2)}% — 강한 하락`);
  }

  if (snap.eth && snap.btc) {
    // ETH/BTC 상대 강도
    const diff = snap.eth.change24h - snap.btc.change24h;
    if (diff >  3) out.push(`ETH가 BTC 대비 ${diff.toFixed(1)}%p 강세 — 알트시즌 신호`);
    if (diff < -3) out.push(`ETH가 BTC 대비 ${Math.abs(diff).toFixed(1)}%p 약세 — BTC 도미넌스 상승`);
  }

  if (snap.funding) {
    if (snap.funding.btc >  0.05) out.push(`BTC 펀딩비 +${snap.funding.btc.toFixed(3)}% — 롱 과열, 청산 위험`);
    if (snap.funding.btc < -0.02) out.push(`BTC 펀딩비 ${snap.funding.btc.toFixed(3)}% — 숏 과열, 숏스퀴즈 가능`);
  }

  return out.slice(0, 4);
}

export async function GET() {
  const [btcT, ethT, fg, btcF, ethF] = await Promise.all([
    fetchBinanceTicker('BTCUSDT'),
    fetchBinanceTicker('ETHUSDT'),
    fetchFearGreed(),
    fetchFundingRate('BTCUSDT'),
    fetchFundingRate('ETHUSDT'),
  ]);

  // 종합 점수 계산 (0~100)
  // F&G 본 점수 + 가격 모멘텀 보정
  let score = fg?.value ?? 50;
  if (btcT) score += Math.max(-15, Math.min(15, btcT.change24h * 2));
  if (ethT) score += Math.max(-10, Math.min(10, ethT.change24h * 1.5));
  score = Math.max(0, Math.min(100, score));

  const partialBefore: any = {
    btc:       btcT,
    eth:       ethT,
    fearGreed: fg,
    funding:   (btcF !== null && ethF !== null) ? { btc: btcF, eth: ethF } : null,
    updatedAt: Date.now(),
  };

  const result: Snapshot = {
    ...partialBefore,
    marketScore: Math.round(score),
    scoreLabel:  classifyFG(score),
    signals:     buildSignals(partialBefore),
    partial:     !btcT || !ethT || !fg,
  };

  return NextResponse.json(result, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
    },
  });
}
