// ─────────────────────────────────────────────────────────────
// TRAIGO Enhanced Backtest Engine
// Fees + slippage + funding + latency + season simulation
// ─────────────────────────────────────────────────────────────
import type { OHLCV, MarketCondition } from '../market';
import { calcMarketScore } from '../market';
import { getCurrentSeasonMode, getAdjustedParams } from '../season';
import { runStrategies, selectStrategy } from '../strategies';
import { calcPositionSize } from '../risk';
import { getDefaultConfig, calcFeeAmount } from '../fees';
import { calcSlippage } from '../slippage';
import type { ExchangeId } from '../exchanges/types';

export interface BacktestConfig {
  exchange:       ExchangeId;
  initialCapital: number;
  riskPerTrade:   number;       // e.g. 0.01 = 1%
  maxLeverage:    number;
  useSeason:      boolean;      // apply season mode switching
  applyFees:      boolean;
  applySlippage:  boolean;
  applyFunding:   boolean;
  fundingRate:    number;       // per 8h
  latencyMs:      number;       // simulated order latency
  startDate?:     Date;
  endDate?:       Date;
}

export interface BacktestTrade {
  i:          number;
  date:       string;
  side:       'long' | 'short';
  entry:      number;
  exit:       number;
  qty:        number;
  leverage:   number;
  grossPnL:   number;
  fees:       number;
  slippage:   number;
  funding:    number;
  netPnL:     number;
  holdBars:   number;
  strategy:   string;
  season:     string;
  condition:  MarketCondition;
  exitReason: string;
}

export interface BacktestResult {
  trades:           BacktestTrade[];
  equity:           { i: number; v: number }[];
  totalReturn:      number;      // %
  annualized:       number;      // % annualized
  maxDrawdown:      number;      // % from peak
  winRate:          number;      // %
  profitFactor:     number;
  sharpeRatio:      number;
  totalTrades:      number;
  totalFees:        number;
  totalSlippage:    number;
  totalFunding:     number;
  avgHoldBars:      number;
  bestTrade:        number;
  worstTrade:       number;
  calmarRatio:      number;
  investModeReturn: number;      // return during INVEST season
  tradingModeReturn:number;      // return during TRADING season
  config:           BacktestConfig;
}

