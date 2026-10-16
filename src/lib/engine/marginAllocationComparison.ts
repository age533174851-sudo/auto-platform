// Research-only sizing comparison for the Exact100X margin-allocation contract.
//
// IMPORTANT: This module is intentionally NOT imported by any order executor,
// route, scheduler, or live sizing function. It neither chooses trading signals
// nor authorizes an order. All returns are NET returns on the margin committed
// to that trade (including fees/funding). Never multiply these by 100 again.
//
// The fixed model maintains its starting stake after profits, REDUCES it when
// equity falls, and permits a hypothetical step-up only after independent
// performance review AND an explicit scenario approval. This prevents hidden
// compounding when the actual execution contract uses availableUsd * pct.
export type ComparisonEvidence = 'VERIFIED' | 'SYNTHETIC';

export interface CompletedMarginTrade {
  // E.g. 0.20 = +20% on allocated margin NET of all exchange costs;
  // -1 = complete loss of the committed margin. Not underlying price return.
  netReturnOnMargin: number;
  evidence: ComparisonEvidence;
  costsIncluded: boolean;
}

export interface ReviewCriteria {
  minClosedTrades: number;
  maxDrawdownPct: number;
  // Maximum change in nominal base stake at ONE approved review.
  maxStepIncreasePct: number;
}

export interface HypotheticalStep {
  // Apply to the next trade, after this many closed trades have been reviewed.
  afterClosedTrades: number;
  newBaseMarginUsd: number;
  explicitlyApproved: boolean;
}

export interface ComparisonInput {
  initialEquityUsd: number;
  initialMarginUsd: number;
  trades: readonly CompletedMarginTrade[];
  review: ReviewCriteria;
  steps?: readonly HypotheticalStep[];
}

export interface ReviewVerdict {
  eligibleForHumanReview: boolean;
  reasons: string[];
}

export interface SizingSimulation {
  endingEquityUsd: number;
  netPnlUsd: number;
  maxDrawdownPct: number;
  completedTrades: number;
  marginsUsd: number[];
  // Reviewed but non-qualifying / unapproved step-ups never apply.
  appliedSteps: number[];
  skippedSteps: number[];
}

export interface ComparisonResult {
  // A: 10% of CURRENT equity, compounding up AND down after every trade.
  tenPercentOfEquity: SizingSimulation;
  // B: fixed starting stake; scale DOWN on drawdown; step UP only on evidence.
  fixedThenReviewedStep: SizingSimulation;
  finalReview: ReviewVerdict;
  // This pure comparison is NEVER a production sizing authorization.
  executionAuthorized: false;
}

const validPositive = (n: number): boolean => Number.isFinite(n) && n > 0;

function requireValid(i: ComparisonInput): void {
  if (!validPositive(i.initialEquityUsd) || !validPositive(i.initialMarginUsd)) {
    throw new Error('Initial equity and margin must be positive, finite values');
  }
  if (i.initialMarginUsd > i.initialEquityUsd * 0.1 + 1e-9) {
    throw new Error('Initial margin exceeds the 10% research risk ceiling');
  }
  if (!Number.isInteger(i.review.minClosedTrades) || i.review.minClosedTrades < 1 ||
      !Number.isFinite(i.review.maxDrawdownPct) || i.review.maxDrawdownPct < 0 ||
      i.review.maxDrawdownPct > 100 ||
      !Number.isFinite(i.review.maxStepIncreasePct) ||
      i.review.maxStepIncreasePct <= 0 || i.review.maxStepIncreasePct > 100) {
    throw new Error('Explicit performance-review criteria are required');
  }
  for (const trade of i.trades) {
    if (!Number.isFinite(trade.netReturnOnMargin) || trade.netReturnOnMargin < -1) {
      throw new Error('Net return on isolated margin must be finite and >= -100% in this limited model');
    }
    if (trade.costsIncluded !== true) {
      throw new Error('Fees and funding must already be included in each net return');
    }
    if (trade.evidence !== 'VERIFIED' && trade.evidence !== 'SYNTHETIC') {
      throw new Error('Unknown trade provenance');
    }
  }
  let previous = 0;
  for (const step of i.steps || []) {
    if (!Number.isInteger(step.afterClosedTrades) ||
        step.afterClosedTrades <= previous ||
        step.afterClosedTrades >= i.trades.length ||
        !validPositive(step.newBaseMarginUsd) ||
        typeof step.explicitlyApproved !== 'boolean') {
      throw new Error('Steps require unique ascending closed-trade boundaries and explicit approval status');
    }
    previous = step.afterClosedTrades;
  }
}

