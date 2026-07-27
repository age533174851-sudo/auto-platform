// src/lib/autotrade/regime.ts
// 시장 국면 필터(Regime Filter) — 추세/횡보/고변동을 판별해 적합한 전략을 선택.
// "좋은 전략도 국면이 안 맞으면 망한다" → 국면에 맞는 전략만 활성화.
// Kaufman 효율성 비율(ER) 기반: 종가만으로 추세 강도를 측정.

export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'VOLATILE';

export interface RegimeResult {
  regime: Regime;
  label: string;
  color: string;
  efficiency: number;     // 0~1 (1=완벽한 추세, 0=완전 횡보)
  volatility: number;     // % 변동성
  direction: 'up' | 'down' | 'flat';
  suitableStrategies: string[];   // 이 국면에 적합한 전략 type
  description: string;
}

// Kaufman 효율성 비율: |순변화| / 총이동거리. 1에 가까울수록 강한 추세.
export function efficiencyRatio(prices: number[]): number {
  if (prices.length < 2) return 0;
  const net = Math.abs(prices[prices.length - 1] - prices[0]);
  let total = 0;
  for (let i = 1; i < prices.length; i++) total += Math.abs(prices[i] - prices[i - 1]);
  return total === 0 ? 0 : net / total;
}

function volatilityPct(prices: number[]): number {
  if (prices.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) rets.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

// 국면별 적합 전략 (type)
const REGIME_STRATEGIES: Record<Regime, string[]> = {
  TREND_UP: ['ema_cross', 'breakout', 'ai_strategy'],
  TREND_DOWN: ['ema_cross', 'breakout', 'ai_strategy'],
  RANGE: ['rsi_reversal', 'dca'],
  VOLATILE: ['breakout', 'dca'],   // 고변동: 브레이크아웃 or 분할매수만
};

const META: Record<Regime, { label: string; color: string; desc: string }> = {
  TREND_UP: { label: '상승 추세', color: '#22C55E', desc: '방향성이 뚜렷한 상승장 — 추세 추종 전략이 유리합니다.' },
  TREND_DOWN: { label: '하락 추세', color: '#EF4444', desc: '방향성이 뚜렷한 하락장 — 숏 추세 또는 관망이 유리합니다.' },
  RANGE: { label: '횡보 (박스권)', color: '#F59E0B', desc: '방향성 없이 등락 반복 — 역추세(RSI) 전략이 유리합니다.' },
  VOLATILE: { label: '고변동성', color: '#8B5CF6', desc: '변동성이 크고 불규칙 — 진입을 줄이거나 브레이크아웃만 노리세요.' },
};

export function detectRegime(prices: number[]): RegimeResult {
  const er = efficiencyRatio(prices);
  const vol = volatilityPct(prices);
  const net = prices.length >= 2 ? prices[prices.length - 1] - prices[0] : 0;
  const direction: 'up' | 'down' | 'flat' = net > 0 ? 'up' : net < 0 ? 'down' : 'flat';

  let regime: Regime;
  // 고변동성 우선 (변동성 크고 추세 약함 = 위험한 톱질장)
  if (vol > 4.5 && er < 0.4) regime = 'VOLATILE';
  else if (er >= 0.45) regime = direction === 'down' ? 'TREND_DOWN' : 'TREND_UP';
  else if (er < 0.3) regime = 'RANGE';
  else regime = direction === 'up' ? 'TREND_UP' : direction === 'down' ? 'TREND_DOWN' : 'RANGE'; // 약한 추세

  const m = META[regime];
  return {
    regime, label: m.label, color: m.color, description: m.desc,
    efficiency: er, volatility: vol, direction,
    suitableStrategies: REGIME_STRATEGIES[regime],
  };
}

// 전략이 현재 국면에 맞는가 + 점수(0~100)
export function strategyFitsRegime(strategyType: string, regime: Regime): { fits: boolean; score: number; reason: string } {
  const suitable = REGIME_STRATEGIES[regime];
  const fits = suitable.includes(strategyType);
  // 추세 전략을 횡보에 쓰거나, 역추세를 강한 추세에 쓰면 감점
  const isTrendStrat = ['ema_cross', 'breakout'].includes(strategyType);
  const isRangeStrat = ['rsi_reversal'].includes(strategyType);
  const isTrendRegime = regime === 'TREND_UP' || regime === 'TREND_DOWN';
  let score = fits ? 85 : 30;
  let reason: string;
  if (fits) reason = '현재 국면에 적합한 전략입니다.';
  else if (isTrendStrat && regime === 'RANGE') { score = 25; reason = '횡보장에서 추세 전략은 잦은 손실 위험이 큽니다.'; }
  else if (isRangeStrat && isTrendRegime) { score = 28; reason = '추세장에서 역추세 전략은 추세에 역행할 수 있습니다.'; }
  else reason = '현재 국면과 궁합이 낮습니다.';
  return { fits, score, reason };
}
