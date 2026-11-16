#!/usr/bin/env node
// Offline SQL contract + FakeDB concurrency model; NOT a PostgreSQL integration test.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const sql = readFileSync('supabase/migrations/097_jobs_killswitch_active_unique.sql', 'utf8')
  .replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
assert.match(sql, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_jobs_one_active_kill_switch_per_connection\s+ON\s+public\.jobs\s*\(\s*connection_id\s*\)\s+WHERE\b/i);
const predicate = sql.slice(sql.toUpperCase().indexOf(' WHERE ') + 7);
assert.match(predicate, /\baction\s*=\s*'KILL_SWITCH_EXECUTE'/i);
assert.match(predicate, /\bstatus\s+IN\s*\(\s*'PENDING'\s*,\s*'PROCESSING'\s*\)/i);
assert.match(predicate, /\bconnection_id\s+IS\s+NOT\s+NULL/i);
assert.doesNotMatch(sql, /\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|UPDATE\s+public\.jobs)\b/i);

const active = j => j.connection_id != null && j.action === 'KILL_SWITCH_EXECUTE'
  && ['PENDING', 'PROCESSING'].includes(j.status);
class FakeJobs {
  constructor(unique) { this.unique = unique; this.rows = []; }
  async read(cid) { return this.rows.filter(j => j.connection_id === cid && active(j)); }
  async insert(job) {
    if (this.unique && active(job) && this.rows.some(j => active(j) && j.connection_id === job.connection_id)) {
      const err = new Error('duplicate key'); err.code = '23505'; throw err;
    }
    this.rows.push(job);
  }
}
const job = (connection_id, status='PENDING', action='KILL_SWITCH_EXECUTE') => ({ connection_id, status, action });
async function race(db) {
  const reads = await Promise.all([db.read('A'), db.read('A')]);
  assert.deepEqual(reads, [[], []]);
  return Promise.allSettled([db.insert(job('A')), db.insert(job('A'))]);
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + passed + ' ' + name); }
await check('RED baseline: read-then-insert permits two', async () => {
  const db = new FakeJobs(false); const outcomes = await race(db);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 2);
});
await check('GREEN unique model: exactly one winner', async () => {
  const db = new FakeJobs(true); const outcomes = await race(db);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected' && x.reason.code === '23505').length, 1);
});
await check('PROCESSING blocks another PENDING', async () => {
  const db = new FakeJobs(true); await db.insert(job('A', 'PROCESSING'));
  await assert.rejects(db.insert(job('A')), { code: '23505' });
});
await check('different connections independent', async () => {
  const db = new FakeJobs(true); await db.insert(job('A')); await db.insert(job('B'));
  assert.equal(db.rows.length, 2);
});
await check('COMPLETED releases slot', async () => {
  const db = new FakeJobs(true); await db.insert(job('A')); db.rows[0].status = 'COMPLETED';
  await db.insert(job('A')); assert.equal(db.rows.length, 2);
});
await check('FAILED/CANCELLED do not occupy slot', async () => {
  const db = new FakeJobs(true);
  await db.insert(job('A', 'FAILED')); await db.insert(job('A', 'CANCELLED')); await db.insert(job('A'));
  assert.equal(db.rows.length, 3);
});
await check('other actions unaffected', async () => {
  const db = new FakeJobs(true); await db.insert(job('A', 'PENDING', 'CLOSE_POSITION'));
  await db.insert(job('A', 'PENDING', 'CLOSE_POSITION')); assert.equal(db.rows.length, 2);
});
await check('preexisting duplicates are not silently cleaned', async () => {
  const db = new FakeJobs(false); await race(db); assert.equal(db.rows.filter(active).length, 2);
});
console.log('Offline contract ' + passed + '/' + passed + ' (no PostgreSQL replay)');
