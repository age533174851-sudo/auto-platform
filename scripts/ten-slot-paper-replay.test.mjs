// This suite tests a *synthetic* in-memory replay, not real testnet orders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTenSlotPaperReplay } from './ten-slot-paper-replay.mjs';

test('10 distinct synthetic slots open+protect+exit+close in order, max one position', async () => {
  const r = await runTenSlotPaperReplay();
  assert.equal(r.kind, 'SYNTHETIC_OFFLINE_FAKE_DB_FAKE_VENUE');
  assert.equal(r.actualExchangeOrders, 0);
  assert.equal(r.actualProductionDbWrites, 0);
  assert.equal(r.completedRoundTrips, 10);
  assert.equal(r.closedSlots, 10);
  assert.equal(r.unknownSlots, 0);
  assert.equal(r.freeSlots, 0);
  assert.equal(r.maxConcurrentFakePositions, 1);
  assert.equal(r.fakeOrderRequests, 20);
  assert.deepEqual(r.trades.map(t => t.slotIndex), [0,1,2,3,4,5,6,7,8,9]);
  assert.equal(new Set(r.trades.map(t => t.entryOrderId)).size, 10);
  assert.equal(new Set(r.trades.map(t => t.exitOrderId)).size, 10);
  assert(r.trades.every(t => t.slotStatus === 'SPENT'));
  assert(r.trades.every(t => t.stopOrderId && t.takeProfitOrderId));
  assert(r.trades.every(t => t.leverage >= 10 && t.leverage <= 75));
  assert(r.trades.some(t => t.netPnlUsd < 0), 'synthetic failures/losses must appear in the journal');
  assert(r.trades.some(t => t.netPnlUsd > 0));
  assert(Math.abs(r.finalEquityUsd - (r.initialEquityUsd +
    r.trades.reduce((s,t) => s+t.netPnlUsd, 0))) < 1e-8);
});

test('synthetic fills, PnL and fees are deterministic and auditable', async () => {
  const first = await runTenSlotPaperReplay();
  assert.deepEqual(await runTenSlotPaperReplay(), first);
  for (const t of first.trades) {
    assert(t.entryPrice > 0 && t.exitPrice > 0 && t.marginUsd > 0);
    assert(t.feesUsd > 0);
    const dir = t.side === 'LONG' ? 1 : -1;
    const qty = t.marginUsd * t.leverage / t.entryPrice;
    const gross = dir * (t.exitPrice - t.entryPrice) * qty;
    assert(Math.abs(gross - t.grossPnlUsd) < 1e-9);
    assert(Math.abs(t.grossPnlUsd - t.feesUsd - t.netPnlUsd) < 1e-9);
  }
});

test('missing protective evidence stops replay, persists UNKNOWN, never opens later slots', async () => {
  const r = await runTenSlotPaperReplay({ faultAtSlot: 4 });
  assert.equal(r.completedRoundTrips, 4);
  assert.equal(r.closedSlots, 4);
  assert.equal(r.unknownSlots, 1);
  assert.equal(r.freeSlots, 5);
  assert.equal(r.failure.code, 'PROTECTION_UNVERIFIED');
  assert.equal(r.failure.slotIndex, 4);
  assert.equal(r.failure.nextClaimBlocked, 'SLOT_BUSY');
  assert.equal(r.fakeOrderRequests, 9);
  assert.equal(r.actualExchangeOrders, 0);
});

test('invalid synthetic equity or injected fault indices rejected', async () => {
  for (const initialEquity of [0,-1,NaN,Infinity]) {
    await assert.rejects(runTenSlotPaperReplay({ initialEquity }), TypeError);
  }
  for (const faultAtSlot of [-1,10,NaN,0.5]) {
    await assert.rejects(runTenSlotPaperReplay({ faultAtSlot }), TypeError);
  }
});
