// OFFLINE-ONLY reference for one reserved slot's order lifecycle.
// Never import into production routes; these booleans are TEST EVIDENCE, not venue attestations.
// Durable intent persistence is necessary but NOT authorization to send an exchange order.
const blocked = code => ({ ok: false, code });
const PHASES = new Set(['INTENT_PENDING', 'ENTRY_PARTIAL', 'OPEN_PROTECTED', 'EXIT_PENDING', 'EXIT_PARTIAL', 'UNKNOWN', 'CLOSED']);
const validId = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 128;
const validQty = x => Number.isSafeInteger(x) && x > 0; // integer lots, never floating exchange quantities
const validJournal = s => !!s && validId(s.campaignId) && Number.isSafeInteger(s.slotIndex) && s.slotIndex >= 0 && s.slotIndex < 10 &&
  validId(s.clientOrderId) && validQty(s.requestedLots) && Number.isSafeInteger(s.version) && s.version >= 0 && s.version < Number.MAX_SAFE_INTEGER &&
  PHASES.has(s.phase) && Number.isSafeInteger(s.filledLots) && s.filledLots >= 0 && s.filledLots <= s.requestedLots &&
  Number.isSafeInteger(s.exitedLots) && s.exitedLots >= 0 && s.exitedLots <= s.filledLots &&
  Array.isArray(s.eventIds) && s.eventIds.length <= 1000 && s.eventIds.every(validId) && new Set(s.eventIds).size === s.eventIds.length &&
  (s.phase !== 'INTENT_PENDING' || (s.filledLots === 0 && s.exitedLots === 0)) &&
  (s.phase !== 'ENTRY_PARTIAL' || (s.filledLots > 0 && s.filledLots < s.requestedLots && s.exitedLots === 0)) &&
  (!['OPEN_PROTECTED','EXIT_PENDING','EXIT_PARTIAL'].includes(s.phase) || s.filledLots === s.requestedLots) &&
  (!['OPEN_PROTECTED','EXIT_PENDING'].includes(s.phase) || s.exitedLots === 0) &&
  (s.phase !== 'EXIT_PARTIAL' || (s.exitedLots > 0 && s.exitedLots < s.filledLots)) &&
  (s.phase !== 'CLOSED' || s.exitedLots === s.filledLots);

// Reuse the canonical offline journal validator for coupled-record invariants.
export const validOfflineJournal = validJournal;

function advance(s, event) {
  if (!validJournal(s)) return blocked('JOURNAL_CORRUPT');
  if (!event || !validId(event.eventId) || !validId(event.clientOrderId)) return blocked('EVENT_UNKNOWN');
  if (event.clientOrderId !== s.clientOrderId) return blocked('ORDER_MISMATCH');
  if (s.eventIds.includes(event.eventId)) return blocked('DUPLICATE_EVENT');
  if (s.phase === 'CLOSED') return blocked('ALREADY_CLOSED');
  if (s.eventIds.length >= 1000) return blocked('EVENT_CAPACITY');
  let phase = s.phase, filledLots = s.filledLots, exitedLots = s.exitedLots;
  switch (event.type) {
    case 'ENTRY_PARTIAL':
      if (!['INTENT_PENDING', 'ENTRY_PARTIAL'].includes(phase) || !Number.isSafeInteger(event.cumulativeLots) ||
          event.cumulativeLots <= filledLots || event.cumulativeLots >= s.requestedLots) return blocked('ENTRY_UNPROVEN');
      filledLots = event.cumulativeLots; phase = 'ENTRY_PARTIAL'; break;
    case 'ENTRY_PROTECTED':
      if (!['INTENT_PENDING', 'ENTRY_PARTIAL'].includes(phase) || event.cumulativeLots !== s.requestedLots ||
          event.stopAttached !== true || event.takeProfitAttached !== true ||
          event.venuePositionConfirmed !== true || event.ledgerMatched !== true) return blocked('PROTECTION_UNPROVEN');
      filledLots = s.requestedLots; phase = 'OPEN_PROTECTED'; break;
    case 'EXIT_INTENT':
      if (phase !== 'OPEN_PROTECTED' || event.exitIntentDurable !== true) return blocked('EXIT_INTENT_UNPROVEN');
      phase = 'EXIT_PENDING'; break;
    case 'EXIT_PARTIAL':
      if (!['EXIT_PENDING', 'EXIT_PARTIAL'].includes(phase) || !Number.isSafeInteger(event.cumulativeLots) ||
          event.cumulativeLots <= exitedLots || event.cumulativeLots >= filledLots) return blocked('EXIT_UNPROVEN');
      exitedLots = event.cumulativeLots; phase = 'EXIT_PARTIAL'; break;
    case 'EXIT_FLAT':
      if (!['EXIT_PENDING', 'EXIT_PARTIAL', 'UNKNOWN'].includes(phase) ||
          event.venueFlatConfirmed !== true || event.openOrdersConfirmedZero !== true || event.ledgerMatched !== true ||
          event.cumulativeLots !== filledLots) return blocked('FLAT_UNPROVEN');
      exitedLots = filledLots; phase = 'CLOSED'; break;
    case 'UNCERTAIN':
      phase = 'UNKNOWN'; break;
    case 'RECONCILE_OPEN':
      if (phase !== 'UNKNOWN' || filledLots !== s.requestedLots || exitedLots !== 0 || event.venuePositionConfirmed !== true ||
          event.ledgerMatched !== true || event.stopAttached !== true || event.takeProfitAttached !== true) return blocked('RECONCILIATION_UNPROVEN');
      phase = 'OPEN_PROTECTED'; break;
    default: return blocked('EVENT_UNKNOWN');
  }
  return { ok: true, code: phase, next: { ...s, phase, filledLots, exitedLots,
    version: s.version + 1, eventIds: [...s.eventIds, event.eventId] } };
}

