import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoupledOfflineCampaign, validCoupledOfflineSnapshot,
  claimAndIntentCoupledOffline, applyCoupledOfflineEvent, resumeCoupledOffline, killCoupledOffline } from './ten-slot-coupled-offline.mjs';

const clear = { positions: 0, openOrders: 0, pendingEntries: 0 };
const clone = value => structuredClone(value);
class FakeDB {
  constructor(state = createCoupledOfflineCampaign('camp', 1000)) { this.state = clone(state); this.writes = 0; }
  async read() { if (this.failRead) throw Error('read failure'); return clone(this.state); }
  async compareAndSwap(campaignId, version, next) {
    if (this.failWrite) throw Error('write failure');
    if (this.state.campaignId !== campaignId || this.state.version !== version) return false;
    this.state = clone(next); this.writes++;
    if (this.commitThenThrow) throw Error('ambiguous commit');
    return true;
  }
}
const claim = (db, id = 'order-1') => claimAndIntentCoupledOffline(db, 'camp', clear, id, 10);
const event = (id, type, extra = {}) => ({ eventId: id, clientOrderId: 'order-1', type, ...extra });
const protect = event('entry', 'ENTRY_PROTECTED', { cumulativeLots: 10, stopAttached: true,
  takeProfitAttached: true, venuePositionConfirmed: true, ledgerMatched: true });
const flat = event('flat', 'EXIT_FLAT', { cumulativeLots: 10, venueFlatConfirmed: true,
  openOrdersConfirmedZero: true, ledgerMatched: true });

test('claim atomically persists reservation and entry intent in one CAS', async () => {
  const db = new FakeDB();
  assert.equal(validCoupledOfflineSnapshot(db.state), true);
  const r = await claim(db);
  assert.equal(r.code, 'RESERVATION_AND_INTENT_DURABLE');
  assert.equal(r.index, 0);
  assert.equal(db.writes, 1);
  assert.equal(db.state.ledger.slots[0].status, 'RESERVED');
  assert.equal(db.state.journals[0].phase, 'INTENT_PENDING');
  assert.equal(validCoupledOfflineSnapshot(db.state), true);
});

test('simultaneous claims lose CAS without a second reservation', async () => {
  const db = new FakeDB();
  const results = await Promise.all([claim(db, 'order-a'), claim(db, 'order-b')]);
  assert.deepEqual(results.map(x => x.ok).sort(), [false, true]);
  assert.equal(db.writes, 1);
  assert.equal(db.state.journals.filter(Boolean).length, 1);
});

test('ambiguous committed write fails closed; retry cannot duplicate', async () => {
  const db = new FakeDB(); db.commitThenThrow = true;
  assert.equal((await claim(db)).code, 'STORE_UNAVAILABLE');
  db.commitThenThrow = false;
  assert.equal((await claim(db)).code, 'ORDER_ID_REUSED');
  assert.equal(db.writes, 1);
});

test('orphan reservation and mismatched journal fail closed', async () => {
  const db = new FakeDB();
  db.state.ledger.slots[0].status = 'RESERVED';
  assert.equal((await claim(db)).code, 'COUPLING_CORRUPT');
  db.state = createCoupledOfflineCampaign('camp', 1000);
  await claim(db);
  db.state.journals[0].slotIndex = 1;
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', protect)).code, 'COUPLING_CORRUPT');
});

test('partial entry does not advance ledger to OPEN', async () => {
  const db = new FakeDB(); await claim(db);
  const result = await applyCoupledOfflineEvent(db, 'camp', event('partial', 'ENTRY_PARTIAL', { cumulativeLots: 3 }));
  assert.equal(result.phase, 'ENTRY_PARTIAL');
  assert.equal(db.state.ledger.slots[0].status, 'RESERVED');
  assert.equal(db.state.journals[0].filledLots, 3);
});

