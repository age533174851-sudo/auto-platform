import test from 'node:test';
import assert from 'node:assert/strict';
import { persistOfflineEntryIntent, persistOfflineLifecycleEvent, planOfflineLifecycleEvent } from './ten-slot-lifecycle-offline.mjs';
const copy = x => structuredClone(x);
const reservation = { durable: true, killed: false, campaignId: 'c', slotIndex: 0, ledgerVersion: 1 };
const evt = (type, eventId, extra = {}) => ({ type, eventId, clientOrderId: 'order-c-0', ...extra });
class FakeDB {
  constructor() { this.state = null; this.failRead = false; this.failWrite = false; this.ambiguous = false; }
  async read() { if (this.failRead) throw Error('read'); return copy(this.state); }
  async insertIfAbsent(_id, value) { await Promise.resolve(); if (this.failWrite) throw Error('write'); if (this.ambiguous) return undefined; if (this.state) return false; this.state = copy(value); return true; }
  async compareAndSwap(_id, expected, value) { await Promise.resolve(); if (this.failWrite) throw Error('write'); if (this.ambiguous) return undefined; if (!this.state || this.state.version !== expected) return false; this.state = copy(value); return true; }
}
const init = async () => { const db = new FakeDB(); assert.equal((await persistOfflineEntryIntent(db, reservation, 'order-c-0', 10)).code, 'INTENT_DURABLE'); return db; };
const event = (db, type, id, extra) => persistOfflineLifecycleEvent(db, 'c', evt(type,id,extra));
const protectedFill = { cumulativeLots: 10, stopAttached: true, takeProfitAttached: true, venuePositionConfirmed: true, ledgerMatched: true };
const flat = { cumulativeLots: 10, venueFlatConfirmed: true, openOrdersConfirmedZero: true, ledgerMatched: true };

