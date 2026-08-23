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
  /**
   * 어느 환경에서 돈 실행인가.
   *
   * **`'testnet'`이 빠져 있었다.** 앱에는 모의·테스트넷·실전 셋이
   * 있는데 이 표시에는 둘뿐이라, 화면이 `mode==='testnet'`을 검사해도
   * 타입상 도달할 수 없는 가지가 됐다. 그리고 그 자리의 기본값이
   * '실전'이라 **테스트넷 기록이 실전으로 보일 수 있었다.**
   */
  mode:         'paper' | 'testnet' | 'live';
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
  // 귀속(attribution) — 성적표/프로필 분리용
  aiSource?:    string;    // 'claude' | 'gpt' | 'gemini' | 'grok' | 'rule'
  profileId?:   string;    // 'SCALP_HIGH_LEV' | 'SWING_LOW_LEV'
}
