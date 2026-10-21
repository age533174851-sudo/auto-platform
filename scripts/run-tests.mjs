#!/usr/bin/env node
// TRAIGO 코어 유닛 테스트 러너 (외부 프레임워크 없이 tsc 컴파일 후 실행)
// 사용: node scripts/run-tests.mjs  (또는 npm test)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'traigo-test-'));
cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });

const RUN_SRC = `
// ── \`@/\` 런타임 해석 ──
//
//   이 러너는 CommonJS로 컴파일해 Node로 바로 돌린다. tsc의 경로 별칭은
//   **컴파일 시점만**이라 \`require('@/lib/...')\`는 런타임에 해석되지
//   않는다. 그래서 \`await import('@/...')\`를 쓰는 실행기·라우트는
//   유닛 시험에 **올릴 수 없었고**, 그 경로의 DB 쓰기는 정적 검사기
//   한 겹에만 의존했다. 그 공백이 이 shim이 메우려는 것이다.
//
//   별칭을 해석기 수준에서 바꿔 두면, 실행기가 실제로 거래소 어댑터를
//   불러오고 실제로 장부에 쓴다 — 통합 시험이 가능해진다.
const __mod = require('module');
const __path = require('path');
const __origResolve = __mod._resolveFilename;
__mod._resolveFilename = function (request, ...rest) {
  // 라우트 핸들러가 쓰는 Next 응답 래퍼. 임시 디렉터리에 node_modules가
  // 없어서 이 한 겹만 스텁으로 바꾼다.
  if (request === 'next/server') {
    return __path.join(__dirname, '__next_server_stub.js');
  }
  if (typeof request === 'string' && request.startsWith('@/')) {
    // tsconfig의 별칭은 \`@/* → ./src/*\`다. 러너는 \`src\`를 임시
    // 폴더로 복사하므로 \`<tmp>/src/...\`가 실제 자리다.
    request = __path.join(__dirname, 'src', request.slice(2));
  }
  return __origResolve.call(this, request, ...rest);
};

import { runCalendarVetoEvidenceTests } from './src/lib/calendar/econCalendar.vetoEvidence.test';
import { runPnlTests } from './src/lib/pnl/pnl.test';
import { runBacktestTests } from './src/lib/backtest/engine.test';
import { runRiskManagerTests } from './src/lib/engine/riskManager.test';
import { runExitPlanTests } from './src/lib/engine/exitPlan.test';
import { runPaperDispatchTests } from './src/lib/engine/paperDispatch.test';
import { runPaperOpenAtomicTests } from './src/lib/engine/paperOpenAtomic.test';
import { runPaperEventTimeTests } from './src/lib/engine/paperEventTime.test';
import { runPaperChallengeSweepTests } from './src/lib/engine/paperChallengeSweep.test';
import { runPaperCapacityTests } from './src/lib/engine/paperCapacity.test';
import { runPaperSpotHoldingsTests } from './src/lib/engine/paperSpotHoldings.test';
import { runInventoryTests } from './src/lib/ui/inventory.test';
import { runPracticeEnvTests } from './src/lib/autotrade/practiceEnv.test';
import { runDisplayTests } from './src/lib/ui/display.test';
import { runStatusTests } from './src/lib/ui/status.test';
import { runPaperExitSweepTests, runPaperExitSweepMoreTests } from './src/lib/engine/paperExitSweep.test';
import { runExitMonitorTests } from './src/lib/engine/exitMonitor.test';
import { runExitMonitorScheduleTests } from './src/lib/engine/exitMonitorSchedule.test';
import { runScheduledExitRunnerTests } from './src/lib/engine/scheduledExitRunner.test';
import { runExitMonitorLeaseTests } from './src/lib/engine/exitMonitorLease.test';
import { runOpsCommandTests } from './src/lib/ops/opsCommand.test';
import { runOpsQueueTests } from './src/lib/ops/opsQueue.test';
import { runSelfHealTests } from './src/lib/ops/selfHeal.test';
import { runOpsViewTests } from './src/lib/ui/opsView.test';
import { runAutoVerifyTests } from './src/lib/ops/autoVerify.test';
import { runSecretSyncTests } from './src/lib/ops/secretSync.test';
import { runWorkerAliveTests } from './src/lib/ops/workerAlive.test';
import { runQuotaBreakerTests } from './src/lib/supabase/quotaBreaker.test';
import { runDailyForcedEntryTests } from './src/lib/strategies/dailyForcedEntry.test';
import { runHeartbeatVerifyTests } from './src/lib/runtime/heartbeatVerify.test';
import { runVercelEnvTests } from './src/lib/ops/vercelEnv.test';
import { runSecretParityTests } from './src/lib/ops/secretParity.test';
import { runRecoveryCenterTests } from './src/lib/ops/recoveryCenter.test';
import { runLeverageMathTests } from './src/lib/engine/leverageMath.test';
import { runLiveTradingGateTests } from './src/lib/engine/liveTradingGate.test';
import { runLadderGateTests } from './src/lib/strategies/ladderGate.test';
import { runStrategyRegistryTests } from './src/lib/strategies/registry.test';
import { runCheckFlagTests } from './src/lib/strategies/checkFlag.test';
import { runOriginalV1Tests } from './src/lib/strategies/originalV1.test';
import { runCloseEvidenceTests } from './src/lib/engine/closeEvidence.test';
import { runPositionLifecycleTests } from './src/lib/engine/positionLifecycle.test';
import { runFlatCleanupTests } from './src/lib/engine/flatCleanup.test';
import { runOrphanSweepTests } from './src/lib/engine/orphanSweep.test';
import { runStrategyConflictGateTests } from './src/lib/engine/strategyConflictGate.test';
import { runProtectionLedgerTests } from './src/lib/engine/protectionLedger.test';
import { runTradeIdentityTests } from './src/lib/strategies/tradeIdentity.test';
import { runEdgeTypesTests } from './src/lib/strategies/edgeTypes.test';
import { runLedgerEventTests } from './src/lib/ledger/ledgerEvent.test';
import { runIncomeIngestTests } from './src/lib/ledger/incomeIngest.test';
import { runIngestPipelineTests } from './src/lib/ledger/ingestPipeline.test';
import { runAutoRuntimeViewTests } from './src/lib/engine/autoRuntimeView.test';
import { runFingerprintTests } from './src/lib/system/fingerprint.test';
import { runServerFetchTests } from './src/lib/supabase/serverFetch.test';
import { runMigrationPlanTests } from './src/lib/system/migrationPlan.test';
import { runPaperScopeTests } from './src/lib/engine/paperScope.test';
import { runMigrationAdoptionTests } from './src/lib/system/migrationAdoption.test';
import { runPaperChallengeTests } from './src/lib/engine/paperChallenge.test';
import { runPaperChallengeScopeTests } from './src/lib/engine/paperChallengeScope.test';
import { runPaperPriceSourceTests } from './src/lib/engine/paperPriceSource.test';
import { runPaperTargetTests } from './src/lib/trading/paperTarget.test';
import { runPaperCapabilityTests } from './src/lib/trading/capability.test';
import { runLegacyLedgerTests } from './src/lib/trading/legacyLedger.test';
import { runOrderBookTests } from './src/lib/trading/orderBook.test';
import { runChallengeDisplayTests } from './src/lib/trading/challengeDisplay.test';
import { runPositionSizingTests } from './src/lib/trading/positionSizing.test';
import { runTradeContextTests } from './src/lib/trading/tradeContext.test';
import { runProductRegistryTests } from './src/lib/products/registry.test';
import { runVenueSpecTests } from './src/lib/markets/venueSpec.test';
import { runSpotPrecisionTests } from './src/lib/exchanges/spotPrecision.test';
import { runSellPlanTests } from './src/lib/trading/sellPlan.test';
import { runGameMoneyTests } from './src/lib/trading/gameMoney.test';
import { runCandleSeriesTests } from './src/lib/trading/candleSeries.test';
import { runStreamEndpointTests } from './src/lib/trading/streamEndpoints.test';
import { runMarketStatsTests } from './src/lib/trading/marketStats.test';
import { runPaperAvailableTests } from './src/lib/engine/paperAvailable.test';
import { runStopPresetTests } from './src/lib/trading/stopPresets.test';
import { runChartLoadStateTests } from './src/lib/trading/chartLoadState.test';
import { runSubmitGateTests } from './src/lib/trading/submitGate.test';
import { runTradeIntentTests } from './src/lib/trading/tradeIntent.test';
import { runPositionScopeTests } from './src/lib/trading/positionScope.test';
import { runMarketDataContractTests } from './src/lib/markets/marketDataContract.test';
import { runRankingTests } from './src/lib/markets/ranking.test';
import { runInstrumentFieldTests } from './src/lib/markets/instrumentFields.test';
import { runInstrumentRouteTests } from './src/lib/markets/instrumentRoute.test';
import { runMarketInstrumentTests } from './src/lib/trading/marketInstrument.test';
import { runSizeInputTests } from './src/lib/trading/sizeInput.test';
import { runCtaVerdictTests } from './src/lib/trading/ctaVerdict.test';
import { runPaperOrderReviewTests } from './src/lib/trading/paperOrderReview.test';
import { runPaperCloseReviewTests } from './src/lib/trading/paperCloseReview.test';
import { runIndicatorsTests } from './src/lib/trading/indicators.test';
import { runPaperChallengeApiTests } from './src/lib/engine/paperChallengeApi.test';
import { runPaperDepositTests } from './src/lib/engine/paperDeposit.test';
import { runMigrationStatusTests } from './src/lib/system/migrationStatus.test';
import { runWalletTruthTests } from './src/lib/portfolio/walletTruth.test';
import { runWalletTruthViewTests } from './src/lib/portfolio/walletTruthView.test';
import { runSmokePlanTests } from './src/lib/smoke/smokePlan.test';
import { runSmokeRunTests } from './src/lib/smoke/smokeRun.test';
import { runCancelRunTests } from './src/lib/smoke/cancelRun.test';
import { runExitPolicyTests } from './src/lib/strategies/exitPolicy.test';
import { runRunRequestTests } from './src/lib/strategies/runRequest.test';
import { runScalpSignalDiagnosisTests } from './src/lib/strategies/scalpSignalDiagnosis.test';
import { runRunStrategyDiagnosisTests } from './src/lib/strategies/runStrategyDiagnosis.test';
import { runExcursionTests } from './src/lib/backtest/excursion.test';
import { runPositionGuardTests } from './src/lib/engine/positionGuard.test';
import { runStateReconcileTests } from './src/lib/engine/stateReconcile.test';
import { runOrderLifecycleTests } from './src/lib/engine/orderLifecycle.test';
import { runUnknownResolverTests } from './src/lib/engine/unknownResolver.test';
import { runDataQualityTests } from './src/lib/engine/dataQuality.test';
import { runOperatingModeTests } from './src/lib/engine/operatingMode.test';
import { runEntry100xTests } from './src/lib/engine/entry100x.test';
import { runMaxOpenPositionsGateTests } from './src/lib/engine/maxOpenPositionsGate.test';
import { runOrderFillFactsTests } from './src/lib/engine/orderFillFacts.test';
import { runLedgerFillQtyTests } from './src/lib/engine/ledgerFillQty.test';
import {
  runReconcileLedgerStatusTests, runHoldingEvidenceTests, runFoundOrderLedgerTests,
  runProvenFillTests, runOtherVenueLedgerTests, runCoinMFillTests,
} from './src/lib/engine/reconcileLedgerStatus.test';
import { runCredentialExposureTests } from './src/lib/security/credentialExposure.test';
import {
  runOrderPathIntegrationTests, runReconcileIntegrationTests, runSpotIntegrationTests,
  runCloseIntegrationTests, runTransitionIntegrationTests, runCoinMRouteIntegrationTests,
  runGateExecIntegrationTests, runGateDupIntegrationTests, runNoFixedTpIntegrationTests,
  runPrecisionIntegrationTests,
  runPrecisionMatrixTests,
} from './src/test/integration/orderPathIntegration.test';
import { runSmokeStartRouteTests } from './src/test/integration/smokeStartRouteIntegration.test';
import { runForcedEntryRouteTests } from './src/test/integration/forcedEntryRouteIntegration.test';
import { runHoldExtensionIntegrationTests } from './src/test/integration/holdExtensionIntegration.test';
import { runFailureRecoveryTests } from './src/lib/engine/failureRecovery.test';
import { runMarketTypeTests } from './src/lib/markets/marketType.test';
import { runWalletTests } from './src/lib/markets/wallets.test';
import { runCoinMTests } from './src/lib/markets/coinM.test';
import { runCostBasisTests } from './src/lib/markets/costBasis.test';
import { runLedgerTests } from './src/lib/strategies/ledger.test';
import { runSpotStrategyTests } from './src/lib/strategies/spotStrategies.test';
import { runSpotOrderPlanTests } from './src/lib/strategies/spotOrderPlan.test';
import { runCombinedTests } from './src/lib/strategies/combined.test';
import { runBinanceHostTests } from './src/lib/exchanges/binanceHosts.test';
import { runAuthErrorTests } from './src/lib/exchanges/authError.test';
import { runErrorTextTests } from './src/lib/http/errorText.test';
import { runAutotradeHealthTests } from './src/lib/engine/autotradeHealth.test';
import { runOverlayStackTests } from './src/lib/nav/overlayStack.test';
import { runThemeTests } from './src/lib/theme/theme.test';
import { runPositionViewTests } from './src/lib/markets/positionView.test';
import { runOrderViewTests } from './src/lib/markets/orderView.test';
import { runNewsSchemaTests } from './src/lib/news/schema.test';
import { runAnalyzeOneTests } from './src/lib/news/analyzeOne.test';
import { runCollectTests } from './src/lib/news/collect.test';
import { runEnrichPlanTests } from './src/lib/news/enrichPlan.test';
import { runConsensusTests } from './src/lib/news/consensus.test';
import { runPricingTests } from './src/lib/ai/pricing.test';
import { runCalendarTests } from './src/lib/calendar/normalize.test';
import { runRetentionTests } from './src/lib/maintenance/retention.test';
import { runAdminGateTests } from './src/lib/auth/adminGate.test';
import { runCommandTests } from './src/lib/commands/commands.test';
import { runKeymapTests } from './src/lib/commands/keymap.test';
import { runPreTradeChecklistTests } from './src/lib/engine/preTradeChecklist.test';
import { runReconcileEvidenceTests } from './src/lib/engine/reconcileEvidence.test';
import { runAutoMergeGateTests } from './src/lib/ci/autoMergeGate.test';
import { runAutoRebaseTests } from './src/lib/ci/autoRebase.test';
import { runDeployDispatchTests } from './src/lib/ci/deployDispatch.test';
import { runExecutorHealthTests } from './src/lib/jobs/executorHealth.test';
import { runManualPlanTests } from './src/lib/engine/manualPlan.test';
import { runPairTests } from './src/lib/markets/pair.test';
import { runTpslPlanTests } from './src/lib/exchanges/tpslPlan.test';
import { runPreferencesTests } from './src/lib/ui/preferences.test';
import { runPanelPrefsTests } from './src/lib/ui/panelPrefs.test';
import { runGlobalStopTests } from './src/lib/autotrade/globalStop.test';
import { runNewsFeedTests } from './src/lib/news/feed.test';
import { runRichTextTests } from './src/lib/ui/richText.test';
import { runTokensTests } from './src/lib/ui/tokens.test';
import { runTradingLayoutTests } from './src/lib/ui/tradingLayout.test';
import { runAutoCockpitTests } from './src/lib/ui/autoCockpit.test';
import { runExecutionProfileTests } from './src/lib/execution/profile.test';
import { runDedicated100xTests } from './src/lib/execution/dedicated100x.test';
import { runExact100xObservationTests } from './src/test/integration/exact100xObservationIntegration.test';
import { runScalpSignalTests } from './src/lib/strategies/scalpSignal.test';
import { runRiskContextTests } from './src/lib/engine/riskContext.test';
import { runConnectionTests } from './src/lib/exchanges/connection.test';
import { runScalpRunTests } from './src/lib/strategies/scalpRun.test';
import { runProfileSimTests } from './src/lib/strategies/profileSim.test';
import { runMonteCarloTests } from './src/lib/strategies/monteCarlo.test';
import { runRoundLedgerTests } from './src/lib/strategies/roundLedger.test';
import { runIdempotencyTests } from './src/lib/risk/idempotency.test';
import { runPendingReconcileTests } from './src/lib/engine/pendingReconcile.test';
import { runAutotradeTimingTests } from './src/lib/autotrade/nextRun.test';
import { runEvaluationLoopTests } from './src/lib/autotrade/evaluationLoop.test';
import { runSchedulePollTests } from './src/lib/autotrade/schedulePoll.test';
import { runRunOutcomeTests } from './src/lib/autotrade/runOutcome.test';
import { runFirstEvalRaceTests } from './src/lib/autotrade/firstEvalRace.test';
import { runScheduleToggleTests } from './src/lib/autotrade/scheduleToggle.test';
import { runPickConnectionTests } from './src/lib/exchanges/pickConnection.test';
import { runOrderCycleTests } from './src/lib/engine/orderCycle.test';
import { runLeverageSyncTests } from './src/lib/engine/leverageSync.test';
import { runMismatchRecoveryTests } from './src/lib/engine/mismatchRecovery.test';
import { runTabGroupsTests } from './src/lib/terminal/tabGroups.test';
import { runOrderSizingTests } from './src/lib/engine/orderSizing.test';
import { runOwnerBootstrapTests } from './src/lib/auth/ownerBootstrap.test';
import { runConvictionTests } from './src/lib/risk/conviction.test';
import { runSleeveLedgerTests } from './src/lib/strategies/sleeveLedger.test';
import { runOrderIntentTests } from './src/lib/engine/orderIntent.test';
import { runProtectionRepairTests } from './src/lib/engine/protectionRepair.test';
import { runExact100xChainTests } from './src/test/integration/exact100xChainIntegration.test';
import { runPriceBasisTests } from './src/lib/markets/priceBasis.test';
import { runContextSwitchTests } from './src/lib/terminal/contextSwitch.test';
import { runMobileSheetTests } from './src/lib/ui/mobileSheet.test';
import { runSleeveStoreTests } from './src/lib/strategies/sleeveStore.test';
import { runTradingHistoryTests } from './src/lib/risk/tradingHistory.test';
import { runFillPollTests } from './src/lib/engine/fillPoll.test';
import { runOrderProgressTests } from './src/lib/engine/orderProgress.test';
import { runQuantityIntentTests } from './src/lib/ui/quantityIntent.test';
import { runOrderCurrencyTests } from './src/lib/markets/orderCurrency.test';
import { runOrderPreviewTests } from './src/lib/markets/orderPreview.test';
import { runOrderTypesTests } from './src/lib/markets/orderTypes.test';
import { runVenueQuoteTests } from './src/lib/markets/venueQuote.test';
import { runQuantityInputTests } from './src/lib/markets/quantityInput.test';
import { runCostAnalysisTests } from './src/lib/strategies/costAnalysis.test';
import { runEdgeSweepTests } from './src/lib/strategies/edgeSweep.test';
import { runAutoOverviewTests } from './src/lib/ui/autoOverview.test';
import { runStrategyCardTests } from './src/lib/ui/strategyCard.test';
import { runPortfolioReturnsTests } from './src/lib/portfolio/returns.test';
import { runAttributionTests } from './src/lib/portfolio/attribution.test';
import { runLeverageLadderTests } from './src/lib/engine/leverageLadder.test';
import { runSchedulePlanTests } from './src/lib/engine/schedulePlan.test';
import { runBacktestVerdictTests } from './src/lib/backtest/verdict.test';
import { runAiResultSourceTests } from './src/lib/ai/resultSource.test';
import { runReconcilePlanTests } from './src/lib/engine/reconcilePlan.test';
import { runPersistentRuntimeTests } from './src/lib/runtime/persistentRuntime.test';
import { runExecutionRuntimeTests } from './src/lib/runtime/executionRuntime.test';
import { runWorkerPlanTests } from './src/lib/runtime/workerPlan.test';
import { runWorkerIdentityTests } from './src/lib/runtime/workerIdentity.test';
import { runRuntimeHealthTests } from './src/lib/runtime/runtimeHealth.test';
import { runSchedulerReportTests } from './src/lib/runtime/schedulerReport.test';
import { runDataLocationTests } from './src/lib/runtime/dataLocation.test';
import { runWalletTests as runWalletScreenTests } from './src/lib/portfolio/wallet.test';
import { runStrategySyncTests } from './src/lib/strategies/syncPlan.test';
import { runKillSwitchGateTests } from './src/lib/risk/killSwitchGate.test';
import { runKillSwitchTruthTests } from './src/lib/risk/killSwitchTruth.test';
import { runKillTargetsTests } from './src/lib/risk/killTargets.test';
import { runKillClosePlanTests } from './src/lib/risk/killClosePlan.test';
import { runKillCloseRunTests } from './src/lib/risk/killCloseRun.test';
import { runKillCloseIntegrationTests } from './src/test/integration/killCloseIntegration.test';
import { runKillAlertTests } from './src/lib/risk/killAlert.test';
import { runPaperAccountTests } from './src/lib/portfolio/paperAccount.test';
import { runPaperWiringTests } from './src/lib/portfolio/paperWiring.test';
import { runPaperOrderTelemetryTests } from './src/lib/engine/paperOrderTelemetry.test';
import { runPaperUnifyTests } from './src/lib/portfolio/paperUnify.test';
import { runManagedPositionTests } from './src/lib/engine/managedPosition.test';
import { runLifecycleActionTests } from './src/lib/engine/lifecycleAction.test';
import { runMutationGuardTests } from './src/lib/engine/mutationGuard.test';
import { runEntryExitSafetyTests } from './src/lib/engine/entryExitSafety.test';
import { runLifecycleRowsTests } from './src/lib/engine/lifecycleRows.test';
import { runPostEntryRiskTests } from './src/lib/engine/postEntryRisk.test';
import { runRiskObservationStoreTests } from './src/lib/engine/riskObservationStore.test';
import { runRiskObservationEligibilityTests } from './src/lib/engine/riskObservationEligibility.test';
import { runEscapeTelemetryTests } from './src/lib/engine/escapeTelemetry.test';
import { runExitMonitorWakeTests } from './src/lib/engine/exitMonitorWake.test';
import { runMigrationLineageTests } from './src/lib/system/migrationLineage.test';
import { runObservationAclTests } from './src/lib/system/observationAcl.test';
import { runTestnetReadinessTests } from './src/lib/engine/testnetReadiness.test';
import { runTestnetDiagnoseVerdictTests } from './src/lib/engine/testnetDiagnoseVerdict.test';
import { runConnectionIdentityTests } from './src/lib/exchanges/connectionIdentity.test';
import { runPositionRiskProvenanceTests } from './src/lib/exchanges/positionRiskProvenance.test';
import { runOrderExecutorIdentityTests } from './src/lib/engine/orderExecutorIdentity.test';
import { runBracketCacheTests } from './src/lib/exchanges/bracketCache.test';
import { runExecutionCostTests } from './src/lib/engine/executionCost.test';
import { runMarketFreshnessTests } from './src/lib/engine/marketFreshness.test';
import { runExitAuthorityTests } from './src/lib/engine/exitAuthority.test';
import { runHoldExtensionTests } from './src/lib/engine/holdExtension.test';
import { runExitAuthorityRunTests } from './src/lib/engine/exitAuthorityRun.test';
import { runLiquidationDistanceTests } from './src/lib/engine/liquidationDistance.test';
import { runExitCoverageTests } from './src/lib/engine/exitCoverage.test';
import { runExitRunOutcomeTests } from './src/lib/engine/exitRunOutcome.test';
import { runExitLifecycleTests } from './src/lib/engine/exitLifecycle.test';
import { runStopMoveTests } from './src/lib/engine/stopMove.test';
import { runScheduleCancelTests } from './src/lib/autotrade/scheduleCancel.test';
import { runTradeVenueTests } from './src/lib/engine/tradeVenue.test';
import { runHighWaterTests } from './src/lib/engine/highWater.test';
import { runDeploymentCheckTests } from './src/lib/ops/deploymentCheck.test';
import { runMigrationWaitTests } from './src/lib/ops/migrationWait.test';
import { runVercelRedeployTests } from './src/lib/ops/vercelRedeploy.test';
import { runEquityCurveTests } from './src/lib/portfolio/equityCurve.test';
import { runWalletDetailTests } from './src/lib/portfolio/walletDetail.test';
import { runWalletOverviewTests } from './src/lib/portfolio/walletOverview.test';
import { runPerformanceTests } from './src/lib/portfolio/performance.test';
import { runSnapshotBucketTests } from './src/lib/portfolio/snapshotBucket.test';
import { runFxRateTests } from './src/lib/portfolio/fxRate.test';
import { runCoverageSetTests } from './src/lib/ledger/coverageSet.test';
import { runScheduleExitTests } from './src/lib/engine/scheduleExit.test';
import { runOAuthProvidersTests } from './src/lib/auth/oauthProviders.test';
import { runSignupOutcomeTests } from './src/lib/auth/signupOutcome.test';
import { runCloseQtyTests } from './src/lib/exchanges/closeQty.test';
import { runLosslessJsonTests } from './src/lib/exchanges/losslessJson.test';
import { runGatePlanTests } from './src/lib/exchanges/gatePlan.test';
import { runFuturesExecTests } from './src/lib/exchanges/futuresExec.test';
import { runPromotionMapTests } from './src/lib/auth/promotionMap.test';
import { runTradeModeTests } from './src/lib/markets/tradeMode.test';
import { runPaperPlanTests } from './src/lib/engine/paperPlan.test';
import { runDailyLossTests } from './src/lib/risk/dailyLoss.test';
import { runRegimeGateTests } from './src/lib/risk/regimeGate.test';
import { runTrailPlanTests } from './src/lib/engine/trailPlan.test';
import { runPaperRunnerTests } from './src/lib/engine/paperRunner.test';
import { runExitRulesTests } from './src/lib/engine/exitRules.test';
import { runSafetyLogTests } from './src/lib/safety/safetyLog.test';
import { runFredTests } from './src/lib/calendar/fred.test';
import { runEventGuardTests } from './src/lib/risk/eventGuard.test';
import { runAllocationTests } from './src/lib/portfolio/allocation.test';
import { runStatsTests } from './src/lib/portfolio/stats.test';
import { runRoutingTests } from './src/lib/ai/routing.test';
import { runGateSpotPlanTests } from './src/lib/exchanges/gateSpotPlan.test';
import { runLossStreakTests } from './src/lib/risk/lossStreak.test';
import { runTradeVetoTests } from './src/lib/ai/tradeVeto.test';
import { runCalibrationTests } from './src/lib/ai/calibration.test';
import { runRecordPredictionTests } from './src/lib/ai/recordPrediction.test';
import { runSubAccountTests } from './src/lib/portfolio/subAccount.test';
import { runStopVerifyTests } from './src/lib/engine/stopVerify.test';
import { runManualOverrideTests } from './src/lib/engine/manualOverride.test';
import { runWebhookAuthTests } from './src/lib/security/webhookAuth.test';
import { runShortGuardTests } from './src/lib/engine/shortGuard.test';
import { runEmergencyLevelTests } from './src/lib/risk/emergencyLevel.test';
import { runTradingCapabilityTests } from './src/lib/auth/tradingCapability.test';
import { runCheckOverrideTests } from './src/lib/engine/checkOverride.test';
import { runMarketHoursTests } from './src/lib/markets/marketHours.test';
import { runFuturesHoursTests } from './src/lib/markets/futuresHours.test';
import { runProxyAssetTests } from './src/lib/markets/proxyAsset.test';
import { runTrendTests } from './src/lib/markets/trend.test';
import { runKisCoreTests } from './src/lib/exchanges/kisCore.test';
import { runSpreadGuardTests } from './src/lib/markets/spreadGuard.test';
import { runInstrumentTests } from './src/lib/markets/instrument.test';
import { runContractSpecTests } from './src/lib/markets/contractSpec.test';
import { runQuantizeTests } from './src/lib/exchanges/quantize.test';
import { runDisplayScaleTests } from './src/lib/ui/displayScale.test';
import { runStatusReportTests } from './src/lib/system/statusReport.test';
import { runPositionParseTests } from './src/lib/signals/positionParse.test';
import { runTraderScoreTests } from './src/lib/signals/traderScore.test';
import { runConsensusSignalTests } from './src/lib/signals/consensus.test';
import { runWedomDisciplineTests } from './src/lib/strategies/wedomDiscipline.test';
import { runYoutubeLiveTests } from './src/lib/signals/youtubeLive.test';
import { runCreatorEdgeTests } from './src/lib/signals/creatorEdge.test';
import { runCreatorLedgerTests } from './src/lib/signals/creatorLedger.test';
import { runCreatorIntakeTests } from './src/lib/signals/creatorIntake.test';
import { runSignalPathTests } from './src/lib/signals/signalPath.test';
import { runVenueBarsTests } from './src/lib/markets/venueBars.test';
import { runLoginDiagnosticTests } from './src/lib/auth/loginDiagnostic.test';
import { summary, flushAsync } from './src/test/harness';
console.log('════════ TRAIGO 코어 유닛 테스트 ════════');
runCalendarVetoEvidenceTests();
runPnlTests(); runBacktestTests(); runRiskManagerTests(); runExitPlanTests(); runPaperDispatchTests(); runPaperOpenAtomicTests(); runPaperEventTimeTests(); runPaperChallengeSweepTests(); runPaperCapacityTests(); runPaperExitSweepTests(); runPaperExitSweepMoreTests(); runExcursionTests(); runPositionGuardTests(); runStateReconcileTests(); runOrderLifecycleTests(); runUnknownResolverTests(); runDataQualityTests(); runOperatingModeTests();
runEntry100xTests(); runMaxOpenPositionsGateTests(); runOrderFillFactsTests(); runLedgerFillQtyTests(); runReconcileLedgerStatusTests(); runHoldingEvidenceTests(); runFoundOrderLedgerTests(); runProvenFillTests(); runOtherVenueLedgerTests(); runCoinMFillTests(); runFailureRecoveryTests(); runCredentialExposureTests(); runMarketTypeTests(); runWalletTests(); runCoinMTests(); runCostBasisTests(); runLedgerTests(); runSpotStrategyTests(); runSpotOrderPlanTests(); runCombinedTests(); runBinanceHostTests(); runAuthErrorTests(); runErrorTextTests(); runAutotradeHealthTests(); runOverlayStackTests(); runThemeTests(); runPositionViewTests(); runDisplayTests(); runStatusTests(); runInventoryTests(); runPracticeEnvTests();
runOrderViewTests(); runNewsSchemaTests(); runAnalyzeOneTests(); runCollectTests(); runEnrichPlanTests(); runConsensusTests(); runPricingTests(); runCalendarTests(); runRetentionTests(); runAdminGateTests(); runCommandTests(); runKeymapTests(); runPreTradeChecklistTests(); runReconcileEvidenceTests(); runAutoMergeGateTests(); runAutoRebaseTests();
runDeployDispatchTests(); runExecutorHealthTests(); runManualPlanTests(); runCloseQtyTests(); runLosslessJsonTests(); runGatePlanTests();
runFuturesExecTests(); runPromotionMapTests(); runTradeModeTests(); runPaperPlanTests(); runDailyLossTests(); runRegimeGateTests(); runTrailPlanTests(); runPaperRunnerTests(); runAllocationTests(); runStatsTests(); runRoutingTests(); runGateSpotPlanTests(); runLossStreakTests(); runTradeVetoTests(); runCalibrationTests(); runRecordPredictionTests(); runSubAccountTests(); runExitRulesTests(); runSafetyLogTests(); runFredTests(); runEventGuardTests(); runStopVerifyTests();
runManualOverrideTests();
runWebhookAuthTests();
runShortGuardTests();
runEmergencyLevelTests();
runTradingCapabilityTests(); runCheckOverrideTests(); runMarketHoursTests();
runFuturesHoursTests();
runProxyAssetTests();
runTrendTests(); runKisCoreTests(); runSpreadGuardTests(); runInstrumentTests();
runContractSpecTests(); runQuantizeTests(); runDisplayScaleTests(); runStatusReportTests(); runPositionParseTests(); runTraderScoreTests(); runConsensusSignalTests(); runWedomDisciplineTests(); runYoutubeLiveTests(); runCreatorEdgeTests();
runCreatorLedgerTests();
runCreatorIntakeTests();
runSignalPathTests(); runVenueBarsTests(); runLoginDiagnosticTests(); runPairTests(); runTpslPlanTests(); runPreferencesTests(); runPanelPrefsTests(); runGlobalStopTests(); runNewsFeedTests(); runRichTextTests(); runTokensTests(); runTradingLayoutTests(); runAutoCockpitTests(); runExecutionProfileTests(); runDedicated100xTests(); runScalpSignalTests(); runRiskContextTests(); runConnectionTests(); runScalpRunTests(); runScheduleExitTests(); runOAuthProvidersTests(); runSignupOutcomeTests(); runProfileSimTests();
runMonteCarloTests(); runRoundLedgerTests(); runIdempotencyTests(); runPendingReconcileTests(); runAutotradeTimingTests(); runEvaluationLoopTests(); runSchedulePollTests(); runScheduleToggleTests(); runPickConnectionTests(); runOrderCycleTests(); runLeverageSyncTests(); runMismatchRecoveryTests(); runTabGroupsTests(); runOrderSizingTests(); runOwnerBootstrapTests(); runConvictionTests(); runSleeveLedgerTests(); runOrderIntentTests(); runProtectionRepairTests(); runPriceBasisTests(); runContextSwitchTests(); runMobileSheetTests(); runSleeveStoreTests(); runTradingHistoryTests(); runFillPollTests(); runOrderProgressTests(); runQuantityInputTests(); runOrderCurrencyTests(); runOrderPreviewTests(); runOrderTypesTests(); runVenueQuoteTests(); runQuantityIntentTests(); runCostAnalysisTests(); runEdgeSweepTests(); runAutoOverviewTests(); runStrategyCardTests(); runPortfolioReturnsTests(); runAttributionTests(); runLeverageLadderTests(); runSchedulePlanTests(); runStrategyRegistryTests(); runCheckFlagTests(); runOriginalV1Tests(); runCloseEvidenceTests(); runPositionLifecycleTests(); runProtectionLedgerTests(); runFlatCleanupTests(); runTradeIdentityTests(); runLedgerEventTests(); runAutoRuntimeViewTests(); runFingerprintTests(); runServerFetchTests(); runMigrationPlanTests(); runPaperScopeTests(); runMigrationAdoptionTests(); runPaperChallengeTests(); runPaperChallengeScopeTests(); runPaperChallengeApiTests(); runPaperPriceSourceTests(); runPaperTargetTests(); runPaperCapabilityTests(); runLegacyLedgerTests(); runOrderBookTests(); runChallengeDisplayTests(); runPositionSizingTests(); runGameMoneyTests(); runCandleSeriesTests(); runIndicatorsTests(); runStreamEndpointTests(); runMarketStatsTests(); runPaperAvailableTests(); runStopPresetTests(); runChartLoadStateTests(); runSubmitGateTests(); runTradeIntentTests(); runPositionScopeTests(); runMarketDataContractTests(); runRankingTests(); runInstrumentFieldTests(); runInstrumentRouteTests(); runMarketInstrumentTests(); runSizeInputTests(); runCtaVerdictTests(); runPaperOrderReviewTests(); runPaperCloseReviewTests(); runPaperDepositTests(); runPaperSpotHoldingsTests(); runTradeContextTests(); runSellPlanTests(); runProductRegistryTests(); runVenueSpecTests(); runSpotPrecisionTests();
runMigrationStatusTests(); runWalletTruthTests(); runSmokePlanTests(); runSmokeRunTests(); runCancelRunTests(); runExitPolicyTests(); runRunRequestTests(); runBacktestVerdictTests(); runAiResultSourceTests(); runReconcilePlanTests(); runPersistentRuntimeTests(); runWorkerPlanTests(); runWorkerIdentityTests(); runRuntimeHealthTests(); runSchedulerReportTests(); runDataLocationTests(); runWalletScreenTests(); runStrategySyncTests(); runKillSwitchGateTests(); runEquityCurveTests(); runWalletDetailTests(); runWalletOverviewTests(); runPerformanceTests(); runExitMonitorTests(); runExitMonitorScheduleTests(); runExitMonitorLeaseTests(); runOpsCommandTests(); runOpsQueueTests(); runOpsViewTests(); runSelfHealTests(); runAutoVerifyTests(); runSecretParityTests(); runIncomeIngestTests(); runStrategyConflictGateTests(); runLeverageMathTests(); runLiveTradingGateTests(); runLadderGateTests(); runEdgeTypesTests(); runWalletTruthViewTests(); runSnapshotBucketTests(); runFxRateTests(); runCoverageSetTests(); runExecutionRuntimeTests(); runRecoveryCenterTests(); runSecretSyncTests(); runWorkerAliveTests(); runQuotaBreakerTests(); runDailyForcedEntryTests(); runHeartbeatVerifyTests(); runVercelEnvTests(); runKillSwitchTruthTests(); runKillTargetsTests(); runKillClosePlanTests(); runKillCloseRunTests(); runKillAlertTests(); runManagedPositionTests(); runLifecycleActionTests(); runMutationGuardTests(); runEntryExitSafetyTests(); runLifecycleRowsTests(); runPostEntryRiskTests(); runPositionRiskProvenanceTests(); runRiskObservationStoreTests(); runRiskObservationEligibilityTests(); runEscapeTelemetryTests(); runExitMonitorWakeTests(); runMigrationLineageTests(); runObservationAclTests(); runTestnetReadinessTests(); runTestnetDiagnoseVerdictTests(); runConnectionIdentityTests(); runOrderExecutorIdentityTests(); runBracketCacheTests(); runExecutionCostTests(); runMarketFreshnessTests(); runExitAuthorityTests(); runExitAuthorityRunTests(); runHoldExtensionTests(); runLiquidationDistanceTests(); runExitCoverageTests(); runExitRunOutcomeTests(); runExitLifecycleTests(); runStopMoveTests(); runScheduleCancelTests(); runDeploymentCheckTests(); runMigrationWaitTests(); runVercelRedeployTests(); runRunOutcomeTests(); runFirstEvalRaceTests(); runTradeVenueTests(); runHighWaterTests(); runOrphanSweepTests(); runPaperAccountTests(); runPaperWiringTests(); runPaperOrderTelemetryTests(); runPaperUnifyTests(); runIngestPipelineTests(); runScheduledExitRunnerTests(); runScalpSignalDiagnosisTests(); runRunStrategyDiagnosisTests();
// 비동기 테스트가 끝나기 전에 집계하면 실패가 통과로 잡힌다.
// CommonJS로 컴파일되므로 최상위 await을 못 쓴다 — 즉시 실행 함수로 감싼다.
(async () => {
  await flushAsync();
  await runExact100xObservationTests();
  // ── 통합 시험은 **단독으로** 돌린다 ──
  //
  //   이 시험은 \`globalThis.fetch\`를 바꿔 끼운다. 다른 async 시험이
  //   아직 대기 중이면 그쪽 스텁이 이 스텁을 덮어써서, 실행기가 **남의
  //   가짜 거래소**에 묻게 된다. 실제로 그 일이 났고 "거래소 호출이
  //   하나도 없다"로 보였다. 그래서 전부 끝난 뒤에 돌린다.
  await runOrderPathIntegrationTests();
  await runReconcileIntegrationTests();
  await runSpotIntegrationTests();
  await runExact100xChainTests();
  await runCloseIntegrationTests();
  await runTransitionIntegrationTests();
  await runCoinMRouteIntegrationTests();
  await runGateExecIntegrationTests();
  await runGateDupIntegrationTests();
  await runNoFixedTpIntegrationTests();
  await runPrecisionIntegrationTests();
  await runPrecisionMatrixTests();
  await runSmokeStartRouteTests();
  await runForcedEntryRouteTests();
  await runHoldExtensionIntegrationTests();
  await runKillCloseIntegrationTests();
  await flushAsync();
  const s = summary();
  console.log('\\n결과: ' + s.passed + ' 통과 / ' + s.failed + ' 실패');
  if (s.failed > 0) { s.failures.forEach(f => console.log('  FAIL:', f)); (globalThis).process.exitCode = 1; }
  else console.log('✅ 전체 통과');
})();
`;

