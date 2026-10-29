import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_COUNT, MAX_CONCURRENT, createOfflineLedger, planOfflineClaim,
  advanceOfflineSlot, killOfflineLedger,
} from './ten-slot-offline.mjs';
const clear = { positions: 0, openOrders: 0, pendingEntries: 0 };
const filled = { fillConfirmed: true, ledgerMatched: true };
const flat = { venueFlatConfirmed: true, openOrdersConfirmedZero: true, ledgerMatched: true };

// FakeDB emulates an atomic version compare-and-swap; planning alone is not atomic.
class FakeDB {
  constructor(s) { this.state = s; }
  async claim(snapshot, exposure) {
    const planned = planOfflineClaim(snapshot, snapshot.version, exposure);
    if (!planned.ok) return planned;
    await Promise.resolve(); // concurrent workers can interleave here
    if (this.state.version !== snapshot.version) return { ok: false, code: 'CAS_LOST' };
    this.state = planned.next;
    return planned;
  }
}

test('ten equal budgets, never ten concurrent exchange positions', () => {
  const s = createOfflineLedger('campaign-a', 1000);
  assert.equal(SLOT_COUNT, 10);
  assert.equal(MAX_CONCURRENT, 1);
  assert.equal(s.slots.length, 10);
  assert.equal(s.slots.reduce((sum, x) => sum + x.marginBudget, 0), 1000);
  assert(s.slots.every(x => x.marginBudget === 100));
});

test('FakeDB CAS: two workers with same snapshot cannot claim two buckets', async () => {
  const db = new FakeDB(createOfflineLedger('a', 1000));
  const stale = db.state;
  const results = await Promise.all([db.claim(stale, clear), db.claim(stale, clear)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.code === 'CAS_LOST').length, 1);
  assert.equal(db.state.slots.filter(x => x.status === 'RESERVED').length, 1);
  assert.equal(planOfflineClaim(db.state, db.state.version, clear).code, 'SLOT_BUSY');
});

test('FakeVenue missing/invalid exposure always fails closed', () => {
  const s = createOfflineLedger('a', 1000);
  for (const exposure of [null, undefined, {}, { ...clear, positions: NaN },
    { ...clear, openOrders: -1 }, { ...clear, pendingEntries: 0.5 }]) {
    assert.equal(planOfflineClaim(s, s.version, exposure).code, 'EXPOSURE_UNKNOWN');
  }
  for (const field of ['positions', 'openOrders', 'pendingEntries']) {
    assert.equal(planOfflineClaim(s, s.version, { ...clear, [field]: 1 }).code, 'EXPOSURE_BUSY');
  }
});

test('no release before fill, exit intent, and independent flat/ledger evidence', () => {
  let s = createOfflineLedger('a', 1000);
  s = planOfflineClaim(s, s.version, clear).next;
  assert.equal(advanceOfflineSlot(s, s.version, 0, 'OPEN', {}).code, 'TRANSITION_UNPROVEN');
  s = advanceOfflineSlot(s, s.version, 0, 'OPEN', filled).next;
  assert.equal(advanceOfflineSlot(s, s.version, 0, 'SPENT', flat).code, 'TRANSITION_UNPROVEN');
  s = advanceOfflineSlot(s, s.version, 0, 'CLOSING', { exitIntentPersisted: true }).next;
  for (const evidence of [null, {}, { ...flat, ledgerMatched: false },
    { ...flat, openOrdersConfirmedZero: false }, { ...flat, venueFlatConfirmed: false }]) {
    assert.equal(advanceOfflineSlot(s, s.version, 0, 'SPENT', evidence).code, 'TRANSITION_UNPROVEN');
  }
  s = advanceOfflineSlot(s, s.version, 0, 'SPENT', flat).next;
  assert.equal(s.slots[0].status, 'SPENT');
  const next = planOfflineClaim(s, s.version, clear);
  assert(next.ok);
  assert.equal(next.index, 1);
});

test('restart uncertainty blocks all claims until explicit reconciliation', () => {
  let s = createOfflineLedger('a', 1000);
  s = planOfflineClaim(s, s.version, clear).next;
  s = advanceOfflineSlot(s, s.version, 0, 'UNKNOWN').next;
  assert.equal(planOfflineClaim(s, s.version, clear).code, 'SLOT_BUSY');
  assert.equal(advanceOfflineSlot(s, s.version, 0, 'SPENT', {}).code, 'TRANSITION_UNPROVEN');
  s = advanceOfflineSlot(s, s.version, 0, 'SPENT', flat).next;
  assert.equal(planOfflineClaim(s, s.version, clear).index, 1);
});

test('kill switch and stale version fail closed; spent slots cannot recycle', () => {
  let s = createOfflineLedger('a', 1000);
  assert.equal(planOfflineClaim(s, 1, clear).code, 'STALE_VERSION');
  s = killOfflineLedger(s, s.version).next;
  assert.equal(planOfflineClaim(s, s.version, clear).code, 'KILL_SWITCH');
  assert.equal(advanceOfflineSlot(s, s.version, 0, 'FREE', flat).code, 'TRANSITION_UNPROVEN');
});

test('malformed persisted ledger fails closed, not silently rebuilt', () => {
  const s = createOfflineLedger('a', 1000);
  for (const corrupt of [{ ...s, slots: s.slots.slice(1) },
    { ...s, slots: s.slots.map((x, i) => i ? x : { ...x, index: 1 }) },
    { ...s, slots: s.slots.map((x, i) => i ? x : { ...x, marginBudget: 1000 }) },
    { ...s, version: -1 }]) {
    assert.equal(planOfflineClaim(corrupt, 0, clear).code, 'LEDGER_UNKNOWN');
  }
});