function reviewAt(
  trades: readonly CompletedMarginTrade[],
  count: number,
  equity: number,
  initialEquity: number,
  maximumDrawdownPct: number,
  criteria: ReviewCriteria,
): ReviewVerdict {
  const reasons: string[] = [];
  if (count < criteria.minClosedTrades) {
    reasons.push('Insufficient closed-trade sample');
  }
  if (trades.slice(0, count).some(t => t.evidence !== 'VERIFIED')) {
    reasons.push('Synthetic or unverified trade evidence cannot approve an increase');
  }
  if (equity <= initialEquity) {
    reasons.push('No positive realized net account profit');
  }
  if (maximumDrawdownPct > criteria.maxDrawdownPct) {
    reasons.push('Maximum drawdown is above the review limit');
  }
  return { eligibleForHumanReview: reasons.length === 0, reasons };
}

function simulate(i: ComparisonInput, mode: 'TEN_PERCENT' | 'FIXED'): SizingSimulation {
  let equity = i.initialEquityUsd;
  let peak = equity;
  let maxDrawdownPct = 0;
  let baseMargin = i.initialMarginUsd;
  let stepIndex = 0;
  const marginsUsd: number[] = [];
  const appliedSteps: number[] = [];
  const skippedSteps: number[] = [];
  const steps = i.steps || [];

  for (let n = 0; n < i.trades.length; n++) {
    if (mode === 'FIXED' && stepIndex < steps.length &&
        steps[stepIndex].afterClosedTrades === n) {
      const step = steps[stepIndex++];
      const review = reviewAt(i.trades, n, equity, i.initialEquityUsd,
        maxDrawdownPct, i.review);
      const withinOneStep = step.newBaseMarginUsd > baseMargin &&
        step.newBaseMarginUsd <= baseMargin * (1 + i.review.maxStepIncreasePct / 100) + 1e-9;
      if (step.explicitlyApproved && review.eligibleForHumanReview && withinOneStep) {
        baseMargin = step.newBaseMarginUsd;
        appliedSteps.push(n);
      } else {
        skippedSteps.push(n);
      }
    }

    // Lower the fixed stake on ANY drawdown from the running equity peak;
    // never raise it automatically, even when gains exceed starting equity.
    // Equity-only model: excludes mark-to-market, slippage/market impact and
    // simultaneous positions; these need separate execution-path validation.
    const riskCeiling = equity * 0.1;
    const requested = mode === 'TEN_PERCENT'
      ? riskCeiling
      : baseMargin * Math.min(1, equity / peak);
    const margin = Math.max(0, Math.min(riskCeiling, requested));
    marginsUsd.push(margin);
    equity = Math.max(0, equity + margin * i.trades[n].netReturnOnMargin);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct,
      peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }
  return {
    endingEquityUsd: equity,
    netPnlUsd: equity - i.initialEquityUsd,
    maxDrawdownPct,
    completedTrades: i.trades.length,
    marginsUsd, appliedSteps, skippedSteps,
  };
}

/**
 * Deterministic OFFLINE scenario comparison only. No market forecasts, API
 * access, ledger edits, mode switches or trade instructions occur here.
 */
export function compareMarginAllocationScenarios(i: ComparisonInput): ComparisonResult {
  requireValid(i);
  const tenPercentOfEquity = simulate(i, 'TEN_PERCENT');
  const fixedThenReviewedStep = simulate(i, 'FIXED');
  const finalReview = reviewAt(i.trades, i.trades.length,
    fixedThenReviewedStep.endingEquityUsd, i.initialEquityUsd,
    fixedThenReviewedStep.maxDrawdownPct, i.review);
  return { tenPercentOfEquity, fixedThenReviewedStep, finalReview,
    executionAuthorized: false };
}


