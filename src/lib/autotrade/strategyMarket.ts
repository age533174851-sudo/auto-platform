// src/lib/autotrade/strategyMarket.ts
// AI 전략 마켓 — 종목마다 시장 상황을 보고 최적 시간프레임/전략을 배정.
// "BTC는 장기 추세 좋으니 장투, SOL은 변동성 커서 단타, DOGE는 조건 안 좋아 거래 안 함"
// 여러 시간프레임 전략이 동시에 돌고, AI가 자금·리스크를 관리한다.
import { detectRegime } from './regime';
import { computeATRPct } from './dynamicSizing';
import { convene } from './committee';

export type Timeframe = 'scalping' | 'daytrading' | 'swing' | 'longterm' | 'none';

export interface TimeframeInfo { key: Timeframe; label: string; icon: string; color: string; horizon: string }
export const TIMEFRAMES: Record<Timeframe, TimeframeInfo> = {
  scalping:   { key: 'scalping',   label: '초단타', icon: 'Zap',        color: '#EC4899', horizon: '수초~수분' },
  daytrading: { key: 'daytrading', label: '단타',   icon: 'Rocket',     color: '#F59E0B', horizon: '수분~당일' },
  swing:      { key: 'swing',      label: '스윙',   icon: 'TrendingUp', color: '#0EA5E9', horizon: '며칠~몇 주' },
  longterm:   { key: 'longterm',   label: '장기',   icon: 'Gem',        color: '#22C55E', horizon: '몇 달~몇 년' },
  none:       { key: 'none',       label: '거래 안 함', icon: 'Ban',    color: '#64748B', horizon: '관망' },
};

// 시간프레임별 추천 전략군
const TF_STRATEGY: Record<Timeframe, string> = {
  scalping: 'Scalping (모멘텀)', daytrading: 'Breakout (돌파)', swing: 'Trend / Swing',
  longterm: 'DCA / 추세 추종', none: '—',
};

export interface SymbolAssignment {
  symbol: string;
  timeframe: Timeframe;
  tfLabel: string;
  tfColor: string;
  tfIcon: string;
  horizon: string;
  strategy: string;
  leverage: number;
  confidence: number;     // 배정 확신도 0~100
  regime: string;
  reason: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 종목 하나에 시간프레임 배정
export function assignTimeframe(symbol: string, prices: number[], fearGreed = 50, maxLev = 5): SymbolAssignment {
  const r = detectRegime(prices);
  const atrPct = computeATRPct(prices);
  const committee = convene({ prices, fearGreed });
  const bias = committee.finalBias;

  let timeframe: Timeframe;
  let reason: string;

  // 배정 규칙: 국면 × 변동성 × 위원회
  if (bias <= -30 || r.regime === 'TREND_DOWN') {
    timeframe = 'none';
    reason = r.regime === 'TREND_DOWN'
      ? `하락 추세 — 조건 불리, 거래 보류`
      : `위원회 약세(${bias}) — 거래 보류`;
  } else if (r.regime === 'TREND_UP' && r.efficiency > 0.6 && atrPct < 3) {
    // 강하고 안정적인 상승 추세 → 장기
    timeframe = 'longterm';
    reason = `안정적 상승 추세(효율 ${(r.efficiency * 100).toFixed(0)}%, 저변동성) — 장기 투자 적합`;
  } else if (atrPct >= 5) {
    // 고변동성 → 초단타 (짧게 치고 빠지기)
    timeframe = 'scalping';
    reason = `높은 변동성(ATR ${atrPct.toFixed(1)}%) — 짧게 대응하는 초단타 적합`;
  } else if (atrPct >= 3 || r.regime === 'VOLATILE') {
    // 중고변동성 → 단타
    timeframe = 'daytrading';
    reason = `변동성 있음(ATR ${atrPct.toFixed(1)}%) — 당일 단타 적합`;
  } else if (r.regime === 'TREND_UP' || r.regime === 'RANGE') {
    // 완만한 추세/횡보 → 스윙
    timeframe = 'swing';
    reason = `${r.regime === 'RANGE' ? '횡보' : '완만한 추세'} — 며칠 단위 스윙 적합`;
  } else {
    timeframe = 'swing';
    reason = '중립적 시장 — 스윙으로 대응';
  }

  const tf = TIMEFRAMES[timeframe];
  // 레버리지: 장기는 낮게, 단타는 상황따라
  let leverage = 0;
  if (timeframe !== 'none') {
    const base = timeframe === 'longterm' ? 1 : timeframe === 'swing' ? 2 : timeframe === 'daytrading' ? 3 : 2;
    const biasBoost = bias >= 50 ? 1.5 : bias >= 25 ? 1.2 : 1;
    leverage = clamp(Math.round(base * biasBoost), 0, maxLev);
    if (atrPct >= 5) leverage = Math.min(leverage, 2);   // 고변동성 배율 제한
  }

  const confidence = timeframe === 'none' ? clamp(Math.abs(bias), 40, 95)
    : clamp(Math.round(r.efficiency * 50 + committee.consensusStrength * 0.5), 20, 95);

  return {
    symbol, timeframe, tfLabel: tf.label, tfColor: tf.color, tfIcon: tf.icon, horizon: tf.horizon,
    strategy: TF_STRATEGY[timeframe], leverage, confidence, regime: r.regime, reason,
  };
}

// 여러 종목 일괄 배정 + 자금 배분
export interface PortfolioAssignment {
  assignments: SymbolAssignment[];
  activeCount: number;
  allocation: { symbol: string; pct: number }[];   // 활성 종목 자금 배분
  summary: string;
}

export function assignPortfolio(symbolPrices: { symbol: string; prices: number[] }[], fearGreed = 50, maxLev = 5): PortfolioAssignment {
  const assignments = symbolPrices.map(({ symbol, prices }) => assignTimeframe(symbol, prices, fearGreed, maxLev));
  const active = assignments.filter(a => a.timeframe !== 'none');

  // 자금 배분: 확신도 비례
  const totalConf = active.reduce((a, b) => a + b.confidence, 0) || 1;
  let allocation = active.map(a => ({ symbol: a.symbol, pct: Math.round((a.confidence / totalConf) * 100) }));
  const diff = 100 - allocation.reduce((a, b) => a + b.pct, 0);
  if (allocation.length && diff !== 0) allocation.sort((a, b) => b.pct - a.pct)[0].pct += diff;

  const summary = `${assignments.length}개 종목 중 ${active.length}개 활성 · ${assignments.length - active.length}개 관망`;
  return { assignments, activeCount: active.length, allocation, summary };
}
