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
  //
  // **`source` 는 "어디서 나온 값인가"다.** 캐시는 출처가 아니라
  // 전달 경로다. 예전에는 캐시에서 읽을 때 이 칸을 `'cache'` 로
  // 덮어썼고, 그래서 **mock 이 한 번 캐시를 거치면 `'mock'` 이
  // 사라졌다** — 화면은 그걸 "캐시된 분석"으로 적었고, 실제 분석이었던
  // 적이 없다는 사실이 지워졌다.
  //
  // `'cache'` 값 자체는 **옛 세션 저장소에 남아 있을 수 있어** 유니온에
  // 남긴다. 화면은 그 값을 "출처 미상"으로 적는다 — 지어내지 않는다.
  source: 'openai' | 'mock' | 'cache';
  /** 이번 값이 캐시에서 온 것인가. **출처를 덮어쓰지 않는다** */
  cached?: boolean;
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