// ── Independent research utilities: cost-aware replay and volatility policy ──
// None of these exports is invoked by an executor, route, schedule, or worker.
// Every rate is EXPLICIT. There are no assumed exchange fee tiers or stops.

export interface ObservedPricePath {
  side: 'LONG' | 'SHORT';
  marketEntryPrice: number;
  marketExitPrice: number;
  // Largest observed adverse underlying-price move while the trade was open.
  // Must be supplied from intratrade candles/ticks; endpoint prices alone
  // cannot reveal an intervening liquidation.
  adverseExcursionPct: number;
  // SCENARIO threshold, not an inferred Binance liquidation price.
  // Maintenance margin, fees, tiers and mark-price rules belong to the venue.
  assumedLiquidationDistancePct: number;
}

export interface ExplicitFriction {
  entryFeeRate: number;     // Decimal share of notional, e.g. .0005 = .05%.
  exitFeeRate: number;      // Decimal share of notional.
  entrySlippagePct: number; // Underlying price adverse execution drift in %.
  exitSlippagePct: number;
  signedFundingRate: number; // Decimal of entry notional. Positive = cost.
}

export interface CostedTrade {
  trade: CompletedMarginTrade; // Always SYNTHETIC; never trusted ledger evidence.
  pricePnlOnMargin: number;
  feesOnMargin: number;
  slippageOnMargin: number; // Drift relative to zero-slippage entry/exit.
  fundingOnMargin: number;
  netBeforeLossCap: number;
  scenarioAssumedLiquidation: boolean;
  executionAuthorized: false;
}

/** 100X is the user's proposed scenario; not a recommendation to trade. */
export function estimateCostedMarginTrade(
  path: ObservedPricePath, friction: ExplicitFriction, leverage: number,
): CostedTrade {
  const goodPrice = (x: number) => Number.isFinite(x) && x > 0;
  const goodPct = (x: number) => Number.isFinite(x) && x >= 0 && x < 100;
  const goodFee = (x: number) => Number.isFinite(x) && x >= 0 && x < 1;
  if (!goodPrice(path.marketEntryPrice) || !goodPrice(path.marketExitPrice) ||
      !goodPct(path.adverseExcursionPct) ||
      !goodPrice(path.assumedLiquidationDistancePct) ||
      !goodPrice(leverage) ||
      !goodFee(friction.entryFeeRate) || !goodFee(friction.exitFeeRate) ||
      !goodPct(friction.entrySlippagePct) || !goodPct(friction.exitSlippagePct) ||
      !Number.isFinite(friction.signedFundingRate) ||
      (path.side !== 'LONG' && path.side !== 'SHORT')) {
    throw new Error('Invalid price path, friction or liquidation scenario input');
  }
  const direction = path.side === 'LONG' ? 1 : -1;
  const markRatio = path.marketExitPrice / path.marketEntryPrice;
  const entrySlippage = friction.entrySlippagePct / 100;
  const exitSlippage = friction.exitSlippagePct / 100;
  const entry = path.marketEntryPrice * (1 + direction * entrySlippage);
  const exit = path.marketExitPrice * (1 - direction * exitSlippage);
  if (!(entry > 0) || !(exit > 0)) {
    throw new Error('Adverse execution prices must remain positive');
  }
  // Quantity is set by entry notional / effective entry price. Exit fee
  // therefore scales with ACTUAL exit notional, not the entry notional.
  const executionRatio = exit / entry;
  const pricePnlOnMargin = leverage * direction * (markRatio - 1);
  const pricePnlAfterSlippage = leverage * direction * (executionRatio - 1);
  const slippageOnMargin = pricePnlOnMargin - pricePnlAfterSlippage;
  const feesOnMargin = leverage * (
    friction.entryFeeRate + executionRatio * friction.exitFeeRate);
  const fundingOnMargin = leverage * friction.signedFundingRate;
  const netBeforeLossCap = pricePnlAfterSlippage - feesOnMargin - fundingOnMargin;
  const scenarioAssumedLiquidation =
    path.adverseExcursionPct >= path.assumedLiquidationDistancePct ||
    netBeforeLossCap <= -1;
  // Simplifying isolated-margin assumption: capped at -100% of committed
  // margin. No guarantee of venue liquidation behavior or fee recovery.
  const netReturnOnMargin = scenarioAssumedLiquidation
    ? -1 : netBeforeLossCap;

  return {
    trade: {
      netReturnOnMargin, evidence: 'SYNTHETIC', costsIncluded: true,
    },
    pricePnlOnMargin, feesOnMargin, slippageOnMargin, fundingOnMargin,
    netBeforeLossCap, scenarioAssumedLiquidation,
    executionAuthorized: false,
  };
}

