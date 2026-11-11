import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tickResponseVerdict } from './check-autotrade-tick-response.mjs';

const ok = (results) => ({ ok: true, error: null, scheduledUnknown: false, scheduled: results.length, results });

test('no enabled schedules is visible but never claimed as an entry', () => {
  const v = tickResponseVerdict(ok([]));
  assert.equal(v.pass, true);
  assert.equal(v.code, 'NO_ENABLED_SCHEDULES');
  assert.equal(v.reportedEntries, 0);
});

test('HTTP 200 with server error or unknown schedule count fails closed', () => {
  for (const b of [
    { ok: false, error: 'quota', scheduled: 0, results: [] },
    { ok: true, error: 'database error', scheduled: 0, results: [] },
    { ok: true, scheduledUnknown: true, scheduled: null, results: [] },
    { ok: true, scheduled: null, results: [] },
    { ok: true, scheduled: 1, results: [] },
    { ok: true, scheduled: 1, results: [null] },
    {},
  ]) {
    assert.equal(tickResponseVerdict(b).pass, false);
  }
});

test('WAITING is not failed or entered; reported entry is not a verified fill', () => {
  const wait = tickResponseVerdict(ok([{ ok: true, skipped: true, code: 'WAITING' }]));
  assert.equal(wait.pass, true);
  assert.equal(wait.code, 'NO_ENTRY_REPORTED');
  const entered = tickResponseVerdict(ok([{ ok: true, executed: true, outcome: 'ENTERED' }]));
  assert.equal(entered.pass, true);
  assert.equal(entered.code, 'ENTRY_REPORTED_NOT_FILL_VERIFIED');
});

test('per-schedule execution failure makes workflow fail', () => {
  const v = tickResponseVerdict(ok([{ ok: false, executed: false, outcome: 'FAILED' }]));
  assert.equal(v.pass, false);
  assert.equal(v.code, 'EVALUATION_FAILURE');
  assert.equal(v.failures, 1);
});

test('CLI does not echo server messages or sensitive payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'traigo-tick-response-'));
  try {
    const file = join(dir, 'response.json');
    writeFileSync(file, JSON.stringify({ ok: false, error: 'DO_NOT_LEAK_SECRET', scheduled: 0, results: [] }));
    const run = spawnSync(process.execPath, [new URL('./check-autotrade-tick-response.mjs', import.meta.url).pathname, file], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /SCHEDULE_READ_OR_SERVER_FAILED/);
    assert.doesNotMatch(run.stdout + run.stderr, /DO_NOT_LEAK_SECRET/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test('workflow checks out repository before invoking the parser and never echoes the body', () => {
  const workflow = readFileSync(new URL('../.github/workflows/autotrade-tick.yml', import.meta.url), 'utf8');
  const checkout = workflow.indexOf('actions/checkout@v4');
  const verifier = workflow.indexOf('node scripts/check-autotrade-tick-response.mjs');
  assert.ok(checkout >= 0 && verifier > checkout, 'checkout must precede the parser');
  assert.doesNotMatch(workflow, /^\s*cat "\$body"/m);
});

test('RED: schedule save error cannot be reported as a successful tick', () => {
  const v = tickResponseVerdict(ok([{ ok: true, executed: false, saveError: 'write failed' }]));
  assert.equal(v.pass, false);
  assert.equal(v.code, 'SCHEDULE_STATE_SAVE_FAILED');
});

test('RED: cron log failure must be visible rather than silently green', () => {
  const v = tickResponseVerdict({ ...ok([{ ok: true, executed: false }]), cronLogError: 'write failed' });
  assert.equal(v.pass, false);
  assert.equal(v.code, 'CRON_AUDIT_SAVE_FAILED');
});

test('RED: missing per-schedule ok must not pass as a successful evaluation', () => {
  const v = tickResponseVerdict(ok([{ executed: true, outcome: 'ENTERED' }]));
  assert.equal(v.pass, false);
  assert.equal(v.code, 'EVALUATION_STATUS_UNKNOWN');
});
