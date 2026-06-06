// ─────────────────────────────────────────────────────────────
// TRAIGO P&L Engine — Real Net Profit Calculator
// Integrates: fees + funding + slippage
// ─────────────────────────────────────────────────────────────
import { calcRoundTripFee, UserFeeConfig } from '../fees';
import { calcFundingCost, FundingCostParams } from '../funding';
import { calcSlippage, SlippageParams } from '../slippage';

// ── Full trade P&L parameters ────────────────────────────────
export interface TradePnLParams {
  entryPrice:    number;
  exitPrice:     number;
  quantity:      number;       // units
  leverage:      number;       // 1 = spot
  isLong:        boolean;
  feeConfig:     UserFeeConfig;
  dailyVolume:   number;       // for slippage
  holdingHours:  number;       // for funding
  fundingRate:   number;       // per 8h
  isFutures:     boolean;
}

// ── Full trade P&L result ─────────────────────────────────────
export interface TradePnLResult {
  // Gross
  grossPnL:      number;       // raw price move × qty
  grossPnLPct:   number;       // % of entry capital

  // Costs
  entryFee:      number;
  exitFee:       number;
  totalFees:     number;
  feesPct:       number;       // % of entry value

  entrySlippage: number;
  exitSlippage:  number;
  totalSlippage: number;

  fundingCost:   number;       // positive = you paid
  fundingPayments: number;

  totalCosts:    number;

  // Net
  netPnL:        number;
  netPnLPct:     number;       // % of entry capital
  netPnLLevered: number;       // % on margin (capital used)
  marginUsed:    number;

  // Safety
  breakEvenMove: number;       // % price move needed to break even
  minProfitMove: number;       // price move to clear all costs
  isViable:      boolean;      // net > 0 after all costs
  warnings:      string[];
}

// ── Main P&L calculator ───────────────────────────────────────
export function calcTradePnL(p: TradePnLParams): TradePnLResult {
  const entryValue  = p.entryPrice * p.quantity;
  const exitValue   = p.exitPrice  * p.quantity;
  const marginUsed  = entryValue / p.leverage;
  const warnings: string[] = [];

  // 1. Gross P&L
  const rawMove  = p.isLong ? (p.exitPrice - p.entryPrice) : (p.entryPrice - p.exitPrice);
  const grossPnL = rawMove * p.quantity;
  const grossPct = entryValue > 0 ? rawMove / p.entryPrice : 0;

  // 2. Fees
  const fees = calcRoundTripFee(
    entryValue, exitValue,
    { ...p.feeConfig, marketType: p.isFutures ? 'futures' : 'spot' }
  );
  const feesPct = entryValue > 0 ? fees.totalFee / entryValue : 0;

  // 3. Slippage
  const slipParams: Partial<SlippageParams> = {
    dailyVolume: p.dailyVolume,
    assetType:   p.dailyVolume > 1e9 ? 'major' : p.dailyVolume > 1e8 ? 'mid' : 'small',
    exchange:    p.feeConfig.exchange,
  };
  const entrySlip = calcSlippage({ ...slipParams, orderSize: entryValue } as SlippageParams);
  const exitSlip  = calcSlippage({ ...slipParams, orderSize: exitValue  } as SlippageParams);
  const totalSlip = entrySlip.amount + exitSlip.amount;

  if (entrySlip.warning) warnings.push(entrySlip.warning);

  // 4. Funding
  let fundingCost = 0;
  let fundingPayments = 0;
  if (p.isFutures && p.holdingHours > 0) {
    const fc = calcFundingCost({
      positionValue: entryValue, fundingRate: p.fundingRate,
      intervalHours: 8, holdingHours: p.holdingHours, isLong: p.isLong,
    });
    fundingCost     = fc.totalCost;
    fundingPayments = fc.payments;
    if (Math.abs(fundingCost) > entryValue * 0.002) {
      warnings.push(`펀딩비 누적 주의: ${(fundingCost/entryValue*100).toFixed(2)}%`);
    }
  }

  // 5. Totals
  const totalCosts = fees.totalFee + totalSlip + fundingCost;
  const netPnL     = grossPnL - totalCosts;
  const netPct     = entryValue > 0 ? netPnL / entryValue : 0;
  const netLevered = marginUsed  > 0 ? netPnL / marginUsed : 0;

  // 6. Break-even
  const breakEvenMove = entryValue > 0 ? totalCosts / entryValue : 0;
  const minProfitMove = breakEvenMove * 1.001; // tiny buffer

  if (netPnL < 0 && grossPnL > 0) {
    warnings.push(`수수료/슬리피지로 인해 수익이 손실로 전환됨`);
  }
  if (fees.totalFee > Math.abs(grossPnL) * 0.3) {
    warnings.push(`수수료가 총 수익의 30% 이상`);
  }

  return {
    grossPnL, grossPnLPct: grossPct,
    entryFee: fees.entryFee, exitFee: fees.exitFee,
    totalFees: fees.totalFee, feesPct,
    entrySlippage: entrySlip.amount, exitSlippage: exitSlip.amount, totalSlippage: totalSlip,
    fundingCost, fundingPayments,
    totalCosts,
    netPnL, netPnLPct: netPct, netPnLLevered: netLevered,
    marginUsed,
    breakEvenMove, minProfitMove,
    isViable: netPnL > 0,
    warnings,
  };
}