export interface VolatilityObservation extends CompletedMarginTrade {
  // (ATR / current price) * 100, measured before the entry. No look-ahead.
  preEntryAtrPct: number;
}

export interface VolatilityResearchConfig {
  minMarginPct: number;
  maxMarginPct: number;
  referenceAtrPct: number;
  referenceAllocationPct: number;
}

export interface VolatilityResult extends SizingSimulation {
  allocationPcts: number[];
  executionAuthorized: false;
}

/**
 * C: explicit hypothetical 0-2% equity-margin budget, adjusted inversely
 * with observed ATR%. The 2% is a STRESS SCENARIO cap, NOT an optimal value.
 * Underlying notional can still reach 200% of equity at 100X.
 */
export function simulateVolatilityAllocation(
  initialEquityUsd: number,
  trades: readonly VolatilityObservation[],
  config: VolatilityResearchConfig,
): VolatilityResult {
  if (!validPositive(initialEquityUsd) ||
      !validPositive(config.referenceAtrPct) ||
      !validPositive(config.referenceAllocationPct) ||
      !validPositive(config.minMarginPct) ||
      !validPositive(config.maxMarginPct) ||
      config.minMarginPct > config.referenceAllocationPct ||
      config.referenceAllocationPct > config.maxMarginPct ||
      config.maxMarginPct > 2) {
    throw new Error('Volatility research requires explicit <= 2% scenario cap');
  }

  let equity = initialEquityUsd;
  let peak = equity;
  let maxDrawdownPct = 0;
  const marginsUsd: number[] = [];
  const allocationPcts: number[] = [];
  for (const t of trades) {
    if (!validPositive(t.preEntryAtrPct) ||
        !Number.isFinite(t.netReturnOnMargin) ||
        t.netReturnOnMargin < -1 ||
        t.costsIncluded !== true ||
        (t.evidence !== 'VERIFIED' && t.evidence !== 'SYNTHETIC')) {
      throw new Error('ATR, net costs and return evidence are required');
    }
    const uncapped = config.referenceAllocationPct *
      config.referenceAtrPct / t.preEntryAtrPct;
    const pct = Math.min(config.maxMarginPct,
      Math.max(config.minMarginPct, uncapped));
    const margin = equity * pct / 100;
    marginsUsd.push(margin);
    allocationPcts.push(pct);
    equity = Math.max(0, equity + margin * t.netReturnOnMargin);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct,
      peak > 0 ? 100 * (peak - equity) / peak : 0);
  }
  return {
    endingEquityUsd: equity, netPnlUsd: equity - initialEquityUsd,
    maxDrawdownPct, completedTrades: trades.length,
    marginsUsd, allocationPcts, appliedSteps: [], skippedSteps: [],
    executionAuthorized: false,
  };
}

export interface ScenarioObservation {
  price: ObservedPricePath;
  preEntryAtrPct: number;
}

export interface BootstrapInput {
  initialEquityUsd: number;
  // B's baseline stake. B stays fixed on gains and reduces after drawdown.
  initialFixedMarginUsd: number;
  observations: readonly ScenarioObservation[];
  friction: ExplicitFriction;
  leverage: number;
  horizonTrades: number;
  paths: number;
  // Consecutive-block bootstrap (non-IID) scenario. Does not prove causality.
  blockLength: number;
  seed: number;
  volatility: VolatilityResearchConfig;
}

export interface BootstrapStats {
  medianEndingEquityUsd: number;
  fifthPercentileEndingEquityUsd: number;
  medianMaxDrawdownPct: number;
  fractionBelowHalfInitial: number;
}

