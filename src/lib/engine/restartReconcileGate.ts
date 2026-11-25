// A testable, non-operational restart reconciliation gate.
// All dependencies must be backed by authoritative venue reads and a durable,
// atomic attempt ledger before any production route may use this module.
// This function NEVER sends an exchange order.
import { decideRestartClose, type PendingCloseState } from './restartClosePreflight';

export type DurableAttempt =
  | { code: 'CLEAR'; lastClientOrderId: string | null }
  | { code: 'PENDING'; lastClientOrderId: string | null }
  | { code: 'UNKNOWN'; lastClientOrderId: string | null };

export interface RestartReconcileDeps {
  /** Must be durable across process restarts; failures fail closed. */
  readAttempt(): Promise<DurableAttempt>;
  /** Exchange position and all relevant pending reduce-only orders. */
  readVenue(): Promise<PendingCloseState>;
  /**
   * Atomic, fenced compare-and-set claim. A false result means another worker
   * may already have acquired the right to send. Do not retry in this cycle.
   */
  claimNextAttempt(): Promise<boolean>;
}

export type RestartReconcileResult =
  | { code: 'RECONCILE_FIRST' | 'ALREADY_FLAT' | 'CLAIM_FAILED'; maySend: false }
  | { code: 'CLAIMED'; maySend: true };

/**
 * Eligibility is not permission to submit until a durable atomic claim succeeds.
 * The caller must ALSO revalidate the lease fence immediately before sending.
 */
export async function reconcileBeforeRestartClose(
  deps: RestartReconcileDeps,
): Promise<RestartReconcileResult> {
  let attempt: DurableAttempt;
  let venue: PendingCloseState;
  try {
    // Do not issue parallel reads: a durable UNKNOWN blocks venue reads too.
    attempt = await deps.readAttempt();
    if (attempt.code !== 'CLEAR') return { code: 'RECONCILE_FIRST', maySend: false };
    venue = await deps.readVenue();
  } catch {
    return { code: 'RECONCILE_FIRST', maySend: false };
  }
  const decision = decideRestartClose({
    state: venue,
    durablePriorAttemptCleared: attempt.code === 'CLEAR',
  });
  if (decision.code === 'ALREADY_FLAT') return { code: 'ALREADY_FLAT', maySend: false };
  if (!decision.send) return { code: 'RECONCILE_FIRST', maySend: false };
  try {
    if (await deps.claimNextAttempt()) return { code: 'CLAIMED', maySend: true };
  } catch { /* unknown claim outcome must not authorize a second send */ }
  return { code: 'CLAIM_FAILED', maySend: false };
}
