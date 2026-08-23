#!/usr/bin/env node
// TRAIGO 코어 유닛 테스트 러너 (외부 프레임워크 없이 tsc 컴파일 후 실행)
// 사용: node scripts/run-tests.mjs  (또는 npm test)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'traigo-test-'));
cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });

const RUN_SRC = `
import { runPnlTests } from './src/lib/pnl/pnl.test';
import { runBacktestTests } from './src/lib/backtest/engine.test';
import { runRiskManagerTests } from './src/lib/engine/riskManager.test';
import { runExitPlanTests } from './src/lib/engine/exitPlan.test';
import { runExitMonitorTests } from './src/lib/engine/exitMonitor.test';
import { runExitMonitorScheduleTests } from './src/lib/engine/exitMonitorSchedule.test';
import { runExitMonitorLeaseTests } from './src/lib/engine/exitMonitorLease.test';
import { runOpsCommandTests } from './src/lib/ops/opsCommand.test';
import { runOpsQueueTests } from './src/lib/ops/opsQueue.test';
import { runSelfHealTests } from './src/lib/ops/selfHeal.test';
import { runOpsViewTests } from './src/lib/ui/opsView.test';
import { runAutoVerifyTests } from './src/lib/ops/autoVerify.test';
import { runSecretSyncTests } from './src/lib/ops/secretSync.test';
import { runWorkerAliveTests } from './src/lib/ops/workerAlive.test';
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
import { runStrategyConflictGateTests } from './src/lib/engine/strategyConflictGate.test';
import { runProtectionLedgerTests } from './src/lib/engine/protectionLedger.test';
import { runTradeIdentityTests } from './src/lib/strategies/tradeIdentity.test';
import { runEdgeTypesTests } from './src/lib/strategies/edgeTypes.test';
import { runLedgerEventTests } from './src/lib/ledger/ledgerEvent.test';
import { runIncomeIngestTests } from './src/lib/ledger/incomeIngest.test';
import { runAutoRuntimeViewTests } from './src/lib/engine/autoRuntimeView.test';
import { runFingerprintTests } from './src/lib/system/fingerprint.test';
import { runSupabaseUrlTests } from './src/lib/supabase/url.test';
import { runMigrationPlanTests } from './src/lib/system/migrationPlan.test';
import { runMigrationStatusTests } from './src/lib/system/migrationStatus.test';
import { runWalletTruthTests } from './src/lib/portfolio/walletTruth.test';
import { runWalletTruthViewTests } from './src/lib/portfolio/walletTruthView.test';
import { runSmokePlanTests } from './src/lib/smoke/smokePlan.test';
import { runSmokeRunTests } from './src/lib/smoke/smokeRun.test';
import { runCancelRunTests } from './src/lib/smoke/cancelRun.test';
import { runExitPolicyTests } from './src/lib/strategies/exitPolicy.test';
import { runRunRequestTests } from './src/lib/strategies/runRequest.test';
import { runExcursionTests } from './src/lib/backtest/excursion.test';
import { runPositionGuardTests } from './src/lib/engine/positionGuard.test';
import { runStateReconcileTests } from './src/lib/engine/stateReconcile.test';
import { runOrderLifecycleTests } from './src/lib/engine/orderLifecycle.test';
import { runUnknownResolverTests } from './src/lib/engine/unknownResolver.test';
import { runDataQualityTests } from './src/lib/engine/dataQuality.test';
import { runOperatingModeTests } from './src/lib/engine/operatingMode.test';
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
import { runPriceBasisTests } from './src/lib/markets/priceBasis.test';
import { runContextSwitchTests } from './src/lib/terminal/contextSwitch.test';
import { runMobileSheetTests } from './src/lib/ui/mobileSheet.test';
import { runPriceSourceTests } from './src/lib/ui/priceSource.test';
import { runSleeveStoreTests } from './src/lib/strategies/sleeveStore.test';
import { runTradingHistoryTests } from './src/lib/risk/tradingHistory.test';
import { runFillPollTests } from './src/lib/engine/fillPoll.test';
import { runOrderProgressTests } from './src/lib/engine/orderProgress.test';
import { runQuantityInputTests } from './src/lib/markets/quantityInput.test';
import { runRobustnessTests } from './src/lib/strategies/robustness.test';
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
import { runDataLocationTests } from './src/lib/runtime/dataLocation.test';
import { runWalletTests as runWalletScreenTests } from './src/lib/portfolio/wallet.test';
import { runMockSessionTests } from './src/lib/runtime/mockSession.test';
import { runStrategySyncTests } from './src/lib/strategies/syncPlan.test';
import { runKillSwitchGateTests } from './src/lib/risk/killSwitchGate.test';
import { runEquityCurveTests } from './src/lib/portfolio/equityCurve.test';
import { runWalletDetailTests } from './src/lib/portfolio/walletDetail.test';
import { runWalletOverviewTests } from './src/lib/portfolio/walletOverview.test';
import { runPerformanceTests } from './src/lib/portfolio/performance.test';
import { runSnapshotBucketTests } from './src/lib/portfolio/snapshotBucket.test';
import { runFxRateTests } from './src/lib/portfolio/fxRate.test';
import { runCoverageSetTests } from './src/lib/ledger/coverageSet.test';
import { runScheduleExitTests } from './src/lib/engine/scheduleExit.test';
import { runOAuthProvidersTests } from './src/lib/auth/oauthProviders.test';
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
runPnlTests(); runBacktestTests(); runRiskManagerTests(); runExitPlanTests(); runExcursionTests(); runPositionGuardTests(); runStateReconcileTests(); runOrderLifecycleTests(); runUnknownResolverTests(); runDataQualityTests(); runOperatingModeTests(); runMarketTypeTests(); runWalletTests(); runCoinMTests(); runCostBasisTests(); runLedgerTests(); runSpotStrategyTests(); runSpotOrderPlanTests(); runCombinedTests(); runBinanceHostTests(); runAuthErrorTests(); runErrorTextTests(); runAutotradeHealthTests(); runOverlayStackTests(); runThemeTests(); runPositionViewTests();
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
runSignalPathTests(); runVenueBarsTests(); runLoginDiagnosticTests(); runPairTests(); runTpslPlanTests(); runPreferencesTests(); runScalpSignalTests(); runRiskContextTests(); runConnectionTests(); runScalpRunTests(); runScheduleExitTests(); runOAuthProvidersTests(); runProfileSimTests();
runMonteCarloTests(); runRoundLedgerTests(); runIdempotencyTests(); runPendingReconcileTests(); runAutotradeTimingTests(); runEvaluationLoopTests(); runSchedulePollTests(); runScheduleToggleTests(); runPickConnectionTests(); runOrderCycleTests(); runLeverageSyncTests(); runMismatchRecoveryTests(); runTabGroupsTests(); runOrderSizingTests(); runOwnerBootstrapTests(); runConvictionTests(); runSleeveLedgerTests(); runOrderIntentTests(); runProtectionRepairTests(); runPriceBasisTests(); runContextSwitchTests(); runMobileSheetTests(); runPriceSourceTests(); runSleeveStoreTests(); runTradingHistoryTests(); runFillPollTests(); runOrderProgressTests(); runQuantityInputTests(); runRobustnessTests(); runCostAnalysisTests(); runEdgeSweepTests(); runAutoOverviewTests(); runStrategyCardTests(); runPortfolioReturnsTests(); runAttributionTests(); runLeverageLadderTests(); runSchedulePlanTests(); runStrategyRegistryTests(); runCheckFlagTests(); runOriginalV1Tests(); runCloseEvidenceTests(); runPositionLifecycleTests(); runProtectionLedgerTests(); runFlatCleanupTests(); runTradeIdentityTests(); runLedgerEventTests(); runAutoRuntimeViewTests(); runFingerprintTests(); runSupabaseUrlTests(); runMigrationPlanTests(); runMigrationStatusTests(); runWalletTruthTests(); runSmokePlanTests(); runSmokeRunTests(); runCancelRunTests(); runExitPolicyTests(); runRunRequestTests(); runBacktestVerdictTests(); runAiResultSourceTests(); runReconcilePlanTests(); runPersistentRuntimeTests(); runWorkerPlanTests(); runWorkerIdentityTests(); runRuntimeHealthTests(); runDataLocationTests(); runWalletScreenTests(); runMockSessionTests(); runStrategySyncTests(); runKillSwitchGateTests(); runEquityCurveTests(); runWalletDetailTests(); runWalletOverviewTests(); runPerformanceTests(); runExitMonitorTests(); runExitMonitorScheduleTests(); runExitMonitorLeaseTests(); runOpsCommandTests(); runOpsQueueTests(); runOpsViewTests(); runSelfHealTests(); runAutoVerifyTests(); runSecretParityTests(); runIncomeIngestTests(); runStrategyConflictGateTests(); runLeverageMathTests(); runLiveTradingGateTests(); runLadderGateTests(); runEdgeTypesTests(); runWalletTruthViewTests(); runSnapshotBucketTests(); runFxRateTests(); runCoverageSetTests(); runExecutionRuntimeTests(); runRecoveryCenterTests(); runSecretSyncTests(); runWorkerAliveTests(); runVercelEnvTests();
// 비동기 테스트가 끝나기 전에 집계하면 실패가 통과로 잡힌다.
// CommonJS로 컴파일되므로 최상위 await을 못 쓴다 — 즉시 실행 함수로 감싼다.
(async () => {
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

writeFileSync(join(dir, 'run.ts'), RUN_SRC);


// 임시 디렉터리에는 node_modules가 없다. npx로 tsc를 찾게 두면 npm 레지스트리의
// 동명이인 `tsc` 패키지를 받아와 컴파일이 조용히 실패한다. 프로젝트에 설치된
// TypeScript를 절대 경로로 직접 실행한다.
const tscPath = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscPath)) {
  console.error(`TypeScript를 찾을 수 없습니다: ${tscPath}\n먼저 'npm install'을 실행하세요.`);
  process.exit(1);
}

try {
  execFileSync(process.execPath, [
    tscPath, 'run.ts',
    '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop',
  ], { cwd: dir, stdio: 'pipe' });
} catch (e) {
  // tsc가 타입 에러로 non-zero를 반환해도 js는 생성된다 (ignoreBuildErrors 정책과 동일).
  // 다만 js가 아예 안 나온 경우는 진짜 실패이므로 아래에서 걸러낸다.
}

const entry = join(dir, 'run.js');
if (!existsSync(entry)) {
  console.error('컴파일 실패 — run.js가 생성되지 않았습니다. tsc 출력:');
  try {
    execFileSync(process.execPath, [
      tscPath, 'run.ts',
      '--module', 'commonjs', '--target', 'es2019',
      '--skipLibCheck', '--esModuleInterop',
    ], { cwd: dir, stdio: 'inherit' });
  } catch { /* 출력은 위에서 이미 표시됨 */ }
  process.exit(1);
}

execFileSync(process.execPath, ['run.js'], { cwd: dir, stdio: 'inherit' });