export interface BootstrapResult {
  // A is historical unsafe 10%-of-equity benchmark only.
  tenPercentBenchmark: BootstrapStats;
  fixedThenDrawdownReduced: BootstrapStats;
  volatilityScaled: BootstrapStats;
  simulatedPaths: number;
  sampleObservations: number;
  executionAuthorized: false;
}

function quantile(sorted: number[], q: number): number {
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] * (1 - (index - low)) +
    sorted[high] * (index - low);
}

function statsOf(values: SizingSimulation[], initial: number): BootstrapStats {
  const ends = values.map(v => v.endingEquityUsd).sort((a, b) => a - b);
  const drawdowns = values.map(v => v.maxDrawdownPct).sort((a, b) => a - b);
  return {
    medianEndingEquityUsd: quantile(ends, .5),
    fifthPercentileEndingEquityUsd: quantile(ends, .05),
    medianMaxDrawdownPct: quantile(drawdowns, .5),
    fractionBelowHalfInitial: ends.filter(n => n < initial / 2).length / ends.length,
  };
}

/**
 * Paired bootstraps: all three policies see the EXACT same sampled sequence.
 * Returns distribution of invented paths given the INPUT sample; it is NOT a
 * predictive ruin probability, confidence interval, or LIVE sizing approval.
 */
export function bootstrapMarginScenarios(i: BootstrapInput): BootstrapResult {
  if (!Number.isInteger(i.seed) || !Number.isInteger(i.paths) ||
      i.paths < 1 || i.paths > 2000 ||
      !Number.isInteger(i.horizonTrades) || i.horizonTrades < 1 ||
      i.horizonTrades > 2000 || i.horizonTrades * i.paths > 250000 ||
      !Number.isInteger(i.blockLength) || i.blockLength < 1 ||
      i.blockLength > i.observations.length || i.observations.length < 2 ||
      !validPositive(i.initialEquityUsd) ||
      !validPositive(i.initialFixedMarginUsd) ||
      i.initialFixedMarginUsd > i.initialEquityUsd * .02 + 1e-9) {
    throw new Error('Invalid bounded offline-bootstrap parameters');
  }
  // Validate all observations, rather than trusting sampling to eventually
  // touch a faulty / future-leaking input.
  const costed = i.observations.map(o => ({
    ...estimateCostedMarginTrade(o.price, i.friction, i.leverage),
    atr: o.preEntryAtrPct,
  }));
  if (costed.some(o => !validPositive(o.atr))) {
    throw new Error('Missing pre-entry volatility observation');
  }

  let randomState = i.seed >>> 0;
  const nextRandom = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  const A: SizingSimulation[] = [];
  const B: SizingSimulation[] = [];
  const C: SizingSimulation[] = [];
  const criteria: ReviewCriteria = {
    minClosedTrades: i.horizonTrades + 1, maxDrawdownPct: 0,
    maxStepIncreasePct: 1,
  };
  for (let n = 0; n < i.paths; n++) {
    const draws: typeof costed = [];
    while (draws.length < i.horizonTrades) {
      const start = Math.floor(nextRandom() * costed.length);
      for (let j = 0; j < i.blockLength && draws.length < i.horizonTrades; j++) {
        draws.push(costed[(start + j) % costed.length]);
      }
    }
    const trades = draws.map(o => o.trade);
    const paired = compareMarginAllocationScenarios({
      initialEquityUsd: i.initialEquityUsd,
      initialMarginUsd: i.initialFixedMarginUsd,
      trades, review: criteria, steps: [],
    });
    const vol = simulateVolatilityAllocation(i.initialEquityUsd,
      draws.map(o => ({ ...o.trade, preEntryAtrPct: o.atr })), i.volatility);
    A.push(paired.tenPercentOfEquity);
    B.push(paired.fixedThenReviewedStep);
    C.push(vol);
  }
  return {
    tenPercentBenchmark: statsOf(A, i.initialEquityUsd),
    fixedThenDrawdownReduced: statsOf(B, i.initialEquityUsd),
    volatilityScaled: statsOf(C, i.initialEquityUsd),
    simulatedPaths: i.paths, sampleObservations: i.observations.length,
    executionAuthorized: false,
  };
}
