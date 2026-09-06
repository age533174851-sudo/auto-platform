// ─────────────────────────────────────────────────────────────
// TRAIGO — News Types
//
// **분석 결과 타입은 여기 없다.** 정본은 하나다:
//   schema.ts NewsAnalysisV2 → news_articles → /api/news/stored → AiVerdictData
//
// 여기 있던 NewsAnalysis · NewsPrediction · AnalyzeRequest/Response는
// 브라우저가 화면을 열 때마다 만들던 두 번째 분석 경로의 타입이었다.
// 그 경로는 호출이 실패하면 값을 지어내서 채웠기 때문에 통째로 없앴다.
// ─────────────────────────────────────────────────────────────

export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';

// 원본 뉴스 (외부 API에서 들어오는 형태)
export interface RawNews {
  id?: string;
  title: string;
  summary?: string;
  content?: string;
  source?: string;
  url?: string;
  image?: string;
  time?: string | number;
  category?: string;
  tickers?: string[];
  sentiment?: NewsSentiment;
}

/**
 * 분석이 붙은 뉴스.
 *
 * 예전에는 여기 `analysis?: NewsAnalysis`가 달려 있었다. 그 타입은 화면이
 * 열릴 때마다 브라우저가 만들던 분석의 모양이었고, 그 경로는 실패하면
 * 키워드와 id 해시로 값을 지어냈다. 지금은 분석 정본이 하나뿐이다 —
 * `news_articles`(← `analyzeOne` ← `schema.validateAnalysis`)이고, 화면은
 * `/api/news/stored`로 읽어 `AiVerdictData`로 그린다.
 */
export interface AnalyzedNews extends RawNews {}