// ── Main backtest runner ──────────────────────────────────────
export function runBacktest(
  candles: OHLCV[],
  config:  BacktestConfig,
): BacktestResult {
  const {
    exchange, initialCapital, riskPerTrade,
    applyFees, applySlippage, applyFunding, fundingRate,
  } = config;

  const feeConfig  = getDefaultConfig(exchange, 'futures');
  let   capital    = initialCapital;
  const trades:    BacktestTrade[] = [];
  const equity:    { i: number; v: number }[] = [{ i: 0, v: capital }];

  let peak         = capital;
  let maxDD        = 0;
  let inPosition   = false;
  let entryBar     = 0;
  let side: 'long'|'short' = 'long';
  let entryPrice   = 0;
  let qty          = 0;
  let leverage     = 1;
  let stopLoss     = 0;
  let strategyName = '';
  let seasonName   = 'INVEST';
  let condName: MarketCondition = 'SIDEWAYS';
  let dcaCount     = 0;

  let investReturn  = 0;
  let tradingReturn = 0;

  const WARMUP = 200;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar   = candles[i];
    const slice = candles.slice(Math.max(0, i - 200), i + 1);
    const date  = new Date(bar.t).toISOString();

    // ── Season & market analysis (every 24 bars = 4 days @ 4h) ──
    if (i % 24 === 0 || i === WARMUP) {
      const barDate  = new Date(bar.t);
      const season   = config.useSeason ? getCurrentSeasonMode(barDate) : 'INVEST';
      const score    = calcMarketScore(slice, fundingRate);
      const params   = getAdjustedParams(season, score.condition, score.volatility, score.trend);
      leverage       = Math.min(params.leverage, config.maxLeverage);
      seasonName     = season;
      condName       = score.condition;
    }

    // ── Check stop loss ───────────────────────────────────────
    if (inPosition) {
      const hitStop = side === 'long' ? bar.l <= stopLoss : bar.h >= stopLoss;
      if (hitStop) {
        const exitPrice = stopLoss;
        const rawPnL    = side === 'long'
          ? (exitPrice - entryPrice) * qty
          : (entryPrice - exitPrice) * qty;
        const feeAmt    = applyFees ? calcFeeAmount(entryPrice * qty, feeConfig, 'taker') * 2 : 0;
        const slipAmt   = applySlippage ? calcSlippage({ orderSize: entryPrice*qty, dailyVolume: 1e9, assetType:'mid', exchange }).amount * 2 : 0;
        const fundAmt   = applyFunding ? fundingRate * entryPrice * qty * Math.floor((i - entryBar) / 3) : 0;
        const netPnL    = rawPnL - feeAmt - slipAmt - (side==='long' ? fundAmt : -fundAmt);
        capital        += netPnL;
        const t: BacktestTrade = {
          i, date, side, entry: entryPrice, exit: exitPrice, qty, leverage,
          grossPnL: rawPnL, fees: feeAmt, slippage: slipAmt, funding: fundAmt,
          netPnL, holdBars: i - entryBar, strategy: strategyName,
          season: seasonName, condition: condName, exitReason: '손절',
        };
        trades.push(t);
        if (seasonName === 'INVEST') investReturn += netPnL; else tradingReturn += netPnL;
        inPosition = false; dcaCount = 0;
        if (i % 5 === 0) equity.push({ i, v: Math.round(capital) });
        peak = Math.max(peak, capital);
        maxDD = Math.max(maxDD, (peak - capital) / peak);
      }
    }

    // ── Entry signals ─────────────────────────────────────────
    if (!inPosition && i % 3 === 0) {
      const barDate = new Date(bar.t);
      const season  = config.useSeason ? getCurrentSeasonMode(barDate) : 'INVEST';
      const score   = calcMarketScore(slice, fundingRate);
      const params  = getAdjustedParams(season, score.condition, score.volatility, score.trend);
      const strats  = selectStrategy(score.condition, score.volatility, params.allowShort, season);
      const signal  = runStrategies(slice, strats, dcaCount);

      if (signal.type !== 'NONE' && signal.strength > 55) {
        const sizing = calcPositionSize({
          capital, riskPct: riskPerTrade,
          entryPrice: signal.entryPrice || bar.c,
          stopLoss:   signal.stopLoss,
          leverage:   params.leverage,
          riskMultiplier: params.riskMultiplier,
          signal: { strength: signal.strength },
        });

        if (sizing.marginRequired <= capital * 0.5) {
          inPosition   = true;
          entryBar     = i;
          side         = signal.side === 'short' ? 'short' : 'long';
          entryPrice   = bar.c;
          qty          = sizing.quantity;
          leverage     = params.leverage;
          stopLoss     = signal.stopLoss;
          strategyName = signal.strategy;
          seasonName   = season;
          condName     = score.condition;
        }
      }
    }

    // ── Max hold exit ─────────────────────────────────────────
    if (inPosition) {
      const barDate = new Date(bar.t);
      const season  = config.useSeason ? getCurrentSeasonMode(barDate) : 'INVEST';
      const maxHold = SEASON_CONFIGS_LITE[season];

      if (i - entryBar >= maxHold) {
        const exitPrice = bar.c;
        const rawPnL    = side === 'long'
          ? (exitPrice - entryPrice) * qty
          : (entryPrice - exitPrice) * qty;
        const feeAmt  = applyFees ? calcFeeAmount(entryPrice*qty, feeConfig, 'taker') * 2 : 0;
        const slipAmt = applySlippage ? calcSlippage({ orderSize: entryPrice*qty, dailyVolume: 1e9, assetType:'mid', exchange }).amount * 2 : 0;
        const fundAmt = applyFunding ? fundingRate * entryPrice * qty * Math.floor((i-entryBar)/3) : 0;
        const netPnL  = rawPnL - feeAmt - slipAmt - (side==='long'?fundAmt:-fundAmt);
        capital      += netPnL;
        trades.push({
          i, date, side, entry: entryPrice, exit: exitPrice, qty, leverage,
          grossPnL: rawPnL, fees: feeAmt, slippage: slipAmt, funding: fundAmt,
          netPnL, holdBars: i - entryBar, strategy: strategyName,
          season: seasonName, condition: condName, exitReason: '최대 홀딩',
        });
        if (seasonName === 'INVEST') investReturn += netPnL; else tradingReturn += netPnL;
        inPosition = false; dcaCount = 0;
        if (i % 5 === 0) equity.push({ i, v: Math.round(capital) });
        peak  = Math.max(peak, capital);
        maxDD = Math.max(maxDD, (peak - capital) / peak);
      }
    }
  }

  // ── Compute stats ─────────────────────────────────────────────
  const n = trades.length;
  if (n === 0) {
    return {
      trades: [], equity, totalReturn: 0, annualized: 0, maxDrawdown: 0,
      winRate: 0, profitFactor: 1, sharpeRatio: 0, totalTrades: 0,
      totalFees: 0, totalSlippage: 0, totalFunding: 0, avgHoldBars: 0,
      bestTrade: 0, worstTrade: 0, calmarRatio: 0,
      investModeReturn: 0, tradingModeReturn: 0, config,
    };
  }

  const wins    = trades.filter(t => t.netPnL > 0);
  const losses  = trades.filter(t => t.netPnL < 0);
  const gross   = wins.reduce((a, t) => a + t.netPnL, 0);
  const loss    = Math.abs(losses.reduce((a, t) => a + t.netPnL, 0));
  const barsAll = candles.length - WARMUP;
  const annMult = 252 * 6 / barsAll; // 4h bars → annualize

  const rets     = trades.map(t => t.netPnL / initialCapital);
  const avgRet   = rets.reduce((a, b) => a + b) / rets.length;
  const stdRet   = Math.sqrt(rets.map(r => (r - avgRet) ** 2).reduce((a, b) => a + b) / rets.length);
  const sharpe   = stdRet > 0 ? (avgRet * Math.sqrt(252)) / stdRet : 0;
  const annReturn = (capital / initialCapital - 1) * annMult;

  return {
    trades,
    equity: [...equity, { i: candles.length - 1, v: Math.round(capital) }],
    totalReturn:   Math.round((capital / initialCapital - 1) * 10000) / 100,
    annualized:    Math.round(annReturn * 10000) / 100,
    maxDrawdown:   Math.round(maxDD * 10000) / 100,
    winRate:       Math.round((wins.length / n) * 10000) / 100,
    profitFactor:  loss > 0 ? Math.round((gross / loss) * 100) / 100 : 99,
    sharpeRatio:   Math.round(sharpe * 100) / 100,
    totalTrades:   n,
    totalFees:     Math.round(trades.reduce((a, t) => a + t.fees, 0)),
    totalSlippage: Math.round(trades.reduce((a, t) => a + t.slippage, 0)),
    totalFunding:  Math.round(trades.reduce((a, t) => a + t.funding, 0)),
    avgHoldBars:   Math.round(trades.reduce((a, t) => a + t.holdBars, 0) / n),
    bestTrade:     Math.round(Math.max(...trades.map(t => t.netPnL))),
    worstTrade:    Math.round(Math.min(...trades.map(t => t.netPnL))),
    calmarRatio:   maxDD > 0 ? Math.round((annReturn / maxDD) * 100) / 100 : 0,
    investModeReturn:  Math.round(investReturn),
    tradingModeReturn: Math.round(tradingReturn),
    config,
  };
}

// Lightweight season max hold
const SEASON_CONFIGS_LITE = { INVEST: 60, TRADING: 12 };