// ── 충돌 마커가 남아 있으면 아예 돌리지 않는다 ──
//
// 실제로 이런 일이 있었다: 병합 충돌 마커가 이 파일에 커밋됐는데
// **마커가 템플릿 리터럴 안에 들어가 있어서** run-tests.mjs 자체는
// 파싱되고, 테스트도 3,600건 통과로 끝났다. 그래서 아무도 못 봤고
// 마커가 그대로 main에 들어갔다.
//
// '테스트가 통과했다'가 '러너 파일이 멀쩡하다'를 뜻하지 않는다.
// 그 둘을 여기서 갈라 둔다.
for (const mark of ['<<<<<<< ', '>>>>>>> ', '\n=======\n']) {
  if (RUN_SRC.includes(mark)) {
    console.error('❌ scripts/run-tests.mjs에 병합 충돌 마커가 남아 있습니다.');
    console.error('   테스트가 통과해도 이 파일은 고장 난 상태입니다 — 먼저 해소하세요.');
    process.exit(1);
  }
}

// ── `next/server` 스텁 ──
//
//   임시 디렉터리에는 node_modules가 없다. 라우트 핸들러를 통합 시험에
//   올리려면 `NextResponse.json`이 필요한데, 그 한 겹만 가짜로 둔다.
//   라우트 본문·거래소 어댑터·장부 쓰기는 전부 실제로 돈다.
//
//   **모의 경계가 하나 늘었다는 사실을 보고에 적는다** — fetch · Supabase ·
//   Next 응답 래퍼 셋이다.
writeFileSync(join(dir, '__next_server_stub.js'), `
class NextResponse {
  constructor(body, init) {
    this.__body = body;
    this.status = (init && init.status) || 200;
    this.headers = new Map(Object.entries((init && init.headers) || {}));
  }
  static json(body, init) { return new NextResponse(body, init); }
  async json() { return this.__body; }
  async text() { return JSON.stringify(this.__body); }
}
function NextRequest() {}
module.exports = { NextResponse, NextRequest };
`);

