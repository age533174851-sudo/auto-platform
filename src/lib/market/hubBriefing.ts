// src/lib/market/hubBriefing.ts
//
// 허브 「오늘의 시장」 브리핑을 시세 값으로부터 만든다.
//
// **못 읽은 시세를 지어내지 않는다.** 예전 라우트는 Binance를 못 읽으면
// `btcPrice = 94230000` · `btcChg = 2.14` · 펀딩 `0.0001`로 채워 내보냈고,
// 화면은 그것을 "BTC ₩9423만 (+2.14%) · 펀딩 중립 · BULLISH"로 실측처럼
// 그리고 음성으로 읽어 줬다. 못 읽은 칸은 null이고, 요약은 못 읽었다고
// 말한다. 확인하지 못한 것은 통과가 아니다.

export type Sentiment = 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';

export interface MarketRead {
  /** BTCUSDT 현재가(USD). 못 읽었으면 null. */
  priceUsd: number | null;
  /** 24시간 변동률(%). 못 읽었으면 null. */
  chgPct: number | null;
  /** 최근 펀딩비. 못 읽었으면 null. */
  fundingRate: number | null;
}

export interface HubBriefing {
  btcPrice: number | null;
  btcChg: number | null;
  fundingRate: number | null;
  sentiment: Sentiment | null;
  fundBias: string | null;
  /** 가격과 변동률을 둘 다 실제로 읽었는가. */
  marketOk: boolean;
  aiSummary: string;
  source: 'openai' | 'fallback' | 'unavailable';
  timestamp: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function sentimentOf(chgPct: number): Sentiment {
  return chgPct > 3 ? 'STRONG_BULLISH' : chgPct > 1 ? 'BULLISH'
    : chgPct < -3 ? 'STRONG_BEARISH' : chgPct < -1 ? 'BEARISH' : 'NEUTRAL';
}

export function fundBiasOf(fundingRate: number): string {
  return fundingRate > 0.0005 ? '롱 과열' : fundingRate < -0.0001 ? '숏 과열' : '중립';
}

/**
 * @param aiSummary 시세를 넣어 받은 AI 요약. **시세를 못 읽었으면 쓰지 않는다**
 *                  (라우트도 그 경우 AI를 부르지 않는다).
 */
export function briefingFromMarket(
  m: MarketRead, krwPerUsd: number, aiSummary: string | null, nowIso: string,
): HubBriefing {
  const priceOk = finite(m.priceUsd) && m.priceUsd > 0;
  const chgOk = finite(m.chgPct);
  const marketOk = priceOk && chgOk;

  const btcPrice = marketOk ? (m.priceUsd as number) * krwPerUsd : null;
  const btcChg = marketOk ? (m.chgPct as number) : null;
  const sentiment = btcChg == null ? null : sentimentOf(btcChg);
  const fundingRate = finite(m.fundingRate) ? m.fundingRate : null;
  const fundBias = fundingRate == null ? null : fundBiasOf(fundingRate);

  if (!marketOk || btcPrice == null || btcChg == null) {
    return {
      btcPrice: null, btcChg: null, fundingRate, sentiment: null, fundBias,
      marketOk: false,
      aiSummary: 'BTC 시세를 읽지 못했습니다 — 오늘의 시장 요약을 만들 수 없습니다.',
      source: 'unavailable', timestamp: nowIso,
    };
  }

  const man = Math.round(btcPrice / 10000).toLocaleString('ko-KR');
  const plain = `BTC ₩${man}만 (${btcChg >= 0 ? '+' : ''}${btcChg.toFixed(2)}%)`
    + ` · 펀딩 ${fundBias ?? '확인 불가'} · ${sentiment}`;
  return {
    btcPrice, btcChg, fundingRate, sentiment, fundBias, marketOk: true,
    aiSummary: aiSummary || plain,
    source: aiSummary ? 'openai' : 'fallback', timestamp: nowIso,
  };
}