test('protection, durable exit, partial exit and flat close move both records atomically', async () => {
  const db = new FakeDB(); await claim(db);
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', protect)).phase, 'OPEN_PROTECTED');
  assert.equal(db.state.ledger.slots[0].status, 'OPEN');
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', event('exit', 'EXIT_INTENT', { exitIntentDurable: true }))).phase, 'EXIT_PENDING');
  assert.equal(db.state.ledger.slots[0].status, 'CLOSING');
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', event('exit-partial', 'EXIT_PARTIAL', { cumulativeLots: 4 }))).phase, 'EXIT_PARTIAL');
  assert.equal(db.state.ledger.slots[0].status, 'CLOSING');
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', flat)).phase, 'CLOSED');
  assert.equal(db.state.ledger.slots[0].status, 'SPENT');
  assert.equal(validCoupledOfflineSnapshot(db.state), true);
  assert.equal((await claimAndIntentCoupledOffline(db, 'camp', clear, 'order-2', 10)).index, 1);
});

test('unprotected fill and unsupported close cannot advance either record', async () => {
  const db = new FakeDB(); await claim(db);
  const writes = db.writes;
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', event('bad', 'ENTRY_PROTECTED', { cumulativeLots: 10 }))).code, 'PROTECTION_UNPROVEN');
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', flat)).code, 'FLAT_UNPROVEN');
  assert.equal(db.writes, writes);
});

test('restart atomically marks both records UNKNOWN and blocks new claim', async () => {
  const db = new FakeDB(); await claim(db);
  const r = await resumeCoupledOffline(db, 'camp');
  assert.equal(r.code, 'RECONCILIATION_REQUIRED');
  assert.equal(r.persisted, true);
  assert.equal(db.state.ledger.slots[0].status, 'UNKNOWN');
  assert.equal(db.state.journals[0].phase, 'UNKNOWN');
  assert.equal((await claimAndIntentCoupledOffline(db, 'camp', clear, 'order-2', 10)).code, 'SLOT_BUSY');
});

test('failed restart CAS does not partially mutate records', async () => {
  const db = new FakeDB(); await claim(db);
  db.failWrite = true;
  assert.equal((await resumeCoupledOffline(db, 'camp')).code, 'STORE_UNAVAILABLE');
  assert.equal(db.state.ledger.slots[0].status, 'RESERVED');
  assert.equal(db.state.journals[0].phase, 'INTENT_PENDING');
});

test('kill switch is durable and rejects claims without resetting journals', async () => {
  const db = new FakeDB(); await claim(db);
  assert.equal((await killCoupledOffline(db, 'camp')).code, 'KILL_PERSISTED');
  assert.equal(db.state.ledger.killed, true);
  assert.equal((await claimAndIntentCoupledOffline(db, 'camp', clear, 'order-2', 10)).code, 'KILL_SWITCH');
});

test('DB read failure and unsafe envelope version block writes', async () => {
  const db = new FakeDB(); db.failRead = true;
  assert.equal((await claim(db)).code, 'STORE_UNAVAILABLE');
  db.failRead = false; db.state.version = Number.MAX_SAFE_INTEGER;
  assert.equal((await claim(db)).code, 'COUPLING_CORRUPT');
  assert.equal(db.writes, 0);
});

test('duplicate event cannot advance journal or ledger version', async () => {
  const db = new FakeDB(); await claim(db);
  await applyCoupledOfflineEvent(db, 'camp', event('partial', 'ENTRY_PARTIAL', { cumulativeLots: 3 }));
  const before = clone(db.state);
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', event('partial', 'ENTRY_PARTIAL', { cumulativeLots: 4 }))).code, 'DUPLICATE_EVENT');
  assert.deepEqual(db.state, before);
});

test('corrupt envelope version below durable ledger version blocks all transitions', async () => {
  const db = new FakeDB(); await claim(db);
  db.state.ledger.version = db.state.version + 1;
  assert.equal(validCoupledOfflineSnapshot(db.state), false);
  const writes = db.writes;
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', protect)).code, 'COUPLING_CORRUPT');
  assert.equal(db.writes, writes);
});

test('corrupt envelope version equal to journal version blocks all transitions', async () => {
  const db = new FakeDB(); await claim(db);
  db.state.journals[0].version = db.state.version;
  assert.equal(validCoupledOfflineSnapshot(db.state), false);
  const writes = db.writes;
  assert.equal((await applyCoupledOfflineEvent(db, 'camp', protect)).code, 'COUPLING_CORRUPT');
  assert.equal(db.writes, writes);
});