writeFileSync(join(dir, 'run.ts'), RUN_SRC);


// 임시 디렉터리에는 node_modules가 없다. npx로 tsc를 찾게 두면 npm 레지스트리의
// 동명이인 `tsc` 패키지를 받아와 컴파일이 조용히 실패한다. 프로젝트에 설치된
// TypeScript를 절대 경로로 직접 실행한다.
const tscPath = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscPath)) {
  console.error(`TypeScript를 찾을 수 없습니다: ${tscPath}\n먼저 'npm install'을 실행하세요.`);
  process.exit(1);
}

// ── `src` 전체를 컴파일한다 ──
//
//   예전에는 `tsc run.ts` 하나만 넘겼다. tsc는 import를 따라가며 필요한
//   파일만 내보내므로, **동적 `import('@/…')`로만 불리는 모듈은 컴파일
//   대상에 들어가지 않았다.** 그러면 통합 시험이 실행기를 부를 때
//   "Cannot find module"이 난다 — 실행기가 그 모듈을 그 방식으로
//   불러오기 때문이다.
//
//   모듈을 하나씩 정적 import로 끌어오는 방법은 끝이 없다(실행기가
//   부르는 것, 그것이 또 부르는 것…). 전부 컴파일한다.
const allTs = [];
(function collect(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) { collect(p); continue; }
    // .tsx는 제외한다 — jsx 설정이 필요하고 주문 경로에는 없다.
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      allTs.push(p.slice(dir.length + 1));
    }
  }
})(join(dir, 'src'));

