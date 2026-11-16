// OFFLINE-ONLY coupled FakeDB reference. No real venue, DB, or order side effects.
// A durable accounting reservation and order intent MUST share one atomic CAS;
// this model does not authorize sending an exchange order.
import { createOfflineLedger, planOfflineClaim, advanceOfflineSlot, killOfflineLedger } from './ten-slot-offline.mjs';
import { planOfflineLifecycleEvent, validOfflineJournal } from './ten-slot-lifecycle-offline.mjs';

const blocked = code => ({ ok: false, code });
const ZERO = Object.freeze({ positions: 0, openOrders: 0, pendingEntries: 0 });
const ACTIVE = new Set(['RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN']);
const validId = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 128;
const validVersion = n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER;
const validLots = n => Number.isSafeInteger(n) && n > 0;
const PHASE_FOR_SLOT = {
  RESERVED: new Set(['INTENT_PENDING', 'ENTRY_PARTIAL']),
  OPEN: new Set(['OPEN_PROTECTED']),
  CLOSING: new Set(['EXIT_PENDING', 'EXIT_PARTIAL']),
  UNKNOWN: new Set(['UNKNOWN']),
  SPENT: new Set(['CLOSED']),
};

export function createCoupledOfflineCampaign(campaignId, equity) {
  const ledger = createOfflineLedger(campaignId, equity);
  return { campaignId, version: 0, ledger, journals: Array(10).fill(null) };
}

// A broken cross-record snapshot is never repaired by silently trusting either record.
export function validCoupledOfflineSnapshot(s) {
  if (!s || !validId(s.campaignId) || !validVersion(s.version) ||
      !s.ledger || s.ledger.campaignId !== s.campaignId || !validVersion(s.ledger.version) ||
      // Every ledger CAS is accompanied by exactly one envelope CAS.
      s.ledger.version > s.version ||
      !Array.isArray(s.journals) || s.journals.length !== 10) return false;
  if (planOfflineClaim(s.ledger, s.ledger.version, ZERO).code === 'LEDGER_UNKNOWN') return false;
  const ids = new Set();
  return s.ledger.slots.every((slot, i) => {
    const journal = s.journals[i];
    if (slot.status === 'FREE') return journal === null;
    // A journal is created in an envelope CAS before its first event increments it.
    if (!validOfflineJournal(journal) || journal.version >= s.version ||
        journal.campaignId !== s.campaignId || journal.slotIndex !== i ||
        !PHASE_FOR_SLOT[slot.status]?.has(journal.phase) || ids.has(journal.clientOrderId)) return false;
    ids.add(journal.clientOrderId);
    return true;
  });
}

async function load(store, campaignId) {
  if (!validId(campaignId) || !store || typeof store.read !== 'function' ||
      typeof store.compareAndSwap !== 'function') return blocked('STORE_UNAVAILABLE');
  try {
    const s = await store.read(campaignId);
    if (!s) return blocked('CAMPAIGN_MISSING');
    if (s.campaignId !== campaignId) return blocked('CAMPAIGN_MISMATCH');
    if (!validCoupledOfflineSnapshot(s)) return blocked('COUPLING_CORRUPT');
    return { ok: true, snapshot: s };
  } catch { return blocked('STORE_UNAVAILABLE'); }
}

async function save(store, before, next, code, extra = {}) {
  if (!validCoupledOfflineSnapshot(next) || next.version !== before.version + 1) return blocked('COUPLING_CORRUPT');
  try {
    // compareAndSwap is a single durable transaction over BOTH ledger and journals.
    // An ambiguous success must never cause a retry of any hypothetical order.
    const written = await store.compareAndSwap(before.campaignId, before.version, next);
    if (written !== true) return blocked(written === false ? 'CAS_LOST' : 'STORE_UNAVAILABLE');
    return { ok: true, code, version: next.version, ...extra };
  } catch { return blocked('STORE_UNAVAILABLE'); }
}

