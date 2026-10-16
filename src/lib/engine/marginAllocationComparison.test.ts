// Isolated research tests: synthetic outcomes never authorize live/testnet size.
import { test, eq, assert, close } from '../../test/harness';
import {
  compareMarginAllocationScenarios, estimateCostedMarginTrade,
  simulateVolatilityAllocation, bootstrapMarginScenarios,
  type CompletedMarginTrade, type ExplicitFriction,
  type ObservedPricePath,
} from './marginAllocationComparison';

// Research thresholds, NOT statistical significance or automatic approval.
const criteria = { minClosedTrades: 100, maxDrawdownPct: 10, maxStepIncreasePct: 10 };
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

  test('positive 100-trade sample + approved review allows one 10% hypothetical step', () => {
    const v = scenario(verified(102, 0.1), [{
      afterClosedTrades: 100, newBaseMarginUsd: 110, explicitlyApproved: true,
    }]);
    eq(v.fixedThenReviewedStep.appliedSteps.length, 1);
    eq(v.fixedThenReviewedStep.appliedSteps[0], 100);
    close(v.fixedThenReviewedStep.marginsUsd[99], 100);
    close(v.fixedThenReviewedStep.marginsUsd[100], 110);
    close(v.fixedThenReviewedStep.endingEquityUsd, 2022);
    eq(v.executionAuthorized, false);
  });

  test('synthetic outcomes cannot authorize size increase even after 100 profitable closes', () => {
    const trades = verified(102, 0.1);
    trades[4] = { ...trades[4], evidence: 'SYNTHETIC' };
    const v = scenario(trades, [{
      afterClosedTrades: 100, newBaseMarginUsd: 110, explicitlyApproved: true,
    }]);
    eq(v.fixedThenReviewedStep.appliedSteps.length, 0);
    eq(v.fixedThenReviewedStep.skippedSteps[0], 100);
    eq(v.fixedThenReviewedStep.marginsUsd[100], 100);
    assert(!v.finalReview.eligibleForHumanReview);
  });

  test('high historical drawdown blocks step-up despite eventual net profit', () => {
    const trades = [...verified(2, -1), ...verified(100, 0.2)];
    const v = scenario(trades, [{
      afterClosedTrades: 100, newBaseMarginUsd: 110, explicitlyApproved: true,
    }]);
    assert(v.fixedThenReviewedStep.maxDrawdownPct > 10);
    eq(v.fixedThenReviewedStep.appliedSteps.length, 0);
    assert(!v.finalReview.eligibleForHumanReview);
  });

  test('approval is never inferred from stats; unapproved step and oversized jump stay blocked', () => {
    const trades = verified(32, 0.1);
    const noApproval = scenario(trades, [{
      afterClosedTrades: 100, newBaseMarginUsd: 110, explicitlyApproved: false,
    }]);
    eq(noApproval.fixedThenReviewedStep.appliedSteps.length, 0);
    const hugeJump = scenario(trades, [{
      afterClosedTrades: 100, newBaseMarginUsd: 1000, explicitlyApproved: true,
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

  // ── Independent risk research: all cost and ATR observations are fake. ──
  // 0.05% / leg matches a hypothetical un-discounted taker fee, not a constant
  // hardcoded in the order executor or an assertion of the user's actual tier.
  const fee = (over: Partial<ExplicitFriction> = {}): ExplicitFriction => ({
    entryFeeRate: .0005, exitFeeRate: .0005,
    entrySlippagePct: 0, exitSlippagePct: 0,
    signedFundingRate: 0, ...over,
  });
  const flatLong = (over: Partial<ObservedPricePath> = {}): ObservedPricePath => ({
    side: 'LONG', marketEntryPrice: 100, marketExitPrice: 100,
    adverseExcursionPct: 0, assumedLiquidationDistancePct: .6, ...over,
  });

  test('100X two taker legs at .05% each cost 10% of starting margin, NOT .04% roundtrip', () => {
    const x = estimateCostedMarginTrade(flatLong(), fee(), 100);
    close(x.feesOnMargin, .1);
    close(x.trade.netReturnOnMargin, -.1);
    eq(x.trade.evidence, 'SYNTHETIC');
    eq(x.executionAuthorized, false);
  });

  test('100X slippage .05% both legs + signed funding .01% charge correct notional', () => {
    const x = estimateCostedMarginTrade(flatLong(), fee({
      entrySlippagePct: .05, exitSlippagePct: .05,
      signedFundingRate: .0001,
    }), 100);
    close(x.fundingOnMargin, .01);
    assert(x.slippageOnMargin > .09 && x.slippageOnMargin < .11);
    assert(x.feesOnMargin > .09 && x.feesOnMargin < .11);
    assert(x.trade.netReturnOnMargin < -.19 && x.trade.netReturnOnMargin > -.23);
  });

  test('LONG and SHORT use side-aware adverse execution rather than free upside', () => {
    const long = estimateCostedMarginTrade(flatLong(), fee({
      entryFeeRate: 0, exitFeeRate: 0, entrySlippagePct: .1, exitSlippagePct: .1,
    }), 100);
    const short = estimateCostedMarginTrade(flatLong({ side: 'SHORT' }), fee({
      entryFeeRate: 0, exitFeeRate: 0, entrySlippagePct: .1, exitSlippagePct: .1,
    }), 100);
    assert(long.trade.netReturnOnMargin < 0);
    assert(short.trade.netReturnOnMargin < 0);
    assert(long.slippageOnMargin > 0 && short.slippageOnMargin > 0);
  });

  test('mark-price adverse excursion may liquidate BEFORE profitable final close', () => {
    const v = estimateCostedMarginTrade(flatLong({
      marketExitPrice: 102, adverseExcursionPct: .7,
      assumedLiquidationDistancePct: .6,
    }), fee(), 100);
    assert(v.netBeforeLossCap > 0, 'The ending price scenario should otherwise win');
    eq(v.scenarioAssumedLiquidation, true);
    eq(v.trade.netReturnOnMargin, -1);
    eq(v.executionAuthorized, false);
  });

  test('unknown costs and missing intratrade excursion never become zero', () => {
    for (const [p, f] of [
      [flatLong({ adverseExcursionPct: NaN }), fee()],
      [flatLong(), fee({ signedFundingRate: NaN })],
      [flatLong(), fee({ entrySlippagePct: -0.1 })],
    ] as Array<[ObservedPricePath, ExplicitFriction]>) {
      let refused = false;
      try { estimateCostedMarginTrade(p, f, 100); } catch { refused = true; }
      assert(refused, 'Missing market/rate evidence was guessed');
    }
  });

  test('C: inverse ATR adjusts capped margin percent .5%-2% and never triggers orders', () => {
    const observations = [
      { ...verified(1, -.2)[0], preEntryAtrPct: .25 },
      { ...verified(1, -.2)[0], preEntryAtrPct: 5 },
      { ...verified(1, -.2)[0], preEntryAtrPct: 1 },
    ];
    const result = simulateVolatilityAllocation(1000, observations, {
      minMarginPct: .5, maxMarginPct: 2,
      referenceAtrPct: 1, referenceAllocationPct: 1,
    });
    close(result.allocationPcts[0], 2);
    close(result.allocationPcts[1], .5);
    close(result.allocationPcts[2], 1);
    close(result.marginsUsd[0], 20);
    assert(result.marginsUsd[1] < 5, 'Loss should reduce dollar exposure');
    eq(result.executionAuthorized, false);
  });

  test('C: missing pre-entry ATR and >2% maximum research budget are rejected', () => {
    let rejectedMissing = false;
    try { simulateVolatilityAllocation(1000, [{
      ...verified(1, 0)[0], preEntryAtrPct: NaN,
    }], { minMarginPct: .5, maxMarginPct: 2,
      referenceAtrPct: 1, referenceAllocationPct: 1 }); }
    catch { rejectedMissing = true; }
    assert(rejectedMissing);
    let rejectedCap = false;
    try { simulateVolatilityAllocation(1000, [{
      ...verified(1, 0)[0], preEntryAtrPct: 1,
    }], { minMarginPct: .5, maxMarginPct: 10,
      referenceAtrPct: 1, referenceAllocationPct: 1 }); }
    catch { rejectedCap = true; }
    assert(rejectedCap);
  });

  const mcScenario = () => ({
    initialEquityUsd: 1000, initialFixedMarginUsd: 10,
    observations: Array.from({ length: 12 }, (_, n) => ({
      price: flatLong({
        marketExitPrice: n % 4 === 0 ? 100.1 : 99.9,
        adverseExcursionPct: n % 7 === 0 ? .65 : .1,
      }),
      preEntryAtrPct: n % 3 === 0 ? .5 : 2,
    })),
    friction: fee(), leverage: 100, paths: 60, horizonTrades: 30,
    blockLength: 3, seed: 20261016,
    volatility: { minMarginPct: .5, maxMarginPct: 2,
      referenceAtrPct: 1, referenceAllocationPct: 1 },
  });

  test('paired block bootstrap is seed-deterministic and cost-aware for A/B/C', () => {
    const first = bootstrapMarginScenarios(mcScenario());
    const second = bootstrapMarginScenarios(mcScenario());
    eq(JSON.stringify(first), JSON.stringify(second));
    eq(first.executionAuthorized, false);
    eq(first.simulatedPaths, 60);
    eq(first.sampleObservations, 12);
    assert(first.tenPercentBenchmark.medianEndingEquityUsd <
      first.fixedThenDrawdownReduced.medianEndingEquityUsd,
      'Identical losing sequences should punish a 10% margin stake more');
    for (const stat of [first.tenPercentBenchmark,
      first.fixedThenDrawdownReduced, first.volatilityScaled]) {
      assert(stat.fractionBelowHalfInitial >= 0 &&
        stat.fractionBelowHalfInitial <= 1);
      assert(Number.isFinite(stat.fifthPercentileEndingEquityUsd));
    }
  });

  test('bootstrap requires scenario evidence and bounded computation', () => {
    const source = mcScenario();
    const cases = [
      { ...source, observations: [] },
      { ...source, initialFixedMarginUsd: 100 },
      { ...source, paths: 100000 },
      { ...source, blockLength: 20 },
      { ...source, friction: fee({ exitFeeRate: NaN }) },
    ];
    for (const v of cases) {
      let rejected = false;
      try { bootstrapMarginScenarios(v); } catch { rejected = true; }
      assert(rejected, 'Unsafe scenario inputs should fail before replay');
    }
  });
}
