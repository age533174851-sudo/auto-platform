// Issue #325: pure durable-close state transition contract.
// This is intentionally NOT wired to a live DB or exchange.
export type CloseAttemptStatus =
  | 'PREPARED' | 'SUBMIT_UNKNOWN' | 'ACCEPTED' | 'PARTIAL'
  | 'NEEDS_RECONCILE' | 'FLAT_VERIFIED' | 'REJECTED_CONFIRMED';

export type CloseAttemptEvidence =
  | { kind: 'SUBMIT_TIMEOUT' }
  | { kind: 'SUBMIT_ACCEPTED' }
  | { kind: 'SUBMIT_REJECTED_CONFIRMED' }
  | { kind: 'POSITION_READ_FAILED' }
  | { kind: 'POSITION_PARTIAL'; pendingOrderResolved: boolean }
  | { kind: 'POSITION_FLAT'; pendingOrderResolved: boolean };

export interface CloseAttemptSnapshot {
  status: CloseAttemptStatus;
  /** Never infer this from position flat alone. */
  orderTerminalConfirmed: boolean;
}

export interface CloseAttemptTransition {
  next: CloseAttemptSnapshot;
  mayClearDurableAttempt: boolean;
}

/**
 * A terminal exchange-order proof and a verified flat position are both
 * required to clear an attempt. Position read alone cannot prove that an
 * accepted but still-pending reduce-only order has ceased to exist.
 */
export function advanceCloseAttempt(
  previous: CloseAttemptSnapshot,
  evidence: CloseAttemptEvidence,
): CloseAttemptTransition {
  if (previous.status === 'FLAT_VERIFIED' && previous.orderTerminalConfirmed) {
    return { next: previous, mayClearDurableAttempt: true };
  }
  if (previous.status === 'REJECTED_CONFIRMED' && previous.orderTerminalConfirmed) {
    return { next: previous, mayClearDurableAttempt: true };
  }
  switch (evidence.kind) {
    case 'SUBMIT_TIMEOUT':
      return { next: { status: 'SUBMIT_UNKNOWN', orderTerminalConfirmed: false },
        mayClearDurableAttempt: false };
    case 'SUBMIT_ACCEPTED':
      return { next: { status: 'ACCEPTED', orderTerminalConfirmed: false },
        mayClearDurableAttempt: false };
    case 'SUBMIT_REJECTED_CONFIRMED':
      return { next: { status: 'REJECTED_CONFIRMED', orderTerminalConfirmed: true },
        mayClearDurableAttempt: true };
    case 'POSITION_READ_FAILED':
      return { next: { status: 'NEEDS_RECONCILE', orderTerminalConfirmed: false },
        mayClearDurableAttempt: false };
    case 'POSITION_PARTIAL':
      return { next: { status: evidence.pendingOrderResolved ? 'PARTIAL' : 'NEEDS_RECONCILE',
        orderTerminalConfirmed: evidence.pendingOrderResolved }, mayClearDurableAttempt: false };
    case 'POSITION_FLAT':
      return { next: { status: evidence.pendingOrderResolved ? 'FLAT_VERIFIED' : 'NEEDS_RECONCILE',
        orderTerminalConfirmed: evidence.pendingOrderResolved },
        mayClearDurableAttempt: evidence.pendingOrderResolved };
  }
}
