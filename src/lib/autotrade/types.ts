// src/lib/autotrade/types.ts
// 자동매매 엔진 데이터 타입

export type ExecutionStatus = 'triggered' | 'skipped' | 'error' | 'blocked';

export interface IndicatorSnapshot {
  rsi?:         number;
  ema20?:       number;
  ema60?:       number;
  ema120?:      number;
  volume?:      number;
  volumeAvg?:   number;
  priceChange?: number;
  currentPrice?: number;
  atr?: number;
}

export interface ConditionEvalResult {
  indicator: string;
  pass:      boolean;
  current:   string;    // 현재값 표시용
  expected:  string;    // 기대값
}

export interface ExecutionLog {
  id:           string;
  strategyId:   string;
  strategyName: string;
  asset:        string;
  timeframe:    string;
  action:       'buy' | 'sell';
  status:       ExecutionStatus;
  at:           number;
  mode:         'paper' | 'live';
  // 평가 결과
  conditionsAll: number;
  conditionsPass: number;
  conditionDetails: ConditionEvalResult[];
  indicators:    IndicatorSnapshot;
  // 체결 결과 (paper)
  filledPrice?: number;
  filledAmount?: number;
  filledQuantity?: number;
  // 거부 사유
  reason?:      string;
}
