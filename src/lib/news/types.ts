// ─────────────────────────────────────────────────────────────
// TRAIGO — News Analysis Types
// 영어 뉴스 → 한글 번역 + AI 분석 (sentiment, prediction, reasons)
// ─────────────────────────────────────────────────────────────

export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';
export type NewsPrediction = 'up' | 'down' | 'flat';

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

// AI 분석 결과
export interface NewsAnalysis {
  // 한글 번역
  titleKo:   string;
  summaryKo: string;     // 1~2줄 자연 한글 요약

  // 영향 예측
  prediction: NewsPrediction;
  confidence: number;    // 0~100
  reasons:    string[];  // 2~4개 근거

  // 영향받을 자산 (뉴스 본문에서 추출 — Fed/CPI 같은 매크로면 비어있을 수도)
  affectedAssets: {
    symbol: string;
    direction: NewsPrediction;
    reason?: string;
  }[];

  // 메타
  source: 'openai' | 'mock' | 'cache';
  analyzedAt: number;    // ms timestamp
}

// 분석이 끝난 뉴스 (Raw + Analysis)
export interface AnalyzedNews extends RawNews {
  analysis?: NewsAnalysis;
  analyzing?: boolean;
  analysisError?: string;
}

// 분석 요청 body
export interface AnalyzeRequest {
  items: {
    id:      string;
    title:   string;
    summary?: string;
    tickers?: string[];
    category?: string;
  }[];
}

// 분석 응답 body
export interface AnalyzeResponse {
  results: Record<string, NewsAnalysis>; // id → analysis
  source: 'openai' | 'mock' | 'mixed';
}

// UI에서 쓰는 라벨 / 색상 헬퍼
export const PREDICTION_LABEL: Record<NewsPrediction, string> = {
  up:   '상승 예상',
  down: '하락 예상',
  flat: '보합 예상',
};

export const PREDICTION_TONE: Record<NewsPrediction, 'green' | 'red' | 'yellow'> = {
  up:   'green',
  down: 'red',
  flat: 'yellow',
};