const TSC_ARGS = [
  tscPath, 'run.ts', ...allTs,
  '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop',
];

try {
  execFileSync(process.execPath, TSC_ARGS, { cwd: dir, stdio: 'pipe' });
} catch (e) {
  // tsc가 타입 에러로 non-zero를 반환해도 js는 생성된다 (ignoreBuildErrors 정책과 동일).
  // 다만 js가 아예 안 나온 경우는 진짜 실패이므로 아래에서 걸러낸다.
}

const entry = join(dir, 'run.js');
if (!existsSync(entry)) {
  console.error('컴파일 실패 — run.js가 생성되지 않았습니다. tsc 출력:');
  try {
    execFileSync(process.execPath, TSC_ARGS, { cwd: dir, stdio: 'inherit' });
  } catch { /* 출력은 위에서 이미 표시됨 */ }
  process.exit(1);
}

// ── 쓰고 나면 치운다 ──
//
// 이 러너는 매 실행마다 `src` 전체를 임시 폴더로 복사한다. 그걸 안 지우면
// 뮤테이션 스윕 한 번에 수십 개가 쌓이고, **디스크가 차서 스윕이 도중에
// 죽는다.** 실제로 그 일이 두 번 났고 두 번 다 원인을 찾느라 시간을 썼다.
//
// 지우는 것이 결과를 바꾸면 안 되므로 종료 코드를 먼저 붙잡아 둔다.
// 컴파일 실패로 위에서 `process.exit(1)`한 경우까지 덮도록 `exit` 훅에도 건다.
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

try {
  execFileSync(process.execPath, ['run.js'], { cwd: dir, stdio: 'inherit' });
} catch (e) {
  cleanup();
  process.exit(typeof e?.status === 'number' ? e.status : 1);
}
cleanup();
