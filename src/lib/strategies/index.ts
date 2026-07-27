// ─────────────────────────────────────────────────────────────
// TRAIGO Strategy Library
// Trend following, breakout, mean reversion, DCA, scalp
// ─────────────────────────────────────────────────────────────
import type { OHLCV, MarketCondition, VolatilityLevel } from '../market';
import { calcEMA, calcRSI, calcATR } from '../market';

export type StrategyType =
  | 'EMA_CROSS'
  | 'ICHIMOKU_FOLLOW'
  | 'BREAKOUT'
  | 'PULLBACK_LONG'
  | 'MEAN_REVERSION'
  | 'DCA_ACCUMULATE'
  | 'VOLATILITY_BREAKOUT'
  | 'SHORT_BIAS'
  | 'RANGE_TRADE'
  | 'SCALP';

export interface StrategySignal {
  type:       'ENTRY' | 'EXIT' | 'DCA' | 'HOLD' | 'NONE';
  side:       'long' | 'short' | null;
  strength:   number;     // 0-100 confidence
  entryPrice: number;
  stopLoss:   number;
  takeProfit: number[];   // partial TPs
  size:       number;     // 0-1 fraction of capital
  strategy:   StrategyType;
  reason:     string;
}

const NONE_SIGNAL: StrategySignal = {
  type:'NONE', side:null, strength:0, entryPrice:0,
  stopLoss:0, takeProfit:[], size:0, strategy:'EMA_CROSS', reason:'조건 미충족',
};

// ── EMA Cross Strategy ────────────────────────────────────────
export function emaCorssSignal(candles: OHLCV[], fastPeriod = 20, slowPeriod = 50): StrategySignal {
  const closes = candles.map(c => c.c);
  if (closes.length < slowPeriod + 5) return NONE_SIGNAL;

  const fast = calcEMA(closes, fastPeriod);
  const slow = calcEMA(closes, slowPeriod);
  const rsi  = calcRSI(closes);
  const price = closes[closes.length - 1];

  const prevFast = fast[fast.length - 2];
  const prevSlow = slow[slow.length - 2];
  const curFast  = fast[fast.length - 1];
  const curSlow  = slow[slow.length - 1];

  const atr = calcATR(candles);
  const sl  = atr * 2;
  const tp1 = atr * 2;
  const tp2 = atr * 4;

  // Golden cross
  if (prevFast <= prevSlow && curFast > curSlow && rsi > 45 && rsi < 70) {
    return {
      type: 'ENTRY', side: 'long', strength: 75,
      entryPrice: price, stopLoss: price - sl,
      takeProfit: [price + tp1, price + tp2],
      size: 0.6, strategy: 'EMA_CROSS',
      reason: `골든크로스 EMA${fastPeriod}>${fastPeriod} · RSI ${rsi.toFixed(0)}`,
    };
  }
  // Death cross
  if (prevFast >= prevSlow && curFast < curSlow && rsi < 55 && rsi > 30) {
    return {
      type: 'ENTRY', side: 'short', strength: 70,
      entryPrice: price, stopLoss: price + sl,
      takeProfit: [price - tp1, price - tp2],
      size: 0.5, strategy: 'EMA_CROSS',
      reason: `데드크로스 EMA${fastPeriod}<${slowPeriod} · RSI ${rsi.toFixed(0)}`,
    };
  }
  return NONE_SIGNAL;
}

