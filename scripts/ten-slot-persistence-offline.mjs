// OFFLINE-ONLY CAS/restart reference. No real DB client, venue client, or order submission.
// A successful plan is NOT an order authorization: durable CAS must succeed first.
import { planOfflineClaim, advanceOfflineSlot, killOfflineLedger } from './ten-slot-offline.mjs';

const blocked = code => ({ ok: false, code });
const EMPTY_EXPOSURE = Object.freeze({ positions: 0, openOrders: 0, pendingEntries: 0 });
const ACTIVE = new Set(['RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN']);

async function readLedger(store, campaignId) {
  if (typeof campaignId !== 'string' || !campaignId.trim()) return blocked('CAMPAIGN_UNKNOWN');
  if (!store || typeof store.read !== 'function' ||
      typeof store.compareAndSwap !== 'function') return blocked('STORE_UNAVAILABLE');
  try {
    const snapshot = await store.read(campaignId);
    if (!snapshot) return blocked('LEDGER_MISSING');
    if (snapshot.campaignId !== campaignId) return blocked('CAMPAIGN_MISMATCH');
    return { ok: true, snapshot };
  } catch {
    return blocked('STORE_UNAVAILABLE');
  }
}

async function persist(store, before, next) {
  try {
    // compareAndSwap must be atomic/durable and must scope by campaign ID + version.
    // No network/order side effect is performed here, including on ambiguous errors.
    const committed = await store.compareAndSwap(before.campaignId, before.version, next);
    if (committed === false) return blocked('CAS_LOST');
    if (committed !== true) return blocked('STORE_UNAVAILABLE');
    return { ok: true, code: 'PERSISTED', version: next.version };
  } catch {
    return blocked('STORE_UNAVAILABLE');
  }
}

// Never place an order until the RESERVED snapshot has been durably CAS-committed.
export async function claimPersistedOffline(store, campaignId, exposure) {
  const read = await readLedger(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  const planned = planOfflineClaim(s, s.version, exposure);
  if (!planned.ok) return planned;
  const committed = await persist(store, s, planned.next);
  return committed.ok
    ? { ok: true, code: 'RESERVATION_DURABLE', index: planned.index, version: committed.version }
    : committed;
}

// Re-read on every transition: stale events cannot overwrite a newer snapshot.
export async function advancePersistedOffline(store, campaignId, index, target, evidence) {
  const read = await readLedger(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  const planned = advanceOfflineSlot(s, s.version, index, target, evidence);
  if (!planned.ok) return planned;
  const committed = await persist(store, s, planned.next);
  return committed.ok ? { ...committed, code: planned.code } : committed;
}

// Restart is deliberately conservative: any in-flight slot becomes UNKNOWN.
// UNKNOWN can only be resolved by explicit independent venue/ledger evidence.
// An idle ledger is not proof that the exchange is flat: future claims still
// require fresh exposure evidence through claimPersistedOffline.
export async function resumePersistedOffline(store, campaignId) {
  const read = await readLedger(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  if (!Array.isArray(s.slots)) return blocked('LEDGER_UNKNOWN');
  const active = s.slots.findIndex(slot => ACTIVE.has(slot?.status));
  if (active === -1) {
    // Reuse the canonical ledger validator, without persisting a planned claim.
    const checked = planOfflineClaim(s, s.version, EMPTY_EXPOSURE);
    if (checked.code === 'LEDGER_UNKNOWN') return checked;
    return { ok: true, code: 'LEDGER_IDLE_ONLY', version: s.version };
  }
  if (s.slots[active].status === 'UNKNOWN') {
    const checked = advanceOfflineSlot(s, s.version, active, 'UNKNOWN');
    if (checked.code === 'LEDGER_UNKNOWN') return checked;
    return blocked('RECONCILIATION_REQUIRED');
  }
  const planned = advanceOfflineSlot(s, s.version, active, 'UNKNOWN');
  if (!planned.ok) return planned;
  const committed = await persist(store, s, planned.next);
  return committed.ok
    ? { ok: false, code: 'RECONCILIATION_REQUIRED', persisted: true, version: committed.version }
    : committed;
}

export async function killPersistedOffline(store, campaignId) {
  const read = await readLedger(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  const planned = killOfflineLedger(s, s.version);
  if (!planned.ok) return planned;
  const committed = await persist(store, s, planned.next);
  return committed.ok ? { ...committed, code: 'KILL_PERSISTED' } : committed;
}
