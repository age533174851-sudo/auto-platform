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
import { summary } from './src/test/harness';
console.log('════════ TRAIGO 코어 유닛 테스트 ════════');
runPnlTests(); runBacktestTests(); runRiskManagerTests(); runExitPlanTests(); runExcursionTests(); runPositionGuardTests(); runStateReconcileTests(); runOrderLifecycleTests(); runUnknownResolverTests(); runDataQualityTests(); runOperatingModeTests(); runMarketTypeTests(); runWalletTests(); runCoinMTests(); runCostBasisTests(); runLedgerTests(); runSpotStrategyTests(); runSpotOrderPlanTests(); runCombinedTests(); runBinanceHostTests(); runOverlayStackTests();
const s = summary();
console.log('\\n결과: ' + s.passed + ' 통과 / ' + s.failed + ' 실패');
if (s.failed > 0) { s.failures.forEach(f => console.log('  FAIL:', f)); (globalThis).process.exitCode = 1; }
else console.log('✅ 전체 통과');
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
