// src/lib/backtest/engine.ts
// Self-contained backtest engine. No external dependencies.

export type Strategy = 'ema-cross' | 'rsi' | 'macd' | 'bollinger' | 'dca';

export interface Candle {
  t: number;   // timestamp (ms)
  o: number;   // open
  h: number;   // high
  l: number;   // low
  c: number;   // close
  v: number;   // volume
}

export interface BacktestConfig {
  symbol:       string;
  strategy:     Strategy;
  initialCash:  number;
  feeRate:      number;     // 0.001 = 0.1%
  leverage?:    number;     // 1 = no leverage
  positionPct?: number;     // 증거금으로 쓸 balance 비율 (0~1, 기본 1=전액). risk_percent 개념
  startTs?:     number;
  endTs?:       number;
  // Strategy params
  emaFast?:     number;     // default 12
  emaSlow?:     number;     // default 26
  rsiPeriod?:   number;     // default 14
  rsiOversold?: number;     // default 30
  rsiOverbought?: number;   // default 70
  macdFast?:    number;     // default 12
  macdSlow?:    number;     // default 26
  macdSignal?:  number;     // default 9
  bbPeriod?:    number;     // default 20
  bbStd?:       number;     // default 2
  dcaIntervalDays?: number; // default 7 (for DCA)
}

export interface Trade {
  side:    'buy' | 'sell';
  time:    number;
  price:   number;
  qty:     number;
  value:   number;
  fee:     number;
  pnl?:    number;
  netPnL?: number;
  pnlPct?: number;
  reason:  string;
}

export interface EquityPoint { t: number; equity: number; }

export interface BacktestResult {
  config:        BacktestConfig;
  candleCount:   number;
  trades:        Trade[];
  equityCurve:   EquityPoint[];
  finalEquity:   number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRate:       number;
  totalTrades:   number;
  winTrades:     number;
  loseTrades:    number;
  avgWinPct:     number;
  avgLossPct:    number;
  profitFactor:  number;
  sharpe:        number;
  avgTradePct?:  number;
  sanityWarning?: string | null;   // 비현실적 결과 자동 감지
}

/* ─── Indicators ─────────────────────────────────────────── */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) {
      // seed with SMA
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let gains = 0, losses = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    if (i <= period) {
      gains += g; losses += l;
      if (i === period) {
        const avgG = gains / period, avgL = losses / period;
        const rs = avgL === 0 ? 100 : avgG / avgL;
        out.push(100 - 100 / (1 + rs));
      } else out.push(null);
    } else {
      // Wilder smoothing
      const prevAvgG = (out[i-1] !== null) ? 0 : 0; // not used
      // Simpler: recompute rolling
      const sliceG: number[] = [];
      const sliceL: number[] = [];
      for (let j = i - period + 1; j <= i; j++) {
        const d = values[j] - values[j - 1];
        sliceG.push(d > 0 ? d : 0);
        sliceL.push(d < 0 ? -d : 0);
      }
      const avgG = sliceG.reduce((a, b) => a + b, 0) / period;
      const avgL = sliceL.reduce((a, b) => a + b, 0) / period;
      const rs = avgL === 0 ? 100 : avgG / avgL;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return (emaFast[i] as number) - (emaSlow[i] as number);
  });
  const validMacd = macdLine.map(v => v ?? 0);
  const signalLine = ema(validMacd, signal);
  const histogram = macdLine.map((v, i) => v === null || signalLine[i] === null ? null : v - (signalLine[i] as number));
  return { macdLine, signalLine, histogram };
}

export function bollinger(values: number[], period = 20, std = 2) {
  const mid = sma(values, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { upper.push(null); lower.push(null); continue; }
    const slice = values.slice(i - period + 1, i + 1);
    const m = (mid[i] as number);
    const variance = slice.reduce((s, x) => s + Math.pow(x - m, 2), 0) / period;
    const stdev = Math.sqrt(variance);
    upper.push(m + stdev * std);
    lower.push(m - stdev * std);
  }
  return { mid, upper, lower };
}

