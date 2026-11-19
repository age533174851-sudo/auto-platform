// ─────────────────────────────────────────────────────────────
// TRAIGO P&L Engine — Real Net Profit Calculator
// Integrates: fees + funding + slippage
// ─────────────────────────────────────────────────────────────
// ── 수수료 요율 — 이 모듈이 실제로 읽는 것만 받는다 ──
//
// 예전에는 `'../fees'`에서 요율 타입을 가져왔다. 그 경로가
// **`src/lib/fees.ts`(파일)와 `src/lib/fees/index.ts`(디렉터리) 중
// 조용히 파일 쪽을 골랐고**, 두 모듈은 같은 이름으로 다른 모양을
// 내놓았다 — 파일 쪽은 `takerRate`를 직접 들고 있고, 디렉터리 쪽은
// VIP 구간표에 `calcFeeRate()`로 계산한다.
//
// 그 모호함이 실제로 고장을 냈다: `backtest`·`safety`가
// `getDefaultConfig(exchange, 'futures')`를 불렀는데 파일 쪽 서명은
// 인자가 하나뿐이라 `'futures'`가 버려지고 **선물 비용을 현물 요율로**
// 재고 있었다(정확히 2배).
//
// 그래서 파일 쪽을 없앴다. 이 모듈이 요구하는 것은 **taker 요율
// 하나**이므로, 남의 타입을 빌리지 않고 여기서 그만큼만 적는다.
// 필드를 다 채운 객체도 그대로 들어온다 — 구조적으로 더 넓기 때문이다.
export interface PnlFeeRates {
  /** 시장가 수수료율. 없으면 호출부에서 0.001로 가정한다 */
  takerRate?: number;
  makerRate?: number;
  /** 예상 슬리피지 비율 */
  slippage?: number;
}
import { calcFundingCost, FundingCostParams } from '../funding';
import { calcSlippage, SlippageParams } from '../slippage';

// ── Full trade P&L parameters ────────────────────────────────
export interface TradePnLParams {
  entryPrice:    number;
  exitPrice:     number;
  quantity:      number;       // units
  leverage:      number;       // 1 = spot
  isLong:        boolean;
  feeConfig:     PnlFeeRates;
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

  // 2. Fees (수수료만 — 슬리피지는 3번에서 별도 계산하므로 중복 금지)
  const takerRate = p.feeConfig.takerRate ?? 0.001;
  const entryFee  = entryValue * takerRate;
  const exitFee   = exitValue  * takerRate;
  const totalFee  = entryFee + exitFee;
  const feesPct   = entryValue > 0 ? totalFee / entryValue : 0;

  // 3. Slippage
  const slipParams: Partial<SlippageParams> = {
    dailyVolume: p.dailyVolume,
    assetType:   p.dailyVolume > 1e9 ? 'major' : p.dailyVolume > 1e8 ? 'mid' : 'small',
    exchange:    (p.feeConfig as any).exchangeId,
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
  const totalCosts = totalFee + totalSlip + fundingCost;
  const netPnL     = grossPnL - totalCosts;
  const netPct     = entryValue > 0 ? netPnL / entryValue : 0;
  const netLevered = marginUsed  > 0 ? netPnL / marginUsed : 0;

  // 6. Break-even
  const breakEvenMove = entryValue > 0 ? totalCosts / entryValue : 0;
  const minProfitMove = breakEvenMove * 1.001; // tiny buffer

  if (netPnL < 0 && grossPnL > 0) {
    warnings.push(`수수료/슬리피지로 인해 수익이 손실로 전환됨`);
  }
  if (totalFee > Math.abs(grossPnL) * 0.3) {
    warnings.push(`수수료가 총 수익의 30% 이상`);
  }

  return {
    grossPnL, grossPnLPct: grossPct,
    entryFee, exitFee,
    totalFees: totalFee, feesPct,
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
  feeConfig: PnlFeeRates,
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
  const feesPct   = (feeConfig.takerRate ?? 0.001) * 2;   // 왕복 수수료 비율 (진입+청산)

  const fc        = calcFundingCost({ positionValue: entryValue, fundingRate, intervalHours: 8, holdingHours, isLong: true });
  const fundingPct = fc.totalCost / entryValue;

  const slip      = calcSlippage({ orderSize: entryValue, dailyVolume, assetType: dailyVolume > 1e9 ? 'major' : 'mid', exchange: (feeConfig as any).exchangeId });
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
  feeConfig:      PnlFeeRates;
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

  // Fees (진입+청산 수수료)
  const taker = cfg.feeConfig.takerRate ?? 0.001;
  const feeTotal = entryValue * taker + exitValue * taker;

  // Slippage (if enabled)
  let slipTotal = 0;
  if (cfg.applySlippage) {
    const es = calcSlippage({ orderSize: entryValue, dailyVolume: cfg.dailyVolume, assetType: 'mid', exchange: (cfg.feeConfig as any).exchangeId });
    const xs = calcSlippage({ orderSize: exitValue,  dailyVolume: cfg.dailyVolume, assetType: 'mid', exchange: (cfg.feeConfig as any).exchangeId });
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
  const totalCosts = feeTotal + slipTotal + fundingTotal;
  const netPnL = grossPnL - totalCosts;

  return { netPnL, grossPnL, totalCosts, feeTotal, slipTotal, fundingTotal };
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
