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

writeFileSync(join(dir, 'run.ts'), `
import { runPnlTests } from './src/lib/pnl/pnl.test';
import { runBacktestTests } from './src/lib/backtest/engine.test';
import { runRiskManagerTests } from './src/lib/engine/riskManager.test';
import { runExitPlanTests } from './src/lib/engine/exitPlan.test';
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
import { runOverlayStackTests } from './src/lib/nav/overlayStack.test';
import { runThemeTests } from './src/lib/theme/theme.test';
import { runPositionViewTests } from './src/lib/markets/positionView.test';
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
import { runExecutorHealthTests } from './src/lib/jobs/executorHealth.test';
import { runManualPlanTests } from './src/lib/engine/manualPlan.test';
import { runPairTests } from './src/lib/markets/pair.test';
import { runCloseQtyTests } from './src/lib/exchanges/closeQty.test';
import { runGatePlanTests } from './src/lib/exchanges/gatePlan.test';
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
import { runCheckOverrideTests } from './src/lib/engine/checkOverride.test';
import { runMarketHoursTests } from './src/lib/markets/marketHours.test';
import { runKisCoreTests } from './src/lib/exchanges/kisCore.test';
import { runSpreadGuardTests } from './src/lib/markets/spreadGuard.test';
import { runInstrumentTests } from './src/lib/markets/instrument.test';
import { runQuantizeTests } from './src/lib/exchanges/quantize.test';
import { runDisplayScaleTests } from './src/lib/ui/displayScale.test';
import { runStatusReportTests } from './src/lib/system/statusReport.test';
import { runPositionParseTests } from './src/lib/signals/positionParse.test';
import { runTraderScoreTests } from './src/lib/signals/traderScore.test';
import { runConsensusSignalTests } from './src/lib/signals/consensus.test';
import { runWedomDisciplineTests } from './src/lib/strategies/wedomDiscipline.test';
import { runYoutubeLiveTests } from './src/lib/signals/youtubeLive.test';
import { runLoginDiagnosticTests } from './src/lib/auth/loginDiagnostic.test';
import { summary, flushAsync } from './src/test/harness';
console.log('════════ TRAIGO 코어 유닛 테스트 ════════');
runPnlTests(); runBacktestTests(); runRiskManagerTests(); runExitPlanTests(); runExcursionTests(); runPositionGuardTests(); runStateReconcileTests(); runOrderLifecycleTests(); runUnknownResolverTests(); runDataQualityTests(); runOperatingModeTests(); runMarketTypeTests(); runWalletTests(); runCoinMTests(); runCostBasisTests(); runLedgerTests(); runSpotStrategyTests(); runSpotOrderPlanTests(); runCombinedTests(); runBinanceHostTests(); runOverlayStackTests(); runThemeTests(); runPositionViewTests(); runNewsSchemaTests(); runAnalyzeOneTests(); runCollectTests(); runEnrichPlanTests(); runConsensusTests(); runPricingTests(); runCalendarTests(); runRetentionTests(); runAdminGateTests(); runCommandTests(); runKeymapTests(); runPreTradeChecklistTests(); runExecutorHealthTests(); runManualPlanTests(); runCloseQtyTests(); runGatePlanTests(); runPromotionMapTests(); runTradeModeTests(); runPaperPlanTests(); runDailyLossTests(); runRegimeGateTests(); runTrailPlanTests(); runPaperRunnerTests(); runAllocationTests(); runStatsTests(); runRoutingTests(); runGateSpotPlanTests(); runLossStreakTests(); runTradeVetoTests(); runCalibrationTests(); runRecordPredictionTests(); runSubAccountTests(); runExitRulesTests(); runSafetyLogTests(); runFredTests(); runEventGuardTests(); runStopVerifyTests(); runCheckOverrideTests(); runMarketHoursTests(); runKisCoreTests(); runSpreadGuardTests(); runInstrumentTests(); runQuantizeTests(); runDisplayScaleTests(); runStatusReportTests(); runPositionParseTests(); runTraderScoreTests(); runConsensusSignalTests(); runWedomDisciplineTests(); runYoutubeLiveTests(); runLoginDiagnosticTests(); runPairTests();
// 비동기 테스트가 끝나기 전에 집계하면 실패가 통과로 잡힌다.
// CommonJS로 컴파일되므로 최상위 await을 못 쓴다 — 즉시 실행 함수로 감싼다.
(async () => {
  await flushAsync();
  const s = summary();
  console.log('\\n결과: ' + s.passed + ' 통과 / ' + s.failed + ' 실패');
  if (s.failed > 0) { s.failures.forEach(f => console.log('  FAIL:', f)); (globalThis).process.exitCode = 1; }
  else console.log('✅ 전체 통과');
})();
`);

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
