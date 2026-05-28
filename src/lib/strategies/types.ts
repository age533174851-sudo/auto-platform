// src/lib/strategies/types.ts
// 사용자가 만든 전략 (JSON 직렬화 가능)

export type StrategyMarket = 'crypto' | 'stock' | 'etf' | 'forex' | 'futures';
export type StrategyMode   = 'paper' | 'live';   // 모의/실전
export type StrategyAction = 'buy' | 'sell';
export type StrategyTimeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

export type IndicatorName =
  | 'RSI' | 'MACD' | 'EMA' | 'SMA' | 'BB'
  | 'Volume' | 'PriceChange' | 'FundingRate'
  | 'MA_Cross' | 'Ichimoku' | 'Stochastic' | 'ATR';

export type Operator =
  | '<=' | '<' | '>=' | '>' | '=='
  | 'cross_above' | 'cross_below'
  | 'golden_cross' | 'dead_cross'
  | 'breakout_above' | 'break_below'
  | 'streak_up' | 'streak_down'
  | 'volume_surge' | 'volatility_spike';

export interface StrategyCondition {
  indicator: IndicatorName;
  operator?: Operator;
  value?:    number | string;
  period?:   number;
  signal?:   string;   // golden_cross 등에서 사용
}

export interface StrategyOrder {
  type:     'market' | 'limit';
  amount:   number;        // 주문 금액
  currency: 'KRW' | 'USD';
  limitPrice?: number;
}

export interface StrategyRisk {
  takeProfitPct:    number;
  stopLossPct:      number;
  maxDailyLossPct?: number;
}

export interface UserStrategy {
  id:          string;
  name:        string;
  asset:       string;          // 'BTC', 'TSLA' 등
  market:      StrategyMarket;
  timeframe:   StrategyTimeframe;
  mode:        StrategyMode;
  action:      StrategyAction;
  conditions:  StrategyCondition[];
  order:       StrategyOrder;
  risk:        StrategyRisk;
  enabled:     boolean;
  createdAt:   number;
  updatedAt:   number;
  lastSignal?: { at: number; result: 'triggered' | 'skipped' | 'error'; reason?: string };
  source?:     'manual' | 'ai';
  prompt?:     string;          // AI 생성 시 원본 자연어
  connectionId?: string;        // live 모드 시 사용할 거래소 연결 ID
}

// 지표/조건 라벨 (UI 표시용)
export const INDICATOR_LABEL: Record<IndicatorName, string> = {
  RSI:          'RSI (상대강도)',
  MACD:         'MACD',
  EMA:          'EMA (지수이평)',
  SMA:          'SMA (단순이평)',
  BB:           '볼린저밴드',
  Volume:       '거래량',
  PriceChange:  '가격 변동률',
  FundingRate:  '펀딩비',
  MA_Cross:     '이평선 크로스',
  Ichimoku:     '일목구름',
  Stochastic:   '스토캐스틱',
  ATR:          'ATR (변동성)',
};

export const OPERATOR_LABEL: Record<Operator, string> = {
  '<=':            '이하',
  '<':             '미만',
  '>=':            '이상',
  '>':             '초과',
  '==':            '같음',
  'cross_above':   '상향 돌파',
  'cross_below':   '하향 이탈',
  'golden_cross':  '골든크로스',
  'dead_cross':    '데드크로스',
  'breakout_above':'돌파',
  'break_below':   '이탈',
  'streak_up':     '연속 상승',
  'streak_down':   '연속 하락',
  'volume_surge':  '거래량 급증',
  'volatility_spike': '변동성 확대',
};

export const TIMEFRAME_LABEL: Record<StrategyTimeframe, string> = {
  '1m':'1분','5m':'5분','15m':'15분','30m':'30분','1h':'1시간','4h':'4시간','1d':'일봉',
};

export const MARKET_LABEL: Record<StrategyMarket, string> = {
  crypto: '암호화폐', stock: '주식', etf: 'ETF', forex: '환율', futures: '선물',
};
