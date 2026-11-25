// Pure, conservative preflight for a close attempt after a worker restart.
// This is NOT wired to a trading route: no durable store or venue order-status API
// is connected yet. A missing order ledger must never authorize another send.
export type PendingCloseState =
  | { kind: 'NONE_CONFIRMED'; positionReadOk: true; positionFound: boolean; openOrdersReadOk: true; pendingReduceOnly: false }
  | { kind: 'PENDING_OR_UNKNOWN' }
  | { kind: 'READ_FAILED' };

export type RestartCloseDecision =
  | { code: 'ALREADY_FLAT'; send: false }
  | { code: 'RECONCILE_FIRST'; send: false }
  | { code: 'NEW_CLOSE_ELIGIBLE'; send: true };

/**
 * A fresh close is eligible only after authoritative position AND pending-order
 * reads, plus a durable record proving that no earlier ambiguous close exists.
 * The caller must still acquire/fence a lease and atomically claim the attempt.
 */
export function decideRestartClose(input: {
  state: PendingCloseState;
  durablePriorAttemptCleared: boolean;
}): RestartCloseDecision {
  const { state, durablePriorAttemptCleared } = input;
  if (state.kind !== 'NONE_CONFIRMED') return { code: 'RECONCILE_FIRST', send: false };
  if (!state.positionFound) return { code: 'ALREADY_FLAT', send: false };
  if (!durablePriorAttemptCleared) return { code: 'RECONCILE_FIRST', send: false };
  return { code: 'NEW_CLOSE_ELIGIBLE', send: true };
}
