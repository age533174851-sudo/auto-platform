import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectUnknownCoupledOffline } from './ten-slot-reconcile-evidence-offline.mjs';

const NOW = 1_800_000_000_000;
const clone = x => structuredClone(x);
const base = () => ({ campaignId: 'camp', ledger: { killed: false,
  slots: Array.from({ length: 10 }, (_, i) => ({ index: i, status: i === 0 ? 'UNKNOWN' : 'FREE' })) },
  journals: [{ campaignId: 'camp', slotIndex: 0, clientOrderId: 'coid-1',
    phase: 'UNKNOWN', requestedLots: 10, filledLots: 0, exitedLots: 0 }, ...Array(9).fill(null)] });
const flatVenue = () => ({ source: 'VENUE', observationId: 'venue-1', clientOrderId: 'coid-1',
  observedAt: NOW - 1000, positionLots: 0, regularOpenOrders: 0, algoOpenOrders: 0,
  pendingEntries: 0 });
const flatLedger = () => ({ source: 'LEDGER', observationId: 'ledger-1', clientOrderId: 'coid-1',
  observedAt: NOW - 1000, positionLots: 0, pendingIntents: 0 });
function setup() {
  const state = base(), venue = flatVenue(), ledger = flatLedger();
  const calls = { campaign: 0, venue: 0, ledger: 0, sends: 0, writes: 0 };
  const readers = {
    async readCampaign() { calls.campaign++; return clone(state); },
    async readVenue() { calls.venue++; return clone(venue); },
    async readLedger() { calls.ledger++; return clone(ledger); },
    async sendOrder() { calls.sends++; throw Error('must not send'); },
    async write() { calls.writes++; throw Error('must not write'); },
  };
  return { state, venue, ledger, calls, readers,
    inspect: () => inspectUnknownCoupledOffline(readers, 'camp', NOW) };
}
const safe = result => {
  assert.equal(result.ok, false);
  assert.equal(result.orderSendAuthorized, false);
  assert.equal(result.slotUnlockAuthorized, false);
};

test('fresh independent zero-exposure observations produce review candidate only', async () => {
  const t = setup(), r = await t.inspect();
  safe(r); assert.equal(r.code, 'FLAT_REVIEW_CANDIDATE');
  assert.equal(r.reviewRequired, true);
  assert.deepEqual(t.calls, { campaign: 1, venue: 1, ledger: 1, sends: 0, writes: 0 });
});
test('remaining Algo order prevents flat conclusion', async () => {
  const t = setup(); t.venue.algoOpenOrders = 1;
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_DISAGREES');
});
test('remaining regular order or pending entry prevents flat conclusion', async () => {
  for (const field of ['regularOpenOrders', 'pendingEntries']) {
    const t = setup(); t.venue[field] = 1;
    const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_DISAGREES');
  }
});
test('ledger pending intent or nonzero exposure prevents flat conclusion', async () => {
  for (const field of ['pendingIntents', 'positionLots']) {
    const t = setup(); t.ledger[field] = 1;
    const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_DISAGREES');
  }
});
test('stale and future observations are rejected', async () => {
  for (const observedAt of [NOW - 60_001, NOW + 1, -1]) {
    const t = setup(); t.venue.observedAt = observedAt;
    const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_UNVERIFIED');
  }
});
test('order ID mismatch, wrong source, and reused observation ID fail closed', async () => {
  for (const mutate of [t => t.venue.clientOrderId = 'wrong',
    t => t.ledger.source = 'VENUE', t => t.ledger.observationId = t.venue.observationId]) {
    const t = setup(); mutate(t);
    const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_UNVERIFIED');
  }
});
test('malformed negative or fractional exposure is never flattened to zero', async () => {
  for (const value of [-1, 0.5, NaN, undefined]) {
    const t = setup(); t.venue.positionLots = value;
    const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_MALFORMED');
  }
});
test('past fill requires matching independent exit quantities', async () => {
  const t = setup(); t.state.journals[0].filledLots = 10;
  let r = await t.inspect(); safe(r); assert.equal(r.code, 'EXIT_EVIDENCE_MISSING');
  t.venue.exitedLots = 10; t.ledger.exitedLots = 10;
  r = await t.inspect(); safe(r); assert.equal(r.code, 'FLAT_REVIEW_CANDIDATE');
});
test('protected open matching both sources is only a review candidate', async () => {
  const t = setup(); t.venue.positionLots = 10; t.ledger.positionLots = 10;
  t.state.journals[0].filledLots = 10;
  t.venue.stopAttached = true; t.venue.takeProfitAttached = true; t.venue.algoOpenOrders = 2;
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'OPEN_REVIEW_CANDIDATE');
});
test('open without both protective orders is blocked', async () => {
  const t = setup(); t.venue.positionLots = 10; t.ledger.positionLots = 10;
  t.venue.stopAttached = true; t.venue.takeProfitAttached = false; t.venue.algoOpenOrders = 2;
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_DISAGREES');
});
test('read failure cannot produce a candidate', async () => {
  const t = setup(); t.readers.readVenue = async () => { throw Error('offline'); };
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_READ_FAILED');
});
test('unknown slot must have a matching journal', async () => {
  const t = setup(); t.state.journals[0].clientOrderId = '';
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'JOURNAL_UNVERIFIED');
  assert.equal(t.calls.venue, 0);
});
test('not UNKNOWN and multiple UNKNOWN slots are rejected before reading venue', async () => {
  for (const mutate of [t => t.state.ledger.slots[0].status = 'OPEN',
    t => t.state.ledger.slots[1].status = 'UNKNOWN']) {
    const t = setup(); mutate(t);
    const r = await t.inspect(); safe(r); assert.equal(r.code, 'UNKNOWN_SLOT_UNVERIFIED');
    assert.equal(t.calls.venue, 0);
  }
});
test('killed campaign remains blocked from slot unlock', async () => {
  const t = setup(); t.state.ledger.killed = true;
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'FLAT_REVIEW_CANDIDATE');
  assert.equal(r.slotUnlockAuthorized, false);
});
test('a single reader object cannot impersonate independent venue and ledger', async () => {
  const t = setup(); t.readers.readLedger = t.readers.readVenue;
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'READERS_UNAVAILABLE');
});

test('open evidence without matching durable journal fill is not a candidate', async () => {
  const t = setup(); t.venue.positionLots = 10; t.ledger.positionLots = 10;
  t.venue.stopAttached = true; t.venue.takeProfitAttached = true; t.venue.algoOpenOrders = 2;
  const r = await t.inspect(); safe(r); assert.equal(r.code, 'EVIDENCE_DISAGREES');
});
