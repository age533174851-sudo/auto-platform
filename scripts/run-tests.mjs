#!/usr/bin/env node
// TRAIGO 코어 유닛 테스트 러너 (외부 프레임워크 없이 tsc 컴파일 후 실행)
// 사용: node scripts/run-tests.mjs  (또는 npm test)
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'traigo-test-'));
cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });

writeFileSync(join(dir, 'run.ts'), `
import { runPnlTests } from './src/lib/pnl/pnl.test';
import { runBacktestTests } from './src/lib/backtest/engine.test';
import { summary } from './src/test/harness';
console.log('════════ TRAIGO 코어 유닛 테스트 ════════');
runPnlTests(); runBacktestTests();
const s = summary();
console.log('\\n결과: ' + s.passed + ' 통과 / ' + s.failed + ' 실패');
if (s.failed > 0) { s.failures.forEach(f => console.log('  FAIL:', f)); (globalThis).process.exitCode = 1; }
else console.log('✅ 전체 통과');
`);

try {
  execSync('npx tsc run.ts --module commonjs --target es2019 --skipLibCheck --esModuleInterop', { cwd: dir, stdio: 'pipe' });
} catch (e) {
  // tsc가 타입 에러로 non-zero 반환해도 js는 생성됨 (ignoreBuildErrors 정책과 동일). 계속 진행.
}
execSync('node run.js', { cwd: dir, stdio: 'inherit' });