export function planOfflineLifecycleEvent(s, expectedVersion, event) {
  if (!validJournal(s)) return blocked('JOURNAL_CORRUPT');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== s.version) return blocked('STALE_VERSION');
  return advance(s, event);
}

export async function persistOfflineEntryIntent(store, reservation, clientOrderId, requestedLots) {
  if (!store || typeof store.read !== 'function' || typeof store.insertIfAbsent !== 'function') return blocked('STORE_UNAVAILABLE');
  // A reservation proof is only a local model input. Never use it to authorize an actual order.
  if (!reservation || reservation.durable !== true || reservation.killed !== false || !validId(reservation.campaignId) ||
      !Number.isSafeInteger(reservation.slotIndex) || reservation.slotIndex < 0 || reservation.slotIndex >= 10 ||
      !Number.isSafeInteger(reservation.ledgerVersion) || reservation.ledgerVersion < 1 ||
      !validId(clientOrderId) || !validQty(requestedLots)) return blocked('RESERVATION_UNPROVEN');
  const next = { campaignId: reservation.campaignId, slotIndex: reservation.slotIndex,
    clientOrderId, requestedLots, filledLots: 0, exitedLots: 0, phase: 'INTENT_PENDING', version: 0, eventIds: [] };
  try {
    const current = await store.read(reservation.campaignId);
    if (current) return blocked(current.clientOrderId === clientOrderId ? 'INTENT_ALREADY_EXISTS' : 'INTENT_CONFLICT');
    const committed = await store.insertIfAbsent(reservation.campaignId, next);
    if (committed !== true) return blocked(committed === false ? 'INTENT_CONFLICT' : 'STORE_UNAVAILABLE');
    return { ok: true, code: 'INTENT_DURABLE', clientOrderId };
  } catch { return blocked('STORE_UNAVAILABLE'); }
}

export async function persistOfflineLifecycleEvent(store, campaignId, event) {
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSwap !== 'function' || !validId(campaignId)) return blocked('STORE_UNAVAILABLE');
  try {
    const s = await store.read(campaignId);
    if (!s) return blocked('INTENT_MISSING');
    if (s.campaignId !== campaignId) return blocked('CAMPAIGN_MISMATCH');
    const planned = planOfflineLifecycleEvent(s, s.version, event);
    if (!planned.ok) return planned;
    const committed = await store.compareAndSwap(campaignId, s.version, planned.next);
    if (committed !== true) return blocked(committed === false ? 'CAS_LOST' : 'STORE_UNAVAILABLE');
    return { ok: true, code: planned.code, version: planned.next.version };
  } catch { return blocked('STORE_UNAVAILABLE'); }
}
