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

    // Lower the fixed stake in a drawdown; never raise it automatically.
    // Equity-only model: excludes mark-to-market, slippage/market impact and
    // simultaneous positions; these need separate execution-path validation.
    const riskCeiling = equity * 0.1;
    const requested = mode === 'TEN_PERCENT'
      ? riskCeiling
      : baseMargin * Math.min(1, equity / i.initialEquityUsd);
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