/* ─── Backtest runner ───────────────────────────────────── */
export function runBacktest(candles: Candle[], cfg: BacktestConfig): BacktestResult {
  const safeCandles = Array.isArray(candles) ? candles.filter(c => c && Number.isFinite(c.c)) : [];
  if (safeCandles.length < 30) {
    return emptyResult(cfg);
  }

  const closes = safeCandles.map(c => c.c);
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];

  const fee   = cfg.feeRate ?? 0.001;
  let cash    = cfg.initialCash;      // ★ balance = 현금성 총자산(equity). 진입 시 변경 안 함, 청산 시 netPnL만 반영
  let position = 0;       // # of units held (레버리지 반영된 수량)
  let entryPrice = 0;
  let entryFeePaid = 0;   // 진입 시 낸 수수료 (청산 netPnL에서 차감)
  let investedMargin = 0; // 현재 포지션에 투입된 증거금 누계 (DCA 한도용)
  let peakEquity = cfg.initialCash;
  let maxDrawdown = 0;
  const lev = Math.max(1, cfg.leverage ?? 1);
  const positionPct = Math.min(1, Math.max(0.01, cfg.positionPct ?? 1));  // 증거금 비율

  /* Pre-compute indicators */
  const emaF = ema(closes, cfg.emaFast ?? 12);
  const emaS = ema(closes, cfg.emaSlow ?? 26);
  const rsiSeries = rsi(closes, cfg.rsiPeriod ?? 14);
  const macdRes = macd(closes, cfg.macdFast ?? 12, cfg.macdSlow ?? 26, cfg.macdSignal ?? 9);
  const bb = bollinger(closes, cfg.bbPeriod ?? 20, cfg.bbStd ?? 2);

  const rsiOver  = cfg.rsiOversold   ?? 30;
  const rsiOverb = cfg.rsiOverbought ?? 70;

  /* DCA: buy fixed amount at interval */
  const dcaInterval = (cfg.dcaIntervalDays ?? 7) * 24 * 3600 * 1000;
  let lastDcaTs = 0;
  const dcaAmount = cfg.initialCash / 20; // 20 buys spread

  for (let i = 0; i < safeCandles.length; i++) {
    const candle = safeCandles[i];
    const price  = candle.c;

    let signal: 'buy' | 'sell' | null = null;
    let reason = '';

    /* Strategy logic */
    switch (cfg.strategy) {
      case 'ema-cross': {
        if (i > 0 && emaF[i] !== null && emaS[i] !== null && emaF[i-1] !== null && emaS[i-1] !== null) {
          const f0 = emaF[i-1] as number, s0 = emaS[i-1] as number;
          const f1 = emaF[i] as number,   s1 = emaS[i] as number;
          if (f0 <= s0 && f1 > s1)  { signal = 'buy';  reason = `골든크로스 (EMA${cfg.emaFast ?? 12}↑EMA${cfg.emaSlow ?? 26})`; }
          if (f0 >= s0 && f1 < s1)  { signal = 'sell'; reason = `데드크로스 (EMA${cfg.emaFast ?? 12}↓EMA${cfg.emaSlow ?? 26})`; }
        }
        break;
      }
      case 'rsi': {
        const r = rsiSeries[i];
        const rPrev = rsiSeries[i-1];
        if (r !== null && rPrev !== null) {
          if (rPrev < rsiOver  && r >= rsiOver)  { signal = 'buy';  reason = `RSI 과매도 탈출 (${r.toFixed(1)})`; }
          if (rPrev > rsiOverb && r <= rsiOverb) { signal = 'sell'; reason = `RSI 과매수 진입 (${r.toFixed(1)})`; }
        }
        break;
      }
      case 'macd': {
        const m = macdRes.histogram[i], mp = macdRes.histogram[i-1];
        if (m !== null && mp !== null) {
          if (mp <= 0 && m > 0) { signal = 'buy';  reason = 'MACD 히스토그램 양전환'; }
          if (mp >= 0 && m < 0) { signal = 'sell'; reason = 'MACD 히스토그램 음전환'; }
        }
        break;
      }
      case 'bollinger': {
        const up = bb.upper[i], lo = bb.lower[i], pup = bb.upper[i-1], plo = bb.lower[i-1];
        const pp = i > 0 ? closes[i-1] : null;
        if (up !== null && lo !== null && pup !== null && plo !== null && pp !== null) {
          if (pp <= plo && price > lo) { signal = 'buy';  reason = '볼린저 하단 반등'; }
          if (pp >= pup && price < up) { signal = 'sell'; reason = '볼린저 상단 이탈'; }
        }
        break;
      }
      case 'dca': {
        if (candle.t - lastDcaTs >= dcaInterval && cash >= dcaAmount) {
          signal = 'buy'; reason = `DCA 주기 매수 (${cfg.dcaIntervalDays ?? 7}일)`;
          lastDcaTs = candle.t;
        }
        break;
      }
    }

    /* Execute — equity 모델: 진입은 balance 불변, 청산 시에만 netPnL 반영 */
    if (signal === 'buy' && position === 0) {
      const margin   = cash * positionPct;        // 증거금 = balance × 비율
      const notional = margin * lev;              // 명목 규모 (= 증거금 × 레버리지)
      const qty      = notional / price;
      const f        = notional * fee;            // 진입 수수료 (명목 기준)
      position = qty;
      entryPrice = price;
      entryFeePaid = f;
      investedMargin = margin;
      // ★ balance(cash) 변경 없음
      trades.push({ side: 'buy', time: candle.t, price, qty, value: notional, fee: f, reason });
    } else if (signal === 'buy' && cfg.strategy === 'dca' && investedMargin + dcaAmount <= cash) {
      // DCA 누적 (증거금 누계가 balance를 넘지 않는 선까지)
      const notional = dcaAmount * lev;
      const qty = notional / price;
      const f = notional * fee;
      const newTotal = position + qty;
      entryPrice = position > 0 ? (entryPrice * position + price * qty) / newTotal : price;
      position = newTotal;
      entryFeePaid += f;
      investedMargin += dcaAmount;
      // ★ balance 변경 없음
      trades.push({ side: 'buy', time: candle.t, price, qty, value: notional, fee: f, reason });
    } else if (signal === 'sell' && position > 0) {
      const exitFee = position * price * fee;
      const grossPnL = (price - entryPrice) * position;            // 수량은 이미 레버리지 반영
      const netPnL = grossPnL - entryFeePaid - exitFee;            // 수수료 차감
      const pnlPct = entryPrice > 0 ? ((price - entryPrice) / entryPrice) * 100 * lev : 0;
      cash += netPnL;                                              // ★ 청산 시에만 netPnL 반영
      trades.push({
        side: 'sell', time: candle.t, price, qty: position, value: position * price,
        fee: exitFee, pnl: netPnL, netPnL, pnlPct, reason,
      });
      position = 0; entryPrice = 0; entryFeePaid = 0; investedMargin = 0;
    }

    /* Equity tracking — balance + 미실현손익 (mark-to-market) */
    const unrealized = position > 0 ? (price - entryPrice) * position : 0;
    const equity = cash + unrealized;
    equityCurve.push({ t: candle.t, equity });
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  /* Close open position at last price */
  if (position > 0) {
    const last = safeCandles[safeCandles.length - 1];
    const exitFee = position * last.c * fee;
    const grossPnL = (last.c - entryPrice) * position;
    const netPnL = grossPnL - entryFeePaid - exitFee;
    const pnlPct = entryPrice > 0 ? ((last.c - entryPrice) / entryPrice) * 100 * lev : 0;
    cash += netPnL;
    trades.push({
      side: 'sell', time: last.t, price: last.c, qty: position, value: position * last.c,
      fee: exitFee, pnl: netPnL, netPnL, pnlPct, reason: '백테스트 종료 청산',
    });
    position = 0;
  }

  /* Stats */
  const completed = trades.filter(t => t.side === 'sell' && t.pnl !== undefined);
  const wins  = completed.filter(t => (t.pnl ?? 0) > 0);
  const loses = completed.filter(t => (t.pnl ?? 0) < 0);
  const totalProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalLoss   = Math.abs(loses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const avgWinPct   = wins.length  > 0 ? wins.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / wins.length : 0;
  const avgLossPct  = loses.length > 0 ? loses.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / loses.length : 0;
  const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 999 : 0);
  const winRate = completed.length > 0 ? (wins.length / completed.length) * 100 : 0;
  const finalEquity = cash;
  const totalReturnPct = ((finalEquity - cfg.initialCash) / cfg.initialCash) * 100;

  /* Sharpe (simplified — daily returns) */
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i-1].equity;
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev);
  }
  const avgRet = returns.length > 0 ? returns.reduce((a,b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 0
    ? returns.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / returns.length
    : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? (avgRet / stdev) * Math.sqrt(252) : 0;

  // 평균 거래 수익률 (거래당 pnlPct 평균)
  const avgTradePct = completed.length > 0
    ? completed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / completed.length : 0;

  // 자동 검증 — 비현실적 결과 감지
  let sanityWarning: string | null = null;
  if (!isFinite(finalEquity) || finalEquity <= 0) sanityWarning = '자산 계산 오류 (비정상 값)';
  else if (Math.abs(totalReturnPct) > 1000) sanityWarning = `비현실적 수익률 (${totalReturnPct.toFixed(0)}%) — 계산 오류 또는 과최적화 의심`;
  else if (finalEquity > cfg.initialCash * 50) sanityWarning = '최종 자산이 초기 대비 50배 초과 — 계산 오류 의심';

  return {
    config: cfg,
    candleCount: safeCandles.length,
    trades,
    equityCurve,
    finalEquity,
    totalReturnPct,
    maxDrawdownPct: maxDrawdown,
    winRate,
    totalTrades:  completed.length,
    winTrades:    wins.length,
    loseTrades:   loses.length,
    avgWinPct,
    avgLossPct,
    profitFactor,
    sharpe,
    avgTradePct,
    sanityWarning,
  };
}

function emptyResult(cfg: BacktestConfig): BacktestResult {
  return {
    config: cfg, candleCount: 0, trades: [], equityCurve: [],
    finalEquity: cfg.initialCash, totalReturnPct: 0, maxDrawdownPct: 0,
    winRate: 0, totalTrades: 0, winTrades: 0, loseTrades: 0,
    avgWinPct: 0, avgLossPct: 0, profitFactor: 0, sharpe: 0,
  };
}

/* ─── Synthetic candles generator (mock fallback) ────────── */
export function generateSyntheticCandles(opts: {
  startPrice?: number;
  count?: number;
  trend?: number;        // annual drift, e.g., 0.5 = +50%/yr
  volatility?: number;   // annual vol, e.g., 0.6 = 60%/yr
  intervalMs?: number;   // candle interval
  startTs?: number;
}): Candle[] {
  const startPrice = opts.startPrice ?? 50_000;
  const count      = opts.count      ?? 365;
  const trend      = opts.trend      ?? 0.2;
  const volatility = opts.volatility ?? 0.5;
  const intervalMs = opts.intervalMs ?? (24 * 3600 * 1000);
  const startTs    = opts.startTs    ?? (Date.now() - count * intervalMs);

  const candles: Candle[] = [];
  let price = startPrice;
  // Geometric Brownian motion daily
  const dt = intervalMs / (365 * 24 * 3600 * 1000);
  const drift = trend * dt;
  const vol = volatility * Math.sqrt(dt);

  for (let i = 0; i < count; i++) {
    const z = boxMuller();
    const ret = drift + vol * z;
    const o = price;
    const c = price * Math.exp(ret);
    const h = Math.max(o, c) * (1 + Math.abs(boxMuller()) * vol * 0.5);
    const l = Math.min(o, c) * (1 - Math.abs(boxMuller()) * vol * 0.5);
    candles.push({
      t: startTs + i * intervalMs,
      o, h, l, c,
      v: 1_000_000 * (0.5 + Math.random()),
    });
    price = c;
  }
  return candles;
}

function boxMuller(): number {
  // standard normal
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