// ── Pullback Long Strategy ────────────────────────────────────
export function pullbackLongSignal(candles: OHLCV[]): StrategySignal {
  const closes = candles.map(c => c.c);
  if (closes.length < 60) return NONE_SIGNAL;

  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const rsi    = calcRSI(closes);
  const price  = closes[closes.length - 1];
  const last20 = ema20[ema20.length - 1];
  const last50 = ema50[ema50.length - 1];
  const atr    = calcATR(candles);

  // Trend UP, price pulled back to EMA20
  if (last20 > last50 && price < last20 * 1.01 && price > last20 * 0.99 && rsi < 50 && rsi > 35) {
    return {
      type: 'ENTRY', side: 'long', strength: 80,
      entryPrice: price, stopLoss: last50 - atr * 0.5,
      takeProfit: [price + atr * 2, price + atr * 4, price + atr * 7],
      size: 0.5, strategy: 'PULLBACK_LONG',
      reason: `EMA20 풀백 · 상승추세 유지 · RSI ${rsi.toFixed(0)}`,
    };
  }
  return NONE_SIGNAL;
}

// ── Breakout Strategy ─────────────────────────────────────────
export function breakoutSignal(candles: OHLCV[], lookback = 20): StrategySignal {
  if (candles.length < lookback + 5) return NONE_SIGNAL;

  const recent  = candles.slice(-lookback - 1, -1);
  const current = candles[candles.length - 1];
  const maxH    = Math.max(...recent.map(c => c.h));
  const minL    = Math.min(...recent.map(c => c.l));
  const atr     = calcATR(candles);
  const closes  = candles.map(c => c.c);
  const rsi     = calcRSI(closes);

  // Volume surge check
  const avgVol    = recent.map(c => c.v).reduce((a, b) => a + b) / recent.length;
  const volSurge  = current.v > avgVol * 1.5;

  // Upward breakout
  if (current.c > maxH && volSurge && rsi > 50) {
    return {
      type: 'ENTRY', side: 'long', strength: 85,
      entryPrice: current.c, stopLoss: maxH - atr,
      takeProfit: [current.c + atr * 2, current.c + atr * 4],
      size: 0.7, strategy: 'BREAKOUT',
      reason: `상단 저항 돌파 (₩${maxH.toFixed(0)}) · 거래량 급증 ${(current.v/avgVol).toFixed(1)}x`,
    };
  }
  // Downward breakout
  if (current.c < minL && volSurge && rsi < 50) {
    return {
      type: 'ENTRY', side: 'short', strength: 80,
      entryPrice: current.c, stopLoss: minL + atr,
      takeProfit: [current.c - atr * 2, current.c - atr * 4],
      size: 0.6, strategy: 'BREAKOUT',
      reason: `하단 지지 이탈 (₩${minL.toFixed(0)}) · 거래량 급증`,
    };
  }
  return NONE_SIGNAL;
}

// ── Mean Reversion (Range) ────────────────────────────────────
export function meanReversionSignal(candles: OHLCV[]): StrategySignal {
  const closes = candles.map(c => c.c);
  if (closes.length < 20) return NONE_SIGNAL;

  const ema20  = calcEMA(closes, 20);
  const rsi    = calcRSI(closes);
  const price  = closes[closes.length - 1];
  const last20 = ema20[ema20.length - 1];
  const atr    = calcATR(candles);
  const dev    = (price - last20) / last20;

  // Oversold bounce
  if (dev < -0.03 && rsi < 35) {
    return {
      type: 'ENTRY', side: 'long', strength: 65,
      entryPrice: price, stopLoss: price - atr * 1.5,
      takeProfit: [last20, last20 + atr],
      size: 0.4, strategy: 'MEAN_REVERSION',
      reason: `EMA 대비 ${(dev*100).toFixed(1)}% 이탈 · RSI 과매도 ${rsi.toFixed(0)}`,
    };
  }
  // Overbought fade
  if (dev > 0.03 && rsi > 65) {
    return {
      type: 'ENTRY', side: 'short', strength: 60,
      entryPrice: price, stopLoss: price + atr * 1.5,
      takeProfit: [last20, last20 - atr],
      size: 0.4, strategy: 'MEAN_REVERSION',
      reason: `EMA 대비 ${(dev*100).toFixed(1)}% 과열 · RSI 과매수 ${rsi.toFixed(0)}`,
    };
  }
  return NONE_SIGNAL;
}

