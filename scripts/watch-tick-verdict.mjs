#!/usr/bin/env node
// GitHub watch-tick: a successful HTTP response is not evidence that every watch was monitored.
// This is read-only response classification; it never sends or retries orders.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const nonnegativeInt = (n) => Number.isSafeInteger(n) && n >= 0;

export function classifyWatchTick(httpCode, body) {
  if (String(httpCode) !== '200') return { ok: false, reason: `HTTP_${httpCode}` };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'BODY_INVALID' };
  if (body.ok !== true || body.scope !== 'all') return { ok: false, reason: 'TOP_LEVEL_NOT_OK' };
  const counters = ['checked', 'moved', 'triggered', 'ordered', 'skipped'];
  if (counters.some((k) => !nonnegativeInt(body[k])) ||
      !Number.isFinite(body.checkIntervalMin) || body.checkIntervalMin <= 0 ||
      !Array.isArray(body.results)) return { ok: false, reason: 'CONTRACT_INVALID' };
  if (body.results.length !== body.checked || body.moved > body.checked ||
      body.triggered > body.checked || body.ordered > body.triggered ||
      body.skipped > body.checked) return { ok: false, reason: 'COUNTER_MISMATCH' };

  const counts = { HOLD: 0, MOVE: 0, ORDERED: 0, ORDER_FAILED: 0, SKIP: 0 };
  const ids = new Set();
  for (const row of body.results) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row.id !== 'string' || row.id.length === 0 ||
        typeof row.symbol !== 'string' || row.symbol.length === 0 ||
        !Object.hasOwn(counts, row.action) || ids.has(row.id)) {
      return { ok: false, reason: 'RESULT_INVALID' };
    }
    ids.add(row.id);
    counts[row.action]++;
  }
  if (counts.ORDERED !== body.ordered ||
      counts.ORDERED + counts.ORDER_FAILED !== body.triggered ||
      counts.SKIP !== body.skipped || counts.MOVE > body.moved) {
    return { ok: false, reason: 'COUNTER_MISMATCH' };
  }
  if (counts.ORDER_FAILED > 0) return { ok: false, reason: 'ORDER_FAILED' };
  if (counts.SKIP > 0) return { ok: false, reason: 'PRICE_UNAVAILABLE' };
  return { ok: true, reason: 'MONITORED' };
}

const row = (action, id = action) => ({ id, symbol: 'BTCUSDT', action });
const base = () => ({ ok: true, scope: 'all', checked: 2, moved: 0, triggered: 0,
  ordered: 0, skipped: 0, checkIntervalMin: 15, results: [row('HOLD', 'a'), row('HOLD', 'b')] });

function selfTest() {
  const tests = [
    ['empty success', { ...base(), checked: 0, results: [] }, true],
    ['normal hold', base(), true],
    ['move', { ...base(), moved: 1, results: [row('MOVE', 'a'), row('HOLD', 'b')] }, true],
    ['ordered', { ...base(), triggered: 1, ordered: 1, results: [row('ORDERED', 'a'), row('HOLD', 'b')] }, true],
    ['move and trigger same tick', { ...base(), moved: 1, triggered: 1, ordered: 1, results: [row('ORDERED', 'a'), row('HOLD', 'b')] }, true],
    ['individual order failed', { ...base(), triggered: 1, results: [row('ORDER_FAILED', 'a'), row('HOLD', 'b')] }, false],
    ['price feed unavailable', { ...base(), skipped: 1, results: [row('SKIP', 'a'), row('HOLD', 'b')] }, false],
    ['top-level false', { ...base(), ok: false }, false],
    ['scope self', { ...base(), scope: 'self' }, false],
    ['missing results', { ...base(), results: undefined }, false],
    ['unknown action', { ...base(), results: [row('MYSTERY', 'a'), row('HOLD', 'b')] }, false],
    ['missing checked', { ...base(), checked: undefined }, false],
    ['negative ordered', { ...base(), ordered: -1 }, false],
    ['noninteger checked', { ...base(), checked: 1.5 }, false],
    ['inconsistent ordered', { ...base(), ordered: 1 }, false],
    ['inconsistent triggered', { ...base(), triggered: 1 }, false],
    ['inconsistent skipped', { ...base(), skipped: 1 }, false],
    ['duplicate watch', { ...base(), results: [row('HOLD', 'a'), row('HOLD', 'a')] }, false],
    ['missing id', { ...base(), results: [row('HOLD', ''), row('HOLD', 'b')] }, false],
    ['zero interval', { ...base(), checkIntervalMin: 0 }, false],
  ];
  for (const [name, payload, expected] of tests) {
    assert.equal(classifyWatchTick('200', payload).ok, expected, name);
  }
  assert.equal(classifyWatchTick('500', base()).ok, false, 'HTTP 500');
  assert.equal(classifyWatchTick('200', null).ok, false, 'invalid body');
  console.log(`watch-tick verdict: ${tests.length + 2} contract scenarios passed`);
}

function checkWiring() {
  const wf = readFileSync('.github/workflows/watch-tick.yml', 'utf8');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(wf, /uses:\s*actions\/checkout@v4/);
  assert.match(wf, /uses:\s*actions\/setup-node@v4/);
  assert.match(wf, /node scripts\/watch-tick-verdict\.mjs "\$code" "\$body"/);
  assert.match(ci, /node scripts\/watch-tick-verdict\.mjs --self-test/);
  assert.match(ci, /node scripts\/watch-tick-verdict\.mjs --check-wiring/);
  console.log('watch-tick verdict wiring: OK');
}

const [mode, arg] = process.argv.slice(2);
if (mode === '--self-test') selfTest();
else if (mode === '--check-wiring') checkWiring();
else if (mode && arg) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(arg, 'utf8')); }
  catch { console.error('::error::watch-tick response is not valid JSON'); process.exit(1); }
  const verdict = classifyWatchTick(mode, parsed);
  if (!verdict.ok) { console.error(`::error::watch-tick incomplete: ${verdict.reason}`); process.exit(1); }
  console.log('watch-tick complete: all watched entries evaluated without order failure or missing prices');
} else {
  console.error('usage: node scripts/watch-tick-verdict.mjs <http-code> <json-file> | --self-test | --check-wiring');
  process.exit(2);
}
