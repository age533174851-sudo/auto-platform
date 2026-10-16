// Isolated research tests: synthetic outcomes never authorize live/testnet size.
import { test, eq, assert, close } from '../../test/harness';
import { compareMarginAllocationScenarios, type CompletedMarginTrade } from './marginAllocationComparison';

const criteria = { minClosedTrades: 30, maxDrawdownPct: 10, maxStepIncreasePct: 25 };
const verified = (count: number, roi: number): CompletedMarginTrade[] =>
  Array.from({ length: count }, () => ({
    netReturnOnMargin: roi, evidence: 'VERIFIED' as const, costsIncluded: true,
  }));
const scenario = (trades: CompletedMarginTrade[], steps: {
  afterClosedTrades: number; newBaseMarginUsd: number; explicitlyApproved: boolean
}[] = []) => compareMarginAllocationScenarios({
  initialEquityUsd: 1000,
  initialMarginUsd: 100,
  trades, review: criteria, steps,
});

export function runMarginAllocationComparisonTests() {
  test('research-only: no execution authority, no implicit steps', () => {
    const v = scenario(verified(4, 0.2));
    eq(v.executionAuthorized, false);
    eq(v.fixedThenReviewedStep.appliedSteps.length, 0);
    eq(v.tenPercentOfEquity.appliedSteps.length, 0);
    eq(v.fixedThenReviewedStep.marginsUsd[0], 100);
    eq(v.fixedThenReviewedStep.marginsUsd[1], 100);
    eq(v.fixedThenReviewedStep.marginsUsd[3], 100);
    assert(!v.finalReview.eligibleForHumanReview, 'Four trades cannot approve a scale-up');
  });

  test('100% return on margin is not multiplied by 100X a second time', () => {
    const v = scenario(verified(1, 1));
    eq(v.tenPercentOfEquity.endingEquityUsd, 1100);
    eq(v.fixedThenReviewedStep.endingEquityUsd, 1100);
  });

  test('compounding grows each trade, fixed stake does not grow without review', () => {
    const v = scenario(verified(2, 1));
    close(v.tenPercentOfEquity.marginsUsd[1], 110);
    eq(v.fixedThenReviewedStep.marginsUsd[1], 100);
    close(v.tenPercentOfEquity.endingEquityUsd, 1210);
    close(v.fixedThenReviewedStep.endingEquityUsd, 1200);
  });

  test('fixed model scales down from PEAK after a loss even if still above original capital', () => {
    const trades: CompletedMarginTrade[] = [
      ...verified(1, 1), ...verified(1, -0.5), ...verified(1, 0),
    ];
    const v = scenario(trades);
    close(v.fixedThenReviewedStep.marginsUsd[0], 100);
    close(v.fixedThenReviewedStep.marginsUsd[1], 100);
    close(v.fixedThenReviewedStep.marginsUsd[2], 100 * (1050 / 1100));
    close(v.tenPercentOfEquity.marginsUsd[2], 104.5); // A: 1100 - (110 * 0.5) = 1045
  });

  test('fixed model also reduces margin on drawdown; never breaches 10% of equity', () => {
    const v = scenario(verified(10, -1));
    close(v.tenPercentOfEquity.endingEquityUsd, 1000 * Math.pow(0.9, 10));
    close(v.fixedThenReviewedStep.endingEquityUsd, 1000 * Math.pow(0.9, 10));
    close(v.fixedThenReviewedStep.marginsUsd[1], 90);
    for (let n = 0; n < 10; n++) {
      close(v.fixedThenReviewedStep.marginsUsd[n],
        100 * Math.pow(0.9, n), 1e-7);
    }
  });

  test('positive verified 30-trade sample + approved review allows one 25% hypothetical step', () => {
    const v = scenario(verified(32, 0.1), [{
      afterClosedTrades: 30, newBaseMarginUsd: 125, explicitlyApproved: true,
    }]);
    eq(v.fixedThenReviewedStep.appliedSteps.length, 1);
    eq(v.fixedThenReviewedStep.appliedSteps[0], 30);
    close(v.fixedThenReviewedStep.marginsUsd[29], 100);
    close(v.fixedThenReviewedStep.marginsUsd[30], 125);
    close(v.fixedThenReviewedStep.endingEquityUsd, 1325);
    eq(v.executionAuthorized, false);
  });

  test('synthetic outcomes cannot authorize size increase even after 30 profitable closes', () => {
    const trades = verified(32, 0.1);
    trades[4] = { ...trades[4], evidence: 'SYNTHETIC' };
    const v = scenario(trades, [{
      afterClosedTrades: 30, newBaseMarginUsd: 125, explicitlyApproved: true,
    }]);
    eq(v.fixedThenReviewedStep.appliedSteps.length, 0);
    eq(v.fixedThenReviewedStep.skippedSteps[0], 30);
    eq(v.fixedThenReviewedStep.marginsUsd[30], 100);
    assert(!v.finalReview.eligibleForHumanReview);
  });

  test('high historical drawdown blocks step-up despite eventual net profit', () => {
    const trades = [...verified(2, -1), ...verified(30, 0.2)];
    const v = scenario(trades, [{
      afterClosedTrades: 30, newBaseMarginUsd: 125, explicitlyApproved: true,
    }]);
    assert(v.fixedThenReviewedStep.maxDrawdownPct > 10);
    eq(v.fixedThenReviewedStep.appliedSteps.length, 0);
    assert(!v.finalReview.eligibleForHumanReview);
  });

  test('approval is never inferred from stats; unapproved step and oversized jump stay blocked', () => {
    const trades = verified(32, 0.1);
    const noApproval = scenario(trades, [{
      afterClosedTrades: 30, newBaseMarginUsd: 125, explicitlyApproved: false,
    }]);
    eq(noApproval.fixedThenReviewedStep.appliedSteps.length, 0);
    const hugeJump = scenario(trades, [{
      afterClosedTrades: 30, newBaseMarginUsd: 1000, explicitlyApproved: true,
    }]);
    eq(hugeJump.fixedThenReviewedStep.appliedSteps.length, 0);
  });

  test('gross returns without verified costs or excessive margin are refused', () => {
    let refusedCosts = false;
    try { scenario([{ ...verified(1, 0.2)[0], costsIncluded: false }]); }
    catch { refusedCosts = true; }
    assert(refusedCosts);
    let refusedOverAllocation = false;
    try { compareMarginAllocationScenarios({
      initialEquityUsd: 1000, initialMarginUsd: 250,
      trades: verified(1, 0.2), review: criteria,
    }); } catch { refusedOverAllocation = true; }
    assert(refusedOverAllocation);
  });

  test('loss below -100% of isolated margin is outside this simple replay model', () => {
    let refused = false;
    try { scenario(verified(1, -1.01)); } catch { refused = true; }
    assert(refused);
  });
}