// ── DCA Accumulate Strategy ───────────────────────────────────
export function dcaSignal(
  candles: OHLCV[],
  currentDCACount: number = 0,
  maxDCA: number = 5,
): StrategySignal {
  if (currentDCACount >= maxDCA) return NONE_SIGNAL;
  const closes = candles.map(c => c.c);
  const rsi    = calcRSI(closes);
  const price  = closes[closes.length - 1];
  const ema50  = calcEMA(closes, 50);
  const last50 = ema50[ema50.length - 1];

  // DCA when price dips but not in full breakdown
  if (rsi < 45 && price > last50 * 0.85 && price < last50 * 1.02) {
    const dcaSize = Math.max(0.1, 0.3 - currentDCACount * 0.05);
    return {
      type: 'DCA', side: 'long', strength: 60 - currentDCACount * 5,
      entryPrice: price, stopLoss: last50 * 0.85,
      takeProfit: [last50 * 1.05, last50 * 1.15],
      size: dcaSize, strategy: 'DCA_ACCUMULATE',
      reason: `DCA ${currentDCACount + 1}/${maxDCA}차 · RSI ${rsi.toFixed(0)} · EMA50 근접`,
    };
  }
  return NONE_SIGNAL;
}

// ── Auto-select best strategy ──────────────────────────────────
export function selectStrategy(
  condition: MarketCondition,
  volatility: VolatilityLevel,
  allowShort: boolean,
  season: 'INVEST' | 'TRADING',
): StrategyType[] {
  const strategies: StrategyType[] = [];

  switch (condition) {
    case 'STRONG_BULLISH':
      strategies.push('BREAKOUT', 'EMA_CROSS', 'PULLBACK_LONG');
      if (season === 'INVEST') strategies.push('DCA_ACCUMULATE');
      break;
    case 'WEAK_BULLISH':
      strategies.push('PULLBACK_LONG', 'EMA_CROSS');
      if (season === 'INVEST') strategies.push('DCA_ACCUMULATE');
      break;
    case 'SIDEWAYS':
      strategies.push('MEAN_REVERSION', 'RANGE_TRADE');
      break;
    case 'WEAK_BEARISH':
      if (allowShort) strategies.push('SHORT_BIAS', 'MEAN_REVERSION');
      else strategies.push('MEAN_REVERSION');
      break;
    case 'STRONG_BEARISH':
      if (allowShort) strategies.push('SHORT_BIAS');
      else strategies.push('SCALP'); // tiny size only
      break;
  }

  if (volatility === 'HIGH' || volatility === 'EXTREME') {
    strategies.unshift('VOLATILITY_BREAKOUT');
    if (season === 'TRADING') strategies.push('SCALP');
  }

  return strategies;
}

// ── Run all applicable strategies and return best signal ──────
export function runStrategies(
  candles: OHLCV[],
  strategies: StrategyType[],
  dcaCount = 0,
): StrategySignal {
  const signals: StrategySignal[] = [];

  for (const strat of strategies) {
    let sig: StrategySignal = NONE_SIGNAL;
    switch (strat) {
      case 'EMA_CROSS':         sig = emaCorssSignal(candles); break;
      case 'PULLBACK_LONG':     sig = pullbackLongSignal(candles); break;
      case 'BREAKOUT':
      case 'VOLATILITY_BREAKOUT': sig = breakoutSignal(candles); break;
      case 'MEAN_REVERSION':
      case 'RANGE_TRADE':       sig = meanReversionSignal(candles); break;
      case 'DCA_ACCUMULATE':    sig = dcaSignal(candles, dcaCount); break;
    }
    if (sig.type !== 'NONE') signals.push(sig);
  }

  // Return highest confidence signal
  if (signals.length === 0) return NONE_SIGNAL;
  return signals.reduce((best, s) => s.strength > best.strength ? s : best);
}
