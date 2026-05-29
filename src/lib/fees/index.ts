// ─────────────────────────────────────────────────────────────
// TRAIGO Fee Engine
// Supports: Maker/Taker, VIP tiers, referral, KRW/USD
// ─────────────────────────────────────────────────────────────

export type ExchangeId = 'binance'|'gate'|'bybit'|'okx'|'upbit'|'bithumb';
export type MarketType = 'spot'|'futures'|'perp';
export type OrderType  = 'maker'|'taker';

// ── Default fee tiers (rate as decimal, e.g. 0.001 = 0.1%) ──
export interface FeeTier {
  maker: number;
  taker: number;
  label: string;
}

export const DEFAULT_FEES: Record<ExchangeId, { spot: FeeTier[]; futures: FeeTier[] }> = {
  binance: {
    spot: [
      { label:'VIP0', maker:0.001,  taker:0.001  },
      { label:'VIP1', maker:0.0009, taker:0.001  },
      { label:'VIP2', maker:0.0008, taker:0.001  },
      { label:'VIP3', maker:0.0007, taker:0.001  },
      { label:'VIP4', maker:0.0006, taker:0.0009 },
      { label:'VIP5', maker:0.0005, taker:0.0008 },
    ],
    futures: [
      { label:'VIP0', maker:0.0002, taker:0.0005 },
      { label:'VIP1', maker:0.00016,taker:0.0004 },
      { label:'VIP2', maker:0.00014,taker:0.00035},
      { label:'VIP3', maker:0.00012,taker:0.0003 },
      { label:'VIP4', maker:0.0001, taker:0.00025},
    ],
  },
  gate: {
    spot: [
      { label:'Lv0', maker:0.002,  taker:0.002  },
      { label:'Lv1', maker:0.0019, taker:0.0019 },
      { label:'Lv2', maker:0.0018, taker:0.0018 },
      { label:'Lv3', maker:0.0016, taker:0.0017 },
      { label:'Lv4', maker:0.0014, taker:0.0016 },
    ],
    futures: [
      { label:'Lv0', maker:0.0, taker:0.0005 },
      { label:'Lv1', maker:0.0, taker:0.0004 },
      { label:'Lv2', maker:0.0, taker:0.00035},
    ],
  },
  bybit: {
    spot: [
      { label:'Lv0', maker:0.001,  taker:0.001  },
      { label:'Lv1', maker:0.0008, taker:0.001  },
      { label:'Lv2', maker:0.0006, taker:0.0009 },
    ],
    futures: [
      { label:'Lv0', maker:0.0001, taker:0.0006 },
      { label:'Lv1', maker:0.00008,taker:0.0005 },
      { label:'Lv2', maker:0.00006,taker:0.0004 },
    ],
  },
  okx: {
    spot: [
      { label:'Lv1', maker:0.0008, taker:0.001  },
      { label:'Lv2', maker:0.0007, taker:0.0009 },
      { label:'Lv3', maker:0.0006, taker:0.0008 },
    ],
    futures: [
      { label:'Lv1', maker:0.0002, taker:0.0005 },
      { label:'Lv2', maker:0.00015,taker:0.0004 },
    ],
  },
  upbit: {
    spot: [
      { label:'기본', maker:0.0005, taker:0.0005 },
    ],
    futures: [
      { label:'기본', maker:0.0005, taker:0.0005 },
    ],
  },
  bithumb: {
    spot: [
      { label:'기본', maker:0.0025, taker:0.0025 },
      { label:'BTC 1000+', maker:0.002, taker:0.002 },
      { label:'BTC 5000+', maker:0.0015, taker:0.0015 },
    ],
    futures: [
      { label:'기본', maker:0.002, taker:0.002 },
    ],
  },
};

// ── User fee configuration ────────────────────────────────────
export interface UserFeeConfig {
  exchange:      ExchangeId;
  marketType:    MarketType;
  vipTier:       number;           // index into DEFAULT_FEES tiers
  customMaker?:  number;           // override
  customTaker?:  number;           // override
  referralDiscount: number;        // e.g. 0.20 = 20% discount
  bnbDiscount:   boolean;          // Binance BNB -25%
}

export function getDefaultConfig(exchange: ExchangeId, marketType: MarketType = 'spot'): UserFeeConfig {
  return { exchange, marketType, vipTier:0, referralDiscount:0, bnbDiscount:false };
}

// ── Core fee calculation ──────────────────────────────────────
export function calcFeeRate(config: UserFeeConfig, orderType: OrderType): number {
  const tiers = DEFAULT_FEES[config.exchange]?.[config.marketType] || DEFAULT_FEES[config.exchange]?.spot;
  const tier  = tiers?.[Math.min(config.vipTier, tiers.length-1)] || tiers?.[0];
  if (!tier) return 0.001;

  let rate = orderType === 'maker' ? tier.maker : tier.taker;

  // Custom override
  if (config.customMaker !== undefined && orderType === 'maker') rate = config.customMaker;
  if (config.customTaker !== undefined && orderType === 'taker') rate = config.customTaker;

  // Referral discount
  if (config.referralDiscount > 0) rate *= (1 - config.referralDiscount);

  // Binance BNB discount (-25%)
  if (config.exchange === 'binance' && config.bnbDiscount) rate *= 0.75;

  return Math.max(0, rate);
}

export function calcFeeAmount(
  amount:    number,        // trade value in KRW or USD
  config:    UserFeeConfig,
  orderType: OrderType = 'taker'
): number {
  return amount * calcFeeRate(config, orderType);
}

// ── Round trip fee (entry + exit) ─────────────────────────────
export function calcRoundTripFee(
  entryAmount: number,
  exitAmount:  number,
  config:      UserFeeConfig,
  entryType:   OrderType = 'taker',
  exitType:    OrderType = 'taker'
): { entryFee: number; exitFee: number; totalFee: number; rate: number } {
  const entryFee = calcFeeAmount(entryAmount, config, entryType);
  const exitFee  = calcFeeAmount(exitAmount,  config, exitType);
  const totalFee = entryFee + exitFee;
  return { entryFee, exitFee, totalFee, rate: calcFeeRate(config, 'taker') };
}

// ── Fee tier info (for UI display) ───────────────────────────
export function getFeeTierInfo(exchange: ExchangeId, marketType: MarketType = 'spot') {
  return DEFAULT_FEES[exchange]?.[marketType] || DEFAULT_FEES[exchange]?.spot || [];
}

// ── Format fee rate for display ──────────────────────────────
export function fmtFeeRate(rate: number): string {
  return (rate * 100).toFixed(4) + '%';
}
