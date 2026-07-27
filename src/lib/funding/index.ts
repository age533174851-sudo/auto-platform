// ─────────────────────────────────────────────────────────────
// TRAIGO Funding Rate Engine
// Perpetual futures: funding paid every 8h (Binance/Bybit/OKX)
// Gate.io: every 8h | Upbit/Bithumb: no futures
// ─────────────────────────────────────────────────────────────

export interface FundingRate {
  symbol:      string;
  rate:        number;       // per 8h (e.g. 0.0001 = 0.01%)
  annualized:  number;       // rate * 3 * 365
  interval:    number;       // hours between payments
  nextFunding: Date | null;
  source:      'live' | 'default';
}

// ── Default funding rates by symbol (historical averages) ────
const DEFAULT_RATES: Record<string, number> = {
  'BTC':  0.0001,   // 0.01% per 8h (typical BTC)
  'ETH':  0.0001,
  'SOL':  0.00015,
  'BNB':  0.0001,
  'XRP':  0.0002,
  'DOGE': 0.0003,
  'ADA':  0.00015,
  'AVAX': 0.0002,
  'MATIC':0.0002,
  'ARB':  0.0003,
  'OP':   0.0003,
  'SUI':  0.0004,
  '_default': 0.0002,
};

// ── Get default funding rate ──────────────────────────────────
export function getDefaultFundingRate(symbol: string): FundingRate {
  const baseSymbol = symbol.replace(/USDT|PERP|BUSD/g, '').toUpperCase();
  const rate = DEFAULT_RATES[baseSymbol] ?? DEFAULT_RATES['_default'];
  return {
    symbol, rate, interval: 8,
    annualized: rate * 3 * 365,
    nextFunding: null,
    source: 'default',
  };
}

// ── Fetch live funding rate from Binance (public, no auth) ───
export async function fetchBinanceFunding(symbol: string): Promise<FundingRate | null> {
  try {
    const sym = symbol.toUpperCase().includes('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    const r   = await fetch(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const rate = parseFloat(d.lastFundingRate || '0');
    return {
      symbol: d.symbol,
      rate,
      interval: 8,
      annualized: rate * 3 * 365,
      nextFunding: d.nextFundingTime ? new Date(d.nextFundingTime) : null,
      source: 'live',
    };
  } catch { return null; }
}

// ── Fetch live funding from Bybit (public) ───────────────────
export async function fetchBybitFunding(symbol: string): Promise<FundingRate | null> {
  try {
    const sym = symbol.toUpperCase().includes('USDT') ? symbol.toUpperCase() : `${symbol.toUpperCase()}USDT`;
    const r   = await fetch(
      `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const item = d.result?.list?.[0];
    if (!item) return null;
    const rate = parseFloat(item.fundingRate || '0');
    return {
      symbol: item.symbol, rate, interval: 8,
      annualized: rate * 3 * 365,
      nextFunding: item.nextFundingTime ? new Date(parseInt(item.nextFundingTime)) : null,
      source: 'live',
    };
  } catch { return null; }
}

// ── Calculate funding cost for a position ────────────────────
export interface FundingCostParams {
  positionValue:   number;       // in USD or KRW
  fundingRate:     number;       // per interval (e.g. 0.0001)
  intervalHours:   number;       // typically 8
  holdingHours:    number;       // how long you'll hold
  isLong:          boolean;      // long pays positive rate, short receives
}

export interface FundingCost {
  totalCost:       number;       // positive = you pay
  payments:        number;       // number of funding payments
  costPerPayment:  number;
  annualizedCost:  number;       // as fraction of position
  isReceiving:     boolean;      // if negative rate and long → you receive
}

export function calcFundingCost(p: FundingCostParams): FundingCost {
  const payments = Math.floor(p.holdingHours / p.intervalHours);
  // Long pays when rate > 0, receives when rate < 0
  const direction = p.isLong ? 1 : -1;
  const costPerPayment = p.positionValue * p.fundingRate * direction;
  const totalCost = costPerPayment * payments;
  return {
    totalCost,
    payments,
    costPerPayment,
    annualizedCost: p.fundingRate * direction * (8760 / p.intervalHours),
    isReceiving: totalCost < 0,
  };
}

// ── Format funding rate for display ──────────────────────────
export function fmtFundingRate(rate: number): string {
  const pct = rate * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(4)}%`;
}

export function fmtFundingAnnual(rate: number): string {
  const annual = rate * 3 * 365 * 100;
  return `연 ${annual.toFixed(1)}%`;
}
