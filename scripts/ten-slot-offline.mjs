// OFFLINE-ONLY reference model. Never import this from a trading/order route.
// Ten accounting buckets do NOT imply ten concurrent exchange positions.
export const SLOT_COUNT = 10;
export const MAX_CONCURRENT = 1; // mirrors the currently supported TESTNET gate
const ACTIVE = new Set(['RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN']);
const STATES = new Set(['FREE', 'RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN', 'SPENT']);
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const blocked = code => ({ ok: false, code });

export function createOfflineLedger(campaignId, startingEquity) {
  if (typeof campaignId !== 'string' || !campaignId.trim() ||
      !Number.isFinite(startingEquity) || startingEquity <= 0) {
    throw new TypeError('valid campaignId and positive startingEquity required');
  }
  return {
    campaignId, startingEquity, version: 0, killed: false,
    slots: Array.from({ length: SLOT_COUNT }, (_, index) => ({
      index, status: 'FREE', marginBudget: startingEquity / SLOT_COUNT,
    })),
  };
}

function validLedger(s) {
  return !!s && typeof s.campaignId === 'string' && !!s.campaignId.trim() &&
    Number.isFinite(s.startingEquity) && s.startingEquity > 0 &&
    validCount(s.version) && typeof s.killed === 'boolean' &&
    Array.isArray(s.slots) && s.slots.length === SLOT_COUNT &&
    s.slots.every((slot, index) => slot && slot.index === index &&
      STATES.has(slot.status) && Number.isFinite(slot.marginBudget) &&
      slot.marginBudget === s.startingEquity / SLOT_COUNT);
}

function withSlot(s, index, status) {
  return {
    ...s, version: s.version + 1,
    slots: s.slots.map((slot, i) => i === index ? { ...slot, status } : { ...slot }),
  };
}

// Caller must atomically CAS expectedVersion in persistent storage BEFORE sending an order.
// This pure function does not acquire a lock or submit any order.
export function planOfflineClaim(s, expectedVersion, exposure) {
  if (!validLedger(s) || !validCount(expectedVersion)) return blocked('LEDGER_UNKNOWN');
  if (s.version !== expectedVersion) return blocked('STALE_VERSION');
  if (s.killed) return blocked('KILL_SWITCH');
  if (!exposure || !validCount(exposure.positions) ||
      !validCount(exposure.openOrders) || !validCount(exposure.pendingEntries)) {
    return blocked('EXPOSURE_UNKNOWN');
  }
  if (exposure.positions !== 0 || exposure.openOrders !== 0 ||
      exposure.pendingEntries !== 0) return blocked('EXPOSURE_BUSY');
  if (s.slots.some(slot => ACTIVE.has(slot.status))) return blocked('SLOT_BUSY');
  const index = s.slots.findIndex(slot => slot.status === 'FREE');
  if (index === -1) return blocked('EXHAUSTED');
  return { ok: true, code: 'CLAIM_PLANNED', index, next: withSlot(s, index, 'RESERVED') };
}

// Explicit evidence is required to mark a slot SPENT. UNKNOWN blocks new claims.
// No 'FREE' transition exists: a consumed bucket is never silently recycled.
export function advanceOfflineSlot(s, expectedVersion, index, target, evidence) {
  if (!validLedger(s) || !validCount(expectedVersion)) return blocked('LEDGER_UNKNOWN');
  if (s.version !== expectedVersion) return blocked('STALE_VERSION');
  if (!validCount(index) || index >= SLOT_COUNT) return blocked('INVALID_SLOT');
  const from = s.slots[index].status;
  const transition = from + '->' + target;
  if (transition === 'RESERVED->OPEN' && evidence?.fillConfirmed === true &&
      evidence?.ledgerMatched === true) {
    return { ok: true, code: 'FILLED', next: withSlot(s, index, 'OPEN') };
  }
  if (transition === 'OPEN->CLOSING' && evidence?.exitIntentPersisted === true) {
    return { ok: true, code: 'EXIT_PENDING', next: withSlot(s, index, 'CLOSING') };
  }
  if (['RESERVED->UNKNOWN', 'OPEN->UNKNOWN', 'CLOSING->UNKNOWN'].includes(transition)) {
    return { ok: true, code: 'RECONCILIATION_REQUIRED', next: withSlot(s, index, 'UNKNOWN') };
  }
  if (transition === 'UNKNOWN->OPEN' && evidence?.venuePositionConfirmed === true &&
      evidence?.ledgerMatched === true) {
    return { ok: true, code: 'RECONCILED_OPEN', next: withSlot(s, index, 'OPEN') };
  }
  if (['CLOSING->SPENT', 'UNKNOWN->SPENT'].includes(transition) &&
      evidence?.venueFlatConfirmed === true && evidence?.openOrdersConfirmedZero === true &&
      evidence?.ledgerMatched === true) {
    return { ok: true, code: 'CLOSED_VERIFIED', next: withSlot(s, index, 'SPENT') };
  }
  return blocked('TRANSITION_UNPROVEN');
}

export function killOfflineLedger(s, expectedVersion) {
  if (!validLedger(s) || !validCount(expectedVersion)) return blocked('LEDGER_UNKNOWN');
  if (s.version !== expectedVersion) return blocked('STALE_VERSION');
  return { ok: true, code: 'KILLED', next: { ...s, killed: true, version: s.version + 1,
    slots: s.slots.map(slot => ({ ...slot })) } };
}
