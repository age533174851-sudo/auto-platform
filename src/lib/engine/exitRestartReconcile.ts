// Issue #325: read-only restart reconciliation decision.
// This module NEVER sends an order. In particular, an open position alone
// does not prove that an earlier close request is no longer pending.
export type ExitIntentState = 'NONE' | 'SENT' | 'UNKNOWN' | 'ACCEPTED' | 'REJECTED' | 'FILLED';
export type ExitOrderState = 'UNKNOWN' | 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'NOT_FOUND';
export type ExitReconcileCode = 'NO_INTENT' | 'READ_FAILED' | 'ORDER_UNRESOLVED' | 'POSITION_OPEN' | 'FLAT_VERIFIED';

export interface ExitReconcileEvidence {
  /** Durable record read from storage; undefined means storage could not be read. */
  intent: ExitIntentState | undefined;
  /** Must be a fresh, successful venue position read, not a cached ledger value. */
  position: { ok: boolean; found: boolean };
  /** Venue order lookup using the original clientOrderId. */
  order: { ok: boolean; state: ExitOrderState } | null;
}

export interface ExitReconcileVerdict {
  code: ExitReconcileCode;
  /** No order is ever authorized by this read-only classifier. */
  mayResend: false;
  /** Closing the ledger requires confirmed flat AND no unresolved order. */
  mayMarkClosed: boolean;
  needsReconcile: boolean;
}

export function classifyExitRestart(e: ExitReconcileEvidence): ExitReconcileVerdict {
  const result = (code: ExitReconcileCode, mayMarkClosed = false): ExitReconcileVerdict =>
    ({ code, mayResend: false, mayMarkClosed, needsReconcile: code !== 'NO_INTENT' && !mayMarkClosed });
  if (e.intent === undefined || !e.position?.ok) return result('READ_FAILED');
  if (e.intent === 'NONE') return result('NO_INTENT');
  // A missing order lookup or NOT_FOUND is not proof of non-submission:
  // eventual consistency and clientOrderId lookup gaps are possible.
  if (!e.order?.ok || e.order.state === 'UNKNOWN' || e.order.state === 'NOT_FOUND')
    return result('ORDER_UNRESOLVED');
  if (e.order.state === 'OPEN' || e.order.state === 'PARTIAL')
    return result('ORDER_UNRESOLVED');
  if (e.position.found) return result('POSITION_OPEN');
  return result('FLAT_VERIFIED', true);
}
