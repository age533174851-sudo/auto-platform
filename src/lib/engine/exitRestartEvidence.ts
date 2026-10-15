// Issue #325: read-only evidence collection for a restart after an ambiguous exit.
// No database writes and no order placement. The original clientOrderId is mandatory.
import { classifyExitRestart, type ExitIntentState, type ExitOrderState,
  type ExitReconcileVerdict } from './exitRestartReconcile';

export interface DurableExitIntent {
  clientOrderId: string | null;
  state: ExitIntentState;
}

export interface ExitRestartReads {
  /** Read persisted intent from durable storage, never from process memory. */
  loadIntent: () => Promise<DurableExitIntent | null>;
  /** Read current exchange position; found=false is valid ONLY on successful read. */
  readPosition: () => Promise<{ ok: boolean; found: boolean }>;
  /** Query the exchange using the exact persisted clientOrderId. */
  readOrder: (clientOrderId: string) => Promise<{ ok: boolean; state: ExitOrderState }>;
}

/** A missing intent is UNKNOWN, not proof that no order was sent. */
export async function reconcileExitRestartReadOnly(
  reads: ExitRestartReads,
): Promise<ExitReconcileVerdict> {
  let intent: DurableExitIntent | null;
  try { intent = await reads.loadIntent(); }
  catch { intent = null; }
  // Missing durable record must fail closed; never reconstruct a new order ID.
  if (!intent || !intent.clientOrderId?.trim() || intent.state === 'NONE')
    return classifyExitRestart({
      intent: undefined, position: { ok: false, found: false }, order: null,
    });

  let position: { ok: boolean; found: boolean };
  try { position = await reads.readPosition(); }
  catch { position = { ok: false, found: false }; }
  if (!position?.ok)
    return classifyExitRestart({ intent: intent.state, position: { ok: false, found: false }, order: null });

  let order: { ok: boolean; state: ExitOrderState };
  try { order = await reads.readOrder(intent.clientOrderId); }
  catch { order = { ok: false, state: 'UNKNOWN' }; }
  return classifyExitRestart({ intent: intent.state, position, order });
}
