// Issue #325: durable exit intent storage contract (no production wiring).
// A SELECT-then-INSERT is not atomic: the store implementation MUST enforce
// uniqueness and ownership in a single DB transaction/constraint.
import type { ExitIntentState } from './exitRestartReconcile';

export interface ExitIntentRecord {
  clientOrderId: string;
  connectionId: string;
  symbol: string;
  state: ExitIntentState;
  ownerToken: string;
}

export type ClaimExitIntentResult =
  | { code: 'CLAIMED'; record: ExitIntentRecord }
  | { code: 'EXISTS'; record: ExitIntentRecord }
  | { code: 'UNAVAILABLE'; record: null };

export interface ExitIntentStore {
  /**
   * Atomically claim a UNIQUE clientOrderId before any venue order.
   * Exactly one concurrent caller may receive CLAIMED.
   * EXISTS is NOT permission to resend an order.
   */
  claim: (intent: ExitIntentRecord) => Promise<ClaimExitIntentResult>;
}

/**
 * Fail-closed adapter for a future DB-backed atomic claim.
 * The returned permit is ephemeral and granted only on an explicit CLAIMED.
 * Never infer ownership from EXISTS, a missing row, or an exception.
 */
export async function claimExitBeforeSend(
  store: ExitIntentStore,
  intent: ExitIntentRecord,
): Promise<{ maySend: boolean; code: ClaimExitIntentResult['code'] }> {
  if (!intent.clientOrderId.trim() || !intent.connectionId.trim()
    || !intent.symbol.trim() || !intent.ownerToken.trim()
    || intent.state !== 'SENT')
    return { maySend: false, code: 'UNAVAILABLE' };
  try {
    const result = await store.claim(intent);
    if (result.code === 'CLAIMED'
      && result.record.clientOrderId === intent.clientOrderId
      && result.record.connectionId === intent.connectionId
      && result.record.symbol === intent.symbol
      && result.record.ownerToken === intent.ownerToken
      && result.record.state === 'SENT')
      return { maySend: true, code: 'CLAIMED' };
    return { maySend: false, code: result.code };
  } catch {
    return { maySend: false, code: 'UNAVAILABLE' };
  }
}
