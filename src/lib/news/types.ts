// ─────────────────────────────────────────────────────────────
// TRAIGO — News Analysis Types
// 영어 뉴스 → 한글 번역 + AI 분석 (sentiment, prediction, reasons)
// ─────────────────────────────────────────────────────────────

export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';

// 'unknown'은 'flat'과 다르다.
// flat = "안 움직일 것 같다"(예측), unknown = "모르겠다"(판단 보류).
// 이 자리를 없애면 모델은 언제나 셋 중 하나를 고르고, 근거 없는 추측이
// 예측과 똑같은 모양으로 화면에 남는다. schema.ts의 uncertain이 여기로 온다.
export type NewsPrediction = 'up' | 'down' | 'flat' | 'unknown';

// 원본 뉴스 (외부 API에서 들어오는 형태)
export interface RawNews {
  id?: string;
  title: string;
  summary?: string;
  content?: string;
  source?: string;
  url?: string;
  image?: string;
  /** 표시용. '5분 전' 같은 사람이 읽는 문자열이 들어오기도 한다 — 시각 계산에 쓰지 말 것 */
  time?: string | number;
  /** 실제 발행 시각 (ISO). 시각이 필요하면 이쪽을 먼저 본다 */
  publishedAt?: string;
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
    // 원문 출처. 서버가 AI 분석을 통과시킬지 판단하는 근거다 —
    // 확인할 수 없는 분석은 화면에 "AI가 그렇다고 했다"만 남긴다.
    url?:         string;
    publishedAt?: string | number;
  }[];
}

// 분석 응답 body
export interface AnalyzeResponse {
  results: Record<string, NewsAnalysis>; // id → analysis
  source: 'openai' | 'mock' | 'mixed';
  /**
   * 원문 출처를 확인할 수 없어 분석하지 않은 항목. results에 자리가 없다.
   * 빈 자리를 만들어 놓고 말해주지 않으면 호출자는 계속 다시 물어본다.
   */
  unverifiableIds?: string[];
}

// UI에서 쓰는 라벨 / 색상 헬퍼
export const PREDICTION_LABEL: Record<NewsPrediction, string> = {
  up:      '상승 예상',
  down:    '하락 예상',
  flat:    '보합 예상',
  unknown: '판단 보류',
};

export const PREDICTION_TONE: Record<NewsPrediction, 'green' | 'red' | 'yellow' | 'gray'> = {
  up:      'green',
  down:    'red',
  flat:    'yellow',
  unknown: 'gray',
};
