// Issue #325: fail-closed dispatch gate for a durable exit intent.
// This is a pure coordination seam, NOT production wiring. No venue calls occur here.
import { reconcileExitRestartReadOnly, type ExitRestartReads } from './exitRestartEvidence';
import type { ExitReconcileVerdict } from './exitRestartReconcile';

export type ExitDispatchGate =
  | { code: 'NO_DURABLE_INTENT'; maySend: false; verdict: ExitReconcileVerdict }
  | { code: 'RECONCILE_REQUIRED'; maySend: false; verdict: ExitReconcileVerdict }
  | { code: 'ALREADY_FLAT'; maySend: false; verdict: ExitReconcileVerdict };

/**
 * Existing ambiguous close intents MUST be reconciled before any new send.
 * This function intentionally never authorizes a send, including when no
 * durable intent is found: a missing record may mean an unavailable store.
 * The future write-ahead creation path must separately prove atomic ownership.
 */
export async function gateRestartExitDispatch(
  reads: ExitRestartReads,
): Promise<ExitDispatchGate> {
  const verdict = await reconcileExitRestartReadOnly(reads);
  if (verdict.code === 'FLAT_VERIFIED')
    return { code: 'ALREADY_FLAT', maySend: false, verdict };
  if (verdict.code === 'NO_INTENT' || verdict.code === 'READ_FAILED')
    return { code: 'NO_DURABLE_INTENT', maySend: false, verdict };
  return { code: 'RECONCILE_REQUIRED', maySend: false, verdict };
}
