import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Execute the actual workflow's evidence classifier, without network/orders.
const yaml = readFileSync('.github/workflows/smoke-test-testnet.yml', 'utf8');
const source = yaml.match(/python3 - "\$body" <<'PY'\n([\s\S]*?)\n          PY/)[1]
  .replace(/^          /gm, '');
const pass = (n = 1) => ({ attemptNo: n, state: 'CLOSED', verdict: { code: 'PASS', pass: true },
  entry: { orderId: 'entry', qty: 1, avgPrice: 68000, slOrderId: 'sl', tpOrderId: 'tp', exitOrderId: 'exit' },
  steps: ['ENTRY', 'FILL', 'STOP', 'TAKE_PROFIT', 'CLOSE', 'POSITION_ZERO', 'ORDERS_ZERO', 'RECONCILE']
    .map(id => ({ id, state: 'PASS' })) });
const run = (over = {}) => ({ id: 'expected-run', state: 'DONE', attempts: 1,
  summary: { code: 'PASS', pass: true }, tests: [pass()], ...over });
function verify(runs, expected = 'expected-run') {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-smoke-evidence-'));
  try {
    const file = join(dir, 'response.json');
    writeFileSync(file, JSON.stringify({ ok: true, runs }));
    return spawnSync('python3', ['-c', source, file], { encoding: 'utf8',
      env: { ...process.env, EXPECTED_RUN_ID: expected, ATTEMPTS: '1' } }).status;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('completed requested run with fills/protection/cleanup passes', () => assert.equal(verify([run()]), 0));
test('BLOCKED with no attempts is a failed experiment', () => assert.notEqual(verify([run({ state: 'STOPPED', tests: [] })]), 0));
test('a different concurrent run cannot supply success evidence', () => assert.notEqual(verify([run({ id: 'another-run' })]), 0));
test('partial batch cannot pass', () => assert.notEqual(verify([run({ attempts: 3 })]), 0));
test('missing start run identity cannot pass', () => assert.notEqual(verify([run()], ''), 0));
test('PASS label without fill/protection facts cannot pass', () => assert.notEqual(verify([run({ tests: [{ ...pass(), entry: {} }] })]), 0));
test('UNKNOWN cleanup cannot pass', () => assert.notEqual(verify([run({ tests: [{ ...pass(), steps: [] }] })]), 0));