// ── Minimum viable profit calc ────────────────────────────────
export function calcMinViableProfit(
  entryValue: number,
  feeConfig: UserFeeConfig,
  fundingRate: number = 0.0001,
  holdingHours: number = 24,
  dailyVolume: number = 1e9,
  minProfitPct: number = 0.005,    // 0.5% minimum desired profit
): {
  minMove:          number;        // minimum price move needed (%)
  totalCostsPct:    number;
  feesPct:          number;
  fundingPct:       number;
  slippagePct:      number;
} {
  const fees      = calcRoundTripFee(entryValue, entryValue, feeConfig);
  const feesPct   = fees.totalFee / entryValue;

  const fc        = calcFundingCost({ positionValue: entryValue, fundingRate, intervalHours: 8, holdingHours, isLong: true });
  const fundingPct = fc.totalCost / entryValue;

  const slip      = calcSlippage({ orderSize: entryValue, dailyVolume, assetType: dailyVolume > 1e9 ? 'major' : 'mid', exchange: feeConfig.exchange });
  const slipPct   = slip.rate * 2; // entry + exit

  const totalCostsPct = feesPct + Math.abs(fundingPct) + slipPct;
  const minMove       = totalCostsPct + minProfitPct;

  return { minMove, totalCostsPct, feesPct, fundingPct, slippagePct: slipPct };
}

// ── Backtest-compatible fee/cost application ──────────────────
export interface BacktestTrade {
  entryPrice: number;
  exitPrice:  number;
  entryIdx:   number;
  exitIdx:    number;
  isLong:     boolean;
  quantity:   number;
}

export interface BacktestCostConfig {
  feeConfig:      UserFeeConfig;
  applySlippage:  boolean;
  applyFunding:   boolean;
  dailyVolume:    number;
  fundingRate:    number;
  barsPerHour:    number;       // e.g. 1 for 1h bars
}

export function applyBacktestCosts(
  trade: BacktestTrade,
  cfg:   BacktestCostConfig
): { netPnL: number; grossPnL: number; totalCosts: number; feeTotal: number; slipTotal: number; fundingTotal: number } {
  const entryValue = trade.entryPrice * trade.quantity;
  const exitValue  = trade.exitPrice  * trade.quantity;

  // Fees
  const fees = calcRoundTripFee(entryValue, exitValue, cfg.feeConfig);

  // Slippage (if enabled)
  let slipTotal = 0;
  if (cfg.applySlippage) {
    const es = calcSlippage({ orderSize: entryValue, dailyVolume: cfg.dailyVolume, assetType: 'mid', exchange: cfg.feeConfig.exchange });
    const xs = calcSlippage({ orderSize: exitValue,  dailyVolume: cfg.dailyVolume, assetType: 'mid', exchange: cfg.feeConfig.exchange });
    slipTotal = es.amount + xs.amount;
  }

  // Funding (if enabled)
  let fundingTotal = 0;
  if (cfg.applyFunding) {
    const holdingBars  = trade.exitIdx - trade.entryIdx;
    const holdingHours = holdingBars / cfg.barsPerHour;
    const fc = calcFundingCost({ positionValue: entryValue, fundingRate: cfg.fundingRate, intervalHours: 8, holdingHours, isLong: trade.isLong });
    fundingTotal = fc.totalCost;
  }

  const rawMove  = trade.isLong ? (trade.exitPrice - trade.entryPrice) : (trade.entryPrice - trade.exitPrice);
  const grossPnL = rawMove * trade.quantity;
  const totalCosts = fees.totalFee + slipTotal + fundingTotal;
  const netPnL = grossPnL - totalCosts;

  return { netPnL, grossPnL, totalCosts, feeTotal: fees.totalFee, slipTotal, fundingTotal };
}

// ── Formatters ────────────────────────────────────────────────
export function fmtPnL(v: number, currency: string = 'KRW'): string {
  const sym = currency === 'KRW' ? '₩' : '$';
  const abs = Math.abs(v);
  const str = abs >= 1e8  ? sym + (abs/1e8).toFixed(1) + '억'
            : abs >= 1e4  ? sym + Math.round(abs).toLocaleString('ko-KR')
            : sym + abs.toFixed(2);
  return v < 0 ? '-' + str : str;
}

export function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(3) + '%';
}
