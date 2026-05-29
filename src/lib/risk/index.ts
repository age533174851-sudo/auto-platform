// ─────────────────────────────────────────────────────────────
// TRAIGO Risk Engine — Smart Position System
// Partial TP, trailing stop, DCA management, dynamic sizing
// ─────────────────────────────────────────────────────────────

export interface PositionState {
  id:           string;
  symbol:       string;
  side:         'long' | 'short';
  entryPrice:   number;
  currentPrice: number;
  quantity:     number;
  leverage:     number;
  stopLoss:     number;
  takeProfits:  { price: number; qty: number; hit: boolean }[];
  trailingStop: { enabled: boolean; distance: number; highWater: number };
  breakeven:    { enabled: boolean; triggered: boolean };
  dcaEntries:   { price: number; qty: number }[];
  openedAt:     string;
  pnl:          number;
  pnlPct:       number;
  status:       'open' | 'partial' | 'closed';
}

// ── Trailing stop management ──────────────────────────────────
export function updateTrailingStop(pos: PositionState): PositionState {
  const { trailingStop: ts, side, currentPrice, stopLoss } = pos;
  if (!ts.enabled) return pos;

  const newHigh = side === 'long'
    ? Math.max(ts.highWater, currentPrice)
    : Math.min(ts.highWater || currentPrice, currentPrice);

  const newStop = side === 'long'
    ? newHigh * (1 - ts.distance)
    : newHigh * (1 + ts.distance);

  // Only move stop in favorable direction
  const improvedStop = side === 'long'
    ? Math.max(stopLoss, newStop)
    : Math.min(stopLoss, newStop);

  return {
    ...pos,
    stopLoss: Math.round(improvedStop),
    trailingStop: { ...ts, highWater: newHigh },
  };
}

// ── Auto breakeven ────────────────────────────────────────────
export function checkBreakeven(pos: PositionState, fee: number = 0.001): PositionState {
  if (!pos.breakeven.enabled || pos.breakeven.triggered) return pos;

  const { side, entryPrice, currentPrice } = pos;
  const breakevenPx = side === 'long'
    ? entryPrice * (1 + fee * 2)
    : entryPrice * (1 - fee * 2);

  const inProfit = side === 'long'
    ? currentPrice > breakevenPx * 1.01
    : currentPrice < breakevenPx * 0.99;

  if (inProfit) {
    return {
      ...pos,
      stopLoss: Math.round(breakevenPx),
      breakeven: { ...pos.breakeven, triggered: true },
    };
  }
  return pos;
}

// ── Partial take profit ───────────────────────────────────────
export function checkPartialTP(
  pos: PositionState,
): { pos: PositionState; closed: number } {
  let closedQty = 0;
  const tps = pos.takeProfits.map(tp => {
    if (tp.hit) return tp;
    const hit = pos.side === 'long'
      ? pos.currentPrice >= tp.price
      : pos.currentPrice <= tp.price;
    if (hit) { closedQty += tp.qty; return { ...tp, hit: true }; }
    return tp;
  });
  return {
    pos: { ...pos, takeProfits: tps, status: closedQty > 0 ? 'partial' : pos.status },
    closed: closedQty,
  };
}

// ── Dynamic position sizing ───────────────────────────────────
export interface SizingInput {
  capital:       number;       // total available capital
  riskPct:       number;       // max risk % per trade (e.g. 0.01 = 1%)
  entryPrice:    number;
  stopLoss:      number;
  leverage:      number;
  riskMultiplier:number;       // from season engine (0.3-1.5)
  signal:        { strength: number };
}

export interface SizingResult {
  positionSize:   number;      // total position value
  quantity:       number;      // units to buy/sell
  riskAmount:     number;      // max loss in currency
  marginRequired: number;      // capital needed
  kellyFraction:  number;      // Kelly criterion fraction used
}

export function calcPositionSize(input: SizingInput): SizingResult {
  const { capital, riskPct, entryPrice, stopLoss, leverage, riskMultiplier, signal } = input;

  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  if (riskPerUnit <= 0 || entryPrice <= 0) {
    return { positionSize: 0, quantity: 0, riskAmount: 0, marginRequired: 0, kellyFraction: 0 };
  }

  // Adjusted risk based on season + signal strength
  const signalMultiplier = signal.strength / 100;
  const adjustedRisk = riskPct * riskMultiplier * signalMultiplier;
  const riskAmount = capital * Math.min(adjustedRisk, 0.05); // cap at 5%

  // Position size via fixed-fractional risk
  const positionSize = (riskAmount / riskPerUnit) * entryPrice;
  const cappedPosition = Math.min(positionSize, capital * 2 * leverage); // cap at 2x capital

  const quantity       = cappedPosition / entryPrice;
  const marginRequired = cappedPosition / leverage;
  const kellyFraction  = adjustedRisk;

  return {
    positionSize: Math.round(cappedPosition),
    quantity:     Math.round(quantity * 1000) / 1000,
    riskAmount:   Math.round(riskAmount),
    marginRequired: Math.round(marginRequired),
    kellyFraction,
  };
}

// ── DCA management ────────────────────────────────────────────
export interface DCAConfig {
  baseQty:       number;
  maxEntries:    number;
  priceDropPct:  number;       // trigger DCA on X% dip
  multiplier:    number;       // each DCA is X× bigger
}

export function calcNextDCA(
  pos:    PositionState,
  config: DCAConfig,
): { shouldDCA: boolean; dcaPrice: number; dcaQty: number } {
  const count    = pos.dcaEntries.length;
  if (count >= config.maxEntries) return { shouldDCA: false, dcaPrice: 0, dcaQty: 0 };

  const lastEntry = count > 0
    ? pos.dcaEntries[count - 1].price
    : pos.entryPrice;
  const triggerPrice = pos.side === 'long'
    ? lastEntry * (1 - config.priceDropPct)
    : lastEntry * (1 + config.priceDropPct);

  const shouldDCA = pos.side === 'long'
    ? pos.currentPrice <= triggerPrice
    : pos.currentPrice >= triggerPrice;

  return {
    shouldDCA,
    dcaPrice: triggerPrice,
    dcaQty:   config.baseQty * Math.pow(config.multiplier, count),
  };
}

// ── Risk limits (weekly) ──────────────────────────────────────
export interface WeeklyRisk {
  weeklyLoss:       number;
  maxWeeklyLoss:    number;
  weeklyTradeCount: number;
  isHalted:         boolean;
}

export function checkWeeklyLimits(risk: WeeklyRisk): {
  allowed: boolean;
  reason?: string;
} {
  if (risk.isHalted) return { allowed: false, reason: '주간 손실 한도 초과로 자동 정지됨' };
  if (risk.weeklyLoss >= risk.maxWeeklyLoss) {
    return { allowed: false, reason: `주간 손실 한도 도달: ₩${risk.weeklyLoss.toLocaleString()}` };
  }
  return { allowed: true };
}
