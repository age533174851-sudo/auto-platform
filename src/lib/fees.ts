// src/lib/fees.ts
// Exchange fee configuration and PnL calculation helpers

export type ExchangeId = 'binance' | 'upbit' | 'bithumb' | 'bybit' | 'okx' | 'coinbase' | 'kraken' | 'custom';

export interface FeeConfig {
  makerRate: number;   // e.g. 0.001 = 0.1%
  takerRate: number;
  slippage:  number;   // estimated slippage fraction
}

export interface UserFeeConfig extends FeeConfig {
  exchangeId: ExchangeId;
  label: string;
}

export interface TradePnLResult {
  grossPnl:    number;   // raw price-based PnL in KRW
  entryFee:    number;
  exitFee:     number;
  totalFee:    number;
  slippageCost: number;
  netPnl:      number;   // after fees & slippage
  netPnlPct:   number;   // as percentage of invested
  breakEvenPct: number;  // price move needed to break even
}

export interface MinViableResult {
  minMovePct:    number;  // minimum price move (%) to be profitable
  minMoveAmount: number;  // in KRW
}

// ── Default fee presets per exchange ─────────────────────────
export const DEFAULT_FEES: Record<ExchangeId, FeeConfig> = {
  binance:  { makerRate: 0.001,  takerRate: 0.001,  slippage: 0.0005 },
  upbit:    { makerRate: 0.0005, takerRate: 0.0005, slippage: 0.001  },
  bithumb:  { makerRate: 0.0025, takerRate: 0.0025, slippage: 0.001  },
  bybit:    { makerRate: 0.0001, takerRate: 0.0006, slippage: 0.0005 },
  okx:      { makerRate: 0.0008, takerRate: 0.001,  slippage: 0.0005 },
  coinbase: { makerRate: 0.004,  takerRate: 0.006,  slippage: 0.001  },
  kraken:   { makerRate: 0.0016, takerRate: 0.0026, slippage: 0.001  },
  custom:   { makerRate: 0.001,  takerRate: 0.001,  slippage: 0.001  },
};

/** Return a UserFeeConfig for a given exchange, with readable label */
export function getDefaultConfig(exchangeId: ExchangeId = 'binance'): UserFeeConfig {
  return {
    exchangeId,
    label: exchangeId.charAt(0).toUpperCase() + exchangeId.slice(1),
    ...DEFAULT_FEES[exchangeId] ?? DEFAULT_FEES.binance,
  };
}

/**
 * Calculate net PnL for a trade after fees and slippage.
 *
 * @param entryPrice  - price at which position was entered (KRW)
 * @param exitPrice   - price at which position was exited (KRW)
 * @param quantity    - quantity of asset traded
 * @param leverage    - leverage multiplier (1 = spot)
 * @param side        - 'long' or 'short'
 * @param cfg         - fee configuration
 */
export function calcTradePnL(
  entryPrice:  number,
  exitPrice:   number,
  quantity:    number,
  leverage:    number = 1,
  side:        'long' | 'short' = 'long',
  cfg:         FeeConfig = DEFAULT_FEES.binance,
): TradePnLResult {
  if (!entryPrice || !quantity) {
    return { grossPnl: 0, entryFee: 0, exitFee: 0, totalFee: 0,
             slippageCost: 0, netPnl: 0, netPnlPct: 0, breakEvenPct: 0 };
  }

  const notional = entryPrice * quantity;               // position size
  const invested = notional / Math.max(leverage, 1);    // margin / actual capital

  const priceMove = exitPrice - entryPrice;
  const grossPnl  = side === 'long'
    ? priceMove * quantity * leverage
    : -priceMove * quantity * leverage;

  const entryFee    = notional * cfg.takerRate;
  const exitFee     = exitPrice * quantity * cfg.takerRate;
  const slippageCost = notional * cfg.slippage * 2;    // entry + exit slippage
  const totalFee    = entryFee + exitFee + slippageCost;

  const netPnl      = grossPnl - totalFee;
  const netPnlPct   = invested > 0 ? (netPnl / invested) * 100 : 0;
  const breakEvenPct = invested > 0 ? (totalFee / invested) * 100 : 0;

  return { grossPnl, entryFee, exitFee, totalFee, slippageCost, netPnl, netPnlPct, breakEvenPct };
}

/**
 * Calculate the minimum price move required for a trade to be profitable.
 *
 * @param entryPrice - entry price in KRW
 * @param quantity   - position size
 * @param leverage   - leverage multiplier
 * @param cfg        - fee configuration
 */
export function calcMinViableProfit(
  entryPrice: number,
  quantity:   number,
  leverage:   number = 1,
  cfg:        FeeConfig = DEFAULT_FEES.binance,
): MinViableResult {
  if (!entryPrice || !quantity) {
    return { minMovePct: 0, minMoveAmount: 0 };
  }

  const notional     = entryPrice * quantity;
  const totalFeeEst  = notional * (cfg.takerRate * 2 + cfg.slippage * 2);
  const invested     = notional / Math.max(leverage, 1);

  const minMoveAmount = totalFeeEst / Math.max(quantity * leverage, 1);
  const minMovePct    = invested > 0 ? (totalFeeEst / invested) * 100 : 0;

  return { minMovePct, minMoveAmount };
}

/** Format a fee rate as a human-readable percentage string */
export function fmtFeeRate(rate: number): string {
  return `${(rate * 100).toFixed(3)}%`;
}

/** Calculate fee amount for a single trade leg */
export function calcFeeAmount(
  notional: number,
  cfg: FeeConfig = DEFAULT_FEES.binance,
  side: 'maker' | 'taker' = 'taker'
): number {
  if (!notional) return 0;
  const rate = side === 'maker' ? cfg.makerRate : cfg.takerRate;
  return notional * rate;
}

/** Calculate total round-trip fees (entry + exit) for a position */
export function calcRoundTripFee(
  notional: number,
  cfg: FeeConfig = DEFAULT_FEES.binance,
): number {
  if (!notional) return 0;
  return notional * (cfg.takerRate * 2 + cfg.slippage * 2);
}