test('intent must be durable; competing writers cannot create two order intents', async () => {
  const db = new FakeDB();
  const results = await Promise.all([persistOfflineEntryIntent(db,reservation,'order-c-0',10),persistOfflineEntryIntent(db,reservation,'order-c-1',10)]);
  assert.equal(results.filter(x=>x.code==='INTENT_DURABLE').length,1);
  assert.equal(results.filter(x=>x.code==='INTENT_CONFLICT').length,1);
  assert.equal(db.state.phase,'INTENT_PENDING');
});
test('missing reservation and store failures never authorize an intent', async () => {
  const db = new FakeDB();
  assert.equal((await persistOfflineEntryIntent(db,{...reservation,durable:false},'order-c-0',10)).code,'RESERVATION_UNPROVEN');
  db.failRead=true; assert.equal((await persistOfflineEntryIntent(db,reservation,'order-c-0',10)).code,'STORE_UNAVAILABLE');
  db.failRead=false; db.ambiguous=true; assert.equal((await persistOfflineEntryIntent(db,reservation,'order-c-0',10)).code,'STORE_UNAVAILABLE');
  assert.equal(db.state,null);
});
test('duplicate order intent never permits a resend', async () => {
  const db = await init();
  assert.equal((await persistOfflineEntryIntent(db,reservation,'order-c-0',10)).code,'INTENT_ALREADY_EXISTS');
  assert.equal((await persistOfflineEntryIntent(db,reservation,'other-order',10)).code,'INTENT_CONFLICT');
});
test('partial fill is recorded but cannot be mistaken for fully protected position', async () => {
  const db = await init();
  assert.equal((await event(db,'ENTRY_PARTIAL','e1',{cumulativeLots:4})).code,'ENTRY_PARTIAL');
  assert.equal(db.state.filledLots,4);
  assert.equal((await event(db,'ENTRY_PROTECTED','e2',{...protectedFill,stopAttached:false})).code,'PROTECTION_UNPROVEN');
  assert.equal(db.state.phase,'ENTRY_PARTIAL');
  assert.equal((await event(db,'ENTRY_PROTECTED','e3',protectedFill)).code,'OPEN_PROTECTED');
});
test('replayed and stale/out-of-order fill events do not advance version', async () => {
  const db = await init();
  await event(db,'ENTRY_PARTIAL','e1',{cumulativeLots:4});
  assert.equal((await event(db,'ENTRY_PARTIAL','e1',{cumulativeLots:8})).code,'DUPLICATE_EVENT');
  assert.equal((await event(db,'ENTRY_PARTIAL','e2',{cumulativeLots:2})).code,'ENTRY_UNPROVEN');
  assert.equal(db.state.version,1);
});
test('mismatched order ID, invalid quantity, and invalid event are blocked', async () => {
  const db = await init();
  assert.equal((await event(db,'ENTRY_PARTIAL','e1',{clientOrderId:'wrong',cumulativeLots:4})).code,'ORDER_MISMATCH');
  assert.equal((await event(db,'ENTRY_PARTIAL','e2',{cumulativeLots:0.5})).code,'ENTRY_UNPROVEN');
  assert.equal((await event(db,'SOMETHING','e3')).code,'EVENT_UNKNOWN');
});
test('exit intent requires durable evidence and partial exit cannot close early', async () => {
  const db = await init();
  await event(db,'ENTRY_PROTECTED','e1',protectedFill);
  assert.equal((await event(db,'EXIT_INTENT','e2',{})).code,'EXIT_INTENT_UNPROVEN');
  assert.equal((await event(db,'EXIT_INTENT','e3',{exitIntentDurable:true})).code,'EXIT_PENDING');
  assert.equal((await event(db,'EXIT_PARTIAL','e4',{cumulativeLots:3})).code,'EXIT_PARTIAL');
  assert.equal((await event(db,'EXIT_FLAT','e5',{...flat,openOrdersConfirmedZero:false})).code,'FLAT_UNPROVEN');
  assert.equal((await event(db,'EXIT_FLAT','e6',flat)).code,'CLOSED');
  assert.equal(db.state.exitedLots,10);
});
test('uncertain send blocks lifecycle until independently reconciled', async () => {
  const db = await init();
  assert.equal((await event(db,'UNCERTAIN','e1')).code,'UNKNOWN');
  assert.equal((await event(db,'ENTRY_PROTECTED','e2',protectedFill)).code,'PROTECTION_UNPROVEN');
  assert.equal((await event(db,'EXIT_FLAT','e3',flat)).code,'FLAT_UNPROVEN');
  assert.equal((await event(db,'EXIT_FLAT','e4',{...flat,cumulativeLots:0})).code,'CLOSED');
});
test('reconcile open needs full position and stop/take-profit evidence', async () => {
  const db = await init();
  await event(db,'ENTRY_PROTECTED','e1',protectedFill);
  await event(db,'UNCERTAIN','e2');
  assert.equal((await event(db,'RECONCILE_OPEN','e3',{...protectedFill,takeProfitAttached:false})).code,'RECONCILIATION_UNPROVEN');
  assert.equal((await event(db,'RECONCILE_OPEN','e4',protectedFill)).code,'OPEN_PROTECTED');
});
test('concurrent callback CAS accepts one event and rejects the other', async () => {
  const db = await init();
  const res = await Promise.all([event(db,'ENTRY_PARTIAL','e1',{cumulativeLots:3}),event(db,'ENTRY_PARTIAL','e2',{cumulativeLots:4})]);
  assert.equal(res.filter(x=>x.code==='ENTRY_PARTIAL').length,1);
  assert.equal(res.filter(x=>x.code==='CAS_LOST').length,1);
});
test('corrupt journal, unsafe version, and ambiguous writes fail closed', async () => {
  const db = await init();
  db.ambiguous=true;
  assert.equal((await event(db,'ENTRY_PARTIAL','e1',{cumulativeLots:3})).code,'STORE_UNAVAILABLE');
  db.ambiguous=false; db.state.version=Number.MAX_SAFE_INTEGER;
  assert.equal((await event(db,'ENTRY_PARTIAL','e1',{cumulativeLots:3})).code,'JOURNAL_CORRUPT');
  db.state.version=0; db.state.eventIds=['x','x'];
  assert.equal((await event(db,'ENTRY_PARTIAL','e1',{cumulativeLots:3})).code,'JOURNAL_CORRUPT');
});
test('stale version and already-closed journal are never reopened', async () => {
  const db = await init();
  assert.equal(planOfflineLifecycleEvent(db.state,1,evt('UNCERTAIN','e1')).code,'STALE_VERSION');
  await event(db,'ENTRY_PROTECTED','e1',protectedFill);
  await event(db,'EXIT_INTENT','e2',{exitIntentDurable:true});
  await event(db,'EXIT_FLAT','e3',flat);
  assert.equal((await event(db,'UNCERTAIN','e4')).code,'ALREADY_CLOSED');
});
