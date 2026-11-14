import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfflineLedger } from './ten-slot-offline.mjs';
import {
  claimPersistedOffline, advancePersistedOffline, resumePersistedOffline,
  killPersistedOffline,
} from './ten-slot-persistence-offline.mjs';

const clear = { positions: 0, openOrders: 0, pendingEntries: 0 };
const filled = { fillConfirmed: true, ledgerMatched: true };
const flat = { venueFlatConfirmed: true, openOrdersConfirmedZero: true, ledgerMatched: true };
const copy = x => structuredClone(x);

// In-memory FakeDB: atomic version CAS, with failure injection; never sends orders.
class FakeDB {
  constructor(state) { this.state = copy(state); this.failRead = false; this.failWrite = false; this.ambiguous = false; }
  async read() {
    if (this.failRead) throw Error('read failed');
    return copy(this.state);
  }
  async compareAndSwap(campaignId, expectedVersion, next) {
    await Promise.resolve(); // let two workers race using the same version
    if (this.failWrite) throw Error('write failed');
    if (this.ambiguous) return undefined;
    if (this.state.campaignId !== campaignId || this.state.version !== expectedVersion) return false;
    this.state = copy(next);
    return true;
  }
}

test('durable CAS: two concurrent claims reserve only one slot', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  const results = await Promise.all([
    claimPersistedOffline(db, 'campaign', clear),
    claimPersistedOffline(db, 'campaign', clear),
  ]);
  assert.equal(results.filter(x => x.code === 'RESERVATION_DURABLE').length, 1);
  assert.equal(results.filter(x => x.code === 'CAS_LOST').length, 1);
  assert.equal(db.state.slots.filter(x => x.status === 'RESERVED').length, 1);
});

test('failed/ambiguous CAS does not claim a bucket or imply an order', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  db.failWrite = true;
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'STORE_UNAVAILABLE');
  assert.equal(db.state.version, 0);
  db.failWrite = false; db.ambiguous = true;
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'STORE_UNAVAILABLE');
  assert.equal(db.state.version, 0);
});

test('missing, mismatched, or unreadable durable snapshot fails closed', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  assert.equal((await claimPersistedOffline(db, 'other', clear)).code, 'CAMPAIGN_MISMATCH');
  assert.equal((await claimPersistedOffline({ read: async () => null, compareAndSwap() {} }, 'campaign', clear)).code, 'LEDGER_MISSING');
  db.failRead = true;
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'STORE_UNAVAILABLE');
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'STORE_UNAVAILABLE');
});

test('restart after reservation persists UNKNOWN and blocks new claims', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'RESERVATION_DURABLE');
  const resumed = await resumePersistedOffline(db, 'campaign');
  assert.equal(resumed.code, 'RECONCILIATION_REQUIRED');
  assert.equal(resumed.persisted, true);
  assert.equal(db.state.slots[0].status, 'UNKNOWN');
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'SLOT_BUSY');
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'RECONCILIATION_REQUIRED');
});

test('restart after fill cannot recycle until independent flat evidence', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  await claimPersistedOffline(db, 'campaign', clear);
  assert.equal((await advancePersistedOffline(db, 'campaign', 0, 'OPEN', filled)).code, 'FILLED');
  await resumePersistedOffline(db, 'campaign');
  assert.equal(db.state.slots[0].status, 'UNKNOWN');
  assert.equal((await advancePersistedOffline(db, 'campaign', 0, 'SPENT', {})).code, 'TRANSITION_UNPROVEN');
  assert.equal((await advancePersistedOffline(db, 'campaign', 0, 'SPENT', flat)).code, 'CLOSED_VERIFIED');
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).index, 1);
  assert.equal(db.state.slots[0].status, 'SPENT');
});

test('restart of idle ledger is ledger-only; venue exposure still required', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'LEDGER_IDLE_ONLY');
  assert.equal((await claimPersistedOffline(db, 'campaign', null)).code, 'EXPOSURE_UNKNOWN');
  assert.equal((await claimPersistedOffline(db, 'campaign', { ...clear, openOrders: 1 })).code, 'EXPOSURE_BUSY');
  assert.equal(db.state.version, 0);
});

test('kill switch persists across restart and never resets spent slots', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  assert.equal((await killPersistedOffline(db, 'campaign')).code, 'KILL_PERSISTED');
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'LEDGER_IDLE_ONLY');
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'KILL_SWITCH');
});

test('corrupt persisted snapshot cannot be recovered or claimed', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  db.state.slots[0].status = 'OPEN';
  db.state.slots[1].status = 'OPEN';
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'LEDGER_UNKNOWN');
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'LEDGER_UNKNOWN');
  assert.equal(db.state.version, 0);
});

test('stale exit evidence loses CAS and cannot overwrite newer state', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  await claimPersistedOffline(db, 'campaign', clear);
  await advancePersistedOffline(db, 'campaign', 0, 'OPEN', filled);
  const results = await Promise.all([
    advancePersistedOffline(db, 'campaign', 0, 'CLOSING', { exitIntentPersisted: true }),
    advancePersistedOffline(db, 'campaign', 0, 'CLOSING', { exitIntentPersisted: true }),
  ]);
  assert.equal(results.filter(x => x.code === 'EXIT_PENDING').length, 1);
  assert.equal(results.filter(x => x.code === 'CAS_LOST').length, 1);
  assert.equal(db.state.slots[0].status, 'CLOSING');
});

test('malformed slot collection and unsafe version fail closed without throwing', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  db.state.slots = {};
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'LEDGER_UNKNOWN');
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'LEDGER_UNKNOWN');
  db.state = createOfflineLedger('campaign', 1000);
  db.state.version = Number.MAX_SAFE_INTEGER;
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'LEDGER_UNKNOWN');
});

test('failed restart CAS preserves in-flight reservation and blocks a second claim', async () => {
  const db = new FakeDB(createOfflineLedger('campaign', 1000));
  await claimPersistedOffline(db, 'campaign', clear);
  db.failWrite = true;
  assert.equal((await resumePersistedOffline(db, 'campaign')).code, 'STORE_UNAVAILABLE');
  assert.equal(db.state.slots[0].status, 'RESERVED');
  assert.equal((await claimPersistedOffline(db, 'campaign', clear)).code, 'SLOT_BUSY');
});