export async function claimAndIntentCoupledOffline(store, campaignId, exposure, clientOrderId, requestedLots) {
  const read = await load(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  if (!validId(clientOrderId) || !validLots(requestedLots)) return blocked('INTENT_INVALID');
  if (s.journals.some(j => j?.clientOrderId === clientOrderId)) return blocked('ORDER_ID_REUSED');
  const planned = planOfflineClaim(s.ledger, s.ledger.version, exposure);
  if (!planned.ok) return planned;
  const index = planned.index;
  const journal = { campaignId, slotIndex: index, clientOrderId, requestedLots,
    filledLots: 0, exitedLots: 0, phase: 'INTENT_PENDING', version: 0, eventIds: [] };
  const next = { ...s, version: s.version + 1, ledger: planned.next,
    journals: s.journals.map((j, i) => i === index ? journal : j) };
  return save(store, s, next, 'RESERVATION_AND_INTENT_DURABLE', { index, clientOrderId });
}

export async function applyCoupledOfflineEvent(store, campaignId, event) {
  const read = await load(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  const index = s.ledger.slots.findIndex(slot => ACTIVE.has(slot.status));
  if (index === -1) return blocked('NO_ACTIVE_SLOT');
  const journal = s.journals[index];
  const planned = planOfflineLifecycleEvent(journal, journal.version, event);
  if (!planned.ok) return planned;
  let ledger = s.ledger;
  const transition = {
    ENTRY_PROTECTED: ['OPEN', { fillConfirmed: true, ledgerMatched: event.ledgerMatched === true }],
    EXIT_INTENT: ['CLOSING', { exitIntentPersisted: event.exitIntentDurable === true }],
    EXIT_FLAT: ['SPENT', { venueFlatConfirmed: event.venueFlatConfirmed === true,
      openOrdersConfirmedZero: event.openOrdersConfirmedZero === true, ledgerMatched: event.ledgerMatched === true }],
    UNCERTAIN: ['UNKNOWN', {}],
    RECONCILE_OPEN: ['OPEN', { venuePositionConfirmed: event.venuePositionConfirmed === true,
      ledgerMatched: event.ledgerMatched === true }],
  }[event.type];
  if (transition && !(event.type === 'UNCERTAIN' && s.ledger.slots[index].status === 'UNKNOWN')) {
    const move = advanceOfflineSlot(s.ledger, s.ledger.version, index, ...transition);
    if (!move.ok) return move;
    ledger = move.next;
  }
  const next = { ...s, version: s.version + 1, ledger,
    journals: s.journals.map((j, i) => i === index ? planned.next : j) };
  return save(store, s, next, 'EVENT_AND_LEDGER_DURABLE', { phase: planned.next.phase, index });
}

export async function resumeCoupledOffline(store, campaignId) {
  const read = await load(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  const index = s.ledger.slots.findIndex(slot => ACTIVE.has(slot.status));
  if (index === -1) return { ok: true, code: 'LEDGER_IDLE_ONLY', version: s.version };
  if (s.ledger.slots[index].status === 'UNKNOWN') return blocked('RECONCILIATION_REQUIRED');
  const journal = s.journals[index];
  const event = { eventId: 'restart-' + s.version, clientOrderId: journal.clientOrderId, type: 'UNCERTAIN' };
  const j = planOfflineLifecycleEvent(journal, journal.version, event);
  if (!j.ok) return j;
  const move = advanceOfflineSlot(s.ledger, s.ledger.version, index, 'UNKNOWN');
  if (!move.ok) return move;
  const next = { ...s, version: s.version + 1, ledger: move.next,
    journals: s.journals.map((v, i) => i === index ? j.next : v) };
  const saved = await save(store, s, next, 'RECONCILIATION_REQUIRED');
  return saved.ok ? { ...saved, ok: false, persisted: true } : saved;
}

export async function killCoupledOffline(store, campaignId) {
  const read = await load(store, campaignId);
  if (!read.ok) return read;
  const s = read.snapshot;
  const planned = killOfflineLedger(s.ledger, s.ledger.version);
  if (!planned.ok) return planned;
  return save(store, s, { ...s, version: s.version + 1, ledger: planned.next }, 'KILL_PERSISTED');
}
