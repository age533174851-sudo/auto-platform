// OFFLINE-ONLY read-only evidence gate for an UNKNOWN ten-slot campaign.
// Two independently read observations are candidates for human/reconciler review,
// NEVER an order-send permit, a flat attestation, or a slot-unlock command.
const blocked = code => ({ ok: false, code, orderSendAuthorized: false, slotUnlockAuthorized: false });
const id = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 128;
const count = x => Number.isSafeInteger(x) && x >= 0;
const ageValid = (observedAt, nowMs, maxAgeMs) =>
  Number.isSafeInteger(observedAt) && observedAt > 0 && observedAt <= nowMs &&
  nowMs - observedAt <= maxAgeMs;
const candidate = (code, index, clientOrderId) => ({ ...blocked(code),
  index, clientOrderId, reviewRequired: true });

// Readers must be separate read-only adapters: readCampaign, readVenue, readLedger.
// Their source tags are contract assertions, NOT cryptographic source proof.
export async function inspectUnknownCoupledOffline(readers, campaignId, nowMs, maxAgeMs = 60_000) {
  if (!id(campaignId) || !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60_000 ||
      !readers || typeof readers.readCampaign !== 'function' ||
      typeof readers.readVenue !== 'function' || typeof readers.readLedger !== 'function' ||
      readers.readVenue === readers.readLedger) return blocked('READERS_UNAVAILABLE');

  let snapshot;
  try { snapshot = await readers.readCampaign(campaignId); }
  catch { return blocked('CAMPAIGN_READ_FAILED'); }
  if (!snapshot || snapshot.campaignId !== campaignId ||
      !Array.isArray(snapshot.ledger?.slots) || snapshot.ledger.slots.length !== 10 ||
      !Array.isArray(snapshot.journals) || snapshot.journals.length !== 10 ||
      snapshot.ledger.killed !== false && snapshot.ledger.killed !== true) {
    return blocked('CAMPAIGN_UNVERIFIED');
  }
  const unknowns = snapshot.ledger.slots.flatMap((s, i) => s?.status === 'UNKNOWN' ? [i] : []);
  if (unknowns.length !== 1) return blocked('UNKNOWN_SLOT_UNVERIFIED');
  const index = unknowns[0];
  const journal = snapshot.journals[index];
  if (!journal || journal.phase !== 'UNKNOWN' || journal.slotIndex !== index ||
      journal.campaignId !== campaignId || !id(journal.clientOrderId) ||
      !count(journal.filledLots) || !count(journal.exitedLots) ||
      !count(journal.requestedLots) || journal.requestedLots === 0 ||
      journal.filledLots > journal.requestedLots || journal.exitedLots > journal.filledLots) {
    return blocked('JOURNAL_UNVERIFIED');
  }
  // A killed campaign may be reconciled for accounting, but this never re-enables it.
  let venue, ledger;
  try {
    [venue, ledger] = await Promise.all([
      readers.readVenue(journal.clientOrderId), readers.readLedger(journal.clientOrderId),
    ]);
  } catch { return blocked('EVIDENCE_READ_FAILED'); }
  if (!venue || !ledger || venue.source !== 'VENUE' || ledger.source !== 'LEDGER' ||
      venue.clientOrderId !== journal.clientOrderId ||
      ledger.clientOrderId !== journal.clientOrderId ||
      !ageValid(venue.observedAt, nowMs, maxAgeMs) ||
      !ageValid(ledger.observedAt, nowMs, maxAgeMs) ||
      !id(venue.observationId) || !id(ledger.observationId) ||
      venue.observationId === ledger.observationId) return blocked('EVIDENCE_UNVERIFIED');
  if (![venue.positionLots, venue.regularOpenOrders, venue.algoOpenOrders,
        venue.pendingEntries, ledger.positionLots, ledger.pendingIntents].every(count)) {
    return blocked('EVIDENCE_MALFORMED');
  }
  // Nonzero conditional Algo orders mean venue is NOT flat even when position is zero.
  if (venue.positionLots === 0 && ledger.positionLots === 0 &&
      venue.regularOpenOrders === 0 && venue.algoOpenOrders === 0 &&
      venue.pendingEntries === 0 && ledger.pendingIntents === 0) {
    // A filled trade needs independently confirmed exit quantities before even
    // becoming a candidate. The offline journal alone is insufficient proof.
    if (journal.filledLots > 0 &&
        (venue.exitedLots !== journal.filledLots ||
         ledger.exitedLots !== journal.filledLots)) return blocked('EXIT_EVIDENCE_MISSING');
    return candidate('FLAT_REVIEW_CANDIDATE', index, journal.clientOrderId);
  }
  if (journal.filledLots === journal.requestedLots && journal.exitedLots === 0 &&
      venue.positionLots === journal.requestedLots &&
      ledger.positionLots === journal.requestedLots &&
      venue.regularOpenOrders === 0 && venue.pendingEntries === 0 &&
      venue.stopAttached === true && venue.takeProfitAttached === true &&
      venue.algoOpenOrders >= 2) {
    return candidate('OPEN_REVIEW_CANDIDATE', index, journal.clientOrderId);
  }
  return blocked('EVIDENCE_DISAGREES');
}
