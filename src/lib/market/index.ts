// ─────────────────────────────────────────────────────────────
// TRAIGO Market Analysis Engine
// Trend, volatility, momentum, sentiment scoring
// ─────────────────────────────────────────────────────────────

export type MarketCondition =
  | 'STRONG_BULLISH'
  | 'WEAK_BULLISH'
  | 'SIDEWAYS'
  | 'WEAK_BEARISH'
  | 'STRONG_BEARISH';

export type VolatilityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
export type TrendStrength   = 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE';

export interface MarketScore {
  overall:       number;          // -100 to +100
  condition:     MarketCondition;
  trend:         TrendStrength;
  volatility:    VolatilityLevel;
  momentum:      number;          // -100 to +100
  fundingBias:   number;          // -100 (short bias) to +100 (long bias)
  volumeQuality: number;          // 0 to 100
  liquidationPressure: number;    // 0 (low) to 100 (extreme)
  components: {
    ema:        number;
    ichimoku:   number;
    volume:     number;
    funding:    number;
    volatility: number;
  };
  updatedAt: string;
}

export interface OHLCV {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

// ── EMA calculation ────────────────────────────────────────────
export function calcEMA(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const k   = 2 / (period + 1);
  const out: number[] = [data.slice(0, period).reduce((a, b) => a + b) / period];
  for (let i = period; i < data.length; i++) {
    out.push(data[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

// ── RSI ─────────────────────────────────────────────────────
export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── ATR (Average True Range) ──────────────────────────────────
export function calcATR(candles: OHLCV[], period = 14): number {
  if (candles.length < period) return 0;
  const trs = candles.slice(-period - 1).map((c, i, arr) => {
    if (i === 0) return c.h - c.l;
    const prev = arr[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev));
  });
  return trs.reduce((a, b) => a + b) / trs.length;
}

// ── Volatility score ──────────────────────────────────────────
export function calcVolatilityLevel(candles: OHLCV[]): VolatilityLevel {
  if (candles.length < 14) return 'MEDIUM';
  const atr    = calcATR(candles);
  const price  = candles[candles.length - 1].c;
  const atrPct = price > 0 ? atr / price : 0;
  if (atrPct > 0.05)  return 'EXTREME';
  if (atrPct > 0.025) return 'HIGH';
  if (atrPct > 0.01)  return 'MEDIUM';
  return 'LOW';
}

// ── EMA trend score (-100 to +100) ───────────────────────────
export function calcEMATrendScore(closes: number[]): number {
  if (closes.length < 200) return 0;
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const price  = closes[closes.length - 1];

  let score = 0;
  const last20  = ema20[ema20.length - 1];
  const last50  = ema50[ema50.length - 1];
  const last200 = ema200[ema200.length - 1];

  // Price vs EMA
  if (price > last20)  score += 20;  else score -= 20;
  if (price > last50)  score += 20;  else score -= 20;
  if (price > last200) score += 20;  else score -= 20;

  // EMA alignment
  if (last20 > last50)  score += 20;  else score -= 20;
  if (last50 > last200) score += 20;  else score -= 20;

  return Math.max(-100, Math.min(100, score));
}

// ── Ichimoku cloud score (-100 to +100) ───────────────────────
export function calcIchimokuScore(candles: OHLCV[]): number {
  if (candles.length < 52) return 0;
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const n      = candles.length;

  const tenkan  = (Math.max(...highs.slice(-9))  + Math.min(...lows.slice(-9)))  / 2;
  const kijun   = (Math.max(...highs.slice(-26)) + Math.min(...lows.slice(-26))) / 2;
  const spanA   = (tenkan + kijun) / 2;
  const spanB   = (Math.max(...highs.slice(-52)) + Math.min(...lows.slice(-52))) / 2;
  const price   = closes[n - 1];

  let score = 0;
  if (price > spanA && price > spanB) score += 50;
  else if (price < spanA && price < spanB) score -= 50;

  if (spanA > spanB) score += 30; else score -= 30;
  if (tenkan > kijun) score += 20; else score -= 20;

  return Math.max(-100, Math.min(100, score));
}

// ── Volume quality score (0-100) ──────────────────────────────
export function calcVolumeScore(candles: OHLCV[]): number {
  if (candles.length < 20) return 50;
  const recent = candles.slice(-5).map(c => c.v);
  const avg20  = candles.slice(-20).map(c => c.v).reduce((a, b) => a + b) / 20;
  const avgRecent = recent.reduce((a, b) => a + b) / recent.length;
  const ratio = avg20 > 0 ? avgRecent / avg20 : 1;

  // Higher volume than average = better quality
  return Math.max(0, Math.min(100, 50 + (ratio - 1) * 30));
}

// ── Funding rate bias (-100 to +100) ─────────────────────────
export function calcFundingBias(fundingRate: number): number {
  // Positive rate = longs pay shorts → market is long-heavy → bearish signal
  // Negative rate = shorts pay longs → market is short-heavy → bullish signal
  return Math.max(-100, Math.min(100, -fundingRate * 10000));
}

// ── Overall market score ──────────────────────────────────────
export function calcMarketScore(
  candles: OHLCV[],
  fundingRate = 0.0001,
  btcDominance = 50,
): MarketScore {
  const closes = candles.map(c => c.c);

  const ema        = calcEMATrendScore(closes);
  const ichimoku   = calcIchimokuScore(candles);
  const volume     = calcVolumeScore(candles);
  const funding    = calcFundingBias(fundingRate);
  const rsi        = calcRSI(closes);
  const volLevel   = calcVolatilityLevel(candles);

  const volatilityScore = volLevel === 'HIGH' || volLevel === 'EXTREME' ? -20 : 0;

  // Momentum from RSI
  const momentum = (rsi - 50) * 2; // -100 to +100

  // Weighted overall score
  const overall = Math.round(
    ema * 0.35 +
    ichimoku * 0.25 +
    momentum * 0.15 +
    funding * 0.10 +
    (volume - 50) * 0.10 +
    volatilityScore * 0.05
  );

  // Classify condition
  let condition: MarketCondition;
  if (overall >= 50)       condition = 'STRONG_BULLISH';
  else if (overall >= 20)  condition = 'WEAK_BULLISH';
  else if (overall <= -50) condition = 'STRONG_BEARISH';
  else if (overall <= -20) condition = 'WEAK_BEARISH';
  else                     condition = 'SIDEWAYS';

  // Trend strength
  const absOverall = Math.abs(overall);
  const trend: TrendStrength =
    absOverall >= 60 ? 'STRONG' :
    absOverall >= 35 ? 'MODERATE' :
    absOverall >= 15 ? 'WEAK' : 'NONE';

  return {
    overall: Math.max(-100, Math.min(100, overall)),
    condition, trend,
    volatility:  volLevel,
    momentum:    Math.round(momentum),
    fundingBias: Math.round(funding),
    volumeQuality: Math.round(volume),
    liquidationPressure: 0, // populated from external data
    components: {
      ema:        Math.round(ema),
      ichimoku:   Math.round(ichimoku),
      volume:     Math.round(volume),
      funding:    Math.round(funding),
      volatility: volatilityScore,
    },
    updatedAt: new Date().toISOString(),
  };
}

// ── Fetch & analyze live BTC data from Binance ────────────────
export async function fetchMarketScore(symbol = 'BTCUSDT'): Promise<MarketScore> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=4h&limit=210`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) throw new Error('Binance API error');
    const raw: any[][] = await r.json();
    const candles: OHLCV[] = raw.map(k => ({
      t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]),
      l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
    }));

    // Fetch funding rate
    let fundingRate = 0.0001;
    try {
      const fr = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, { signal: AbortSignal.timeout(3000) });
      if (fr.ok) { const fd = await fr.json(); fundingRate = parseFloat(fd.lastFundingRate || '0.0001'); }
    } catch {}

    return calcMarketScore(candles, fundingRate);
  } catch {
    // Return neutral score on failure
    return {
      overall: 0, condition: 'SIDEWAYS', trend: 'NONE', volatility: 'MEDIUM',
      momentum: 0, fundingBias: 0, volumeQuality: 50, liquidationPressure: 0,
      components: { ema: 0, ichimoku: 0, volume: 50, funding: 0, volatility: 0 },
      updatedAt: new Date().toISOString(),
    };
  }
}

// ── Mock score for SSR / paper mode ──────────────────────────
export function getMockMarketScore(): MarketScore {
  return {
    overall: 35, condition: 'WEAK_BULLISH', trend: 'MODERATE',
    volatility: 'MEDIUM', momentum: 42, fundingBias: -15,
    volumeQuality: 68, liquidationPressure: 25,
    components: { ema: 60, ichimoku: 40, volume: 68, funding: -15, volatility: 0 },
    updatedAt: new Date().toISOString(),
  };
}
