// Issue #325: Supabase-backed TESTNET-only exit-intent write-ahead store.
// No runtime route uses this module yet. It does not send an order.
// Supabase service_role belongs only on trusted server-side call sites.
import type {
  ExitIntentStore, ExitIntentRecord, ClaimExitIntentResult,
} from './exitRestartIntentStore';
import type { DurableExitIntent } from './exitRestartEvidence';
import type { ExitIntentState } from './exitRestartReconcile';

export const EXIT_ORDER_INTENT_TABLE = 'exit_order_intents';

export interface TestnetExitIntentStore extends ExitIntentStore {
  /** Read evidence, never generate a replacement clientOrderId on restart. */
  load: (clientOrderId: string, connectionId: string) => Promise<DurableExitIntent | null>;
}

const states = new Set<ExitIntentState>([
  'SENT', 'UNKNOWN', 'ACCEPTED', 'REJECTED', 'FILLED',
]);

function parseRecord(row: unknown): ExitIntentRecord | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.mode !== 'TESTNET' || typeof r.client_order_id !== 'string'
    || typeof r.connection_id !== 'string' || typeof r.symbol !== 'string'
    || typeof r.owner_token !== 'string' || typeof r.state !== 'string'
    || !states.has(r.state as ExitIntentState)) return null;
  return {
    clientOrderId: r.client_order_id,
    connectionId: r.connection_id,
    symbol: r.symbol,
    ownerToken: r.owner_token,
    state: r.state as ExitIntentState,
  };
}

const invalidIntent = (r: ExitIntentRecord): boolean =>
  !r || r.state !== 'SENT'
  || !r.clientOrderId || r.clientOrderId.length > 36
  || !r.connectionId || !r.symbol || r.symbol !== r.symbol.toUpperCase()
  || r.symbol.length > 40
  || !r.ownerToken || r.ownerToken.length > 128;

/**
 * Only use after TESTNET readiness has been independently verified.
 * A falsely asserted readiness is a wiring defect: this guard is NOT
 * a replacement for connection/venue-mode verification at call site.
 *
 * Atomic winner determination is the DB PRIMARY KEY on client_order_id.
 * Never SELECT then INSERT; never UPSERT; never retry on network error.
 */
export function supabaseTestnetExitIntentStore(
  sb: any,
  verifiedTestnet: boolean,
): TestnetExitIntentStore {
  const claim = async (intent: ExitIntentRecord): Promise<ClaimExitIntentResult> => {
    const unavailable: ClaimExitIntentResult = { code: 'UNAVAILABLE', record: null };
    if (!verifiedTestnet || invalidIntent(intent)) return unavailable;
    try {
      const { data, error } = await sb.from(EXIT_ORDER_INTENT_TABLE)
        .insert({
          client_order_id: intent.clientOrderId,
          connection_id: intent.connectionId,
          symbol: intent.symbol,
          owner_token: intent.ownerToken,
          state: 'SENT',
          mode: 'TESTNET',
        })
        .select('client_order_id,connection_id,symbol,owner_token,state,mode')
        .single();
      if (!error) {
        const row = parseRecord(data);
        return row ? { code: 'CLAIMED', record: row } : unavailable;
      }
      // PostgreSQL unique_violation: an existing claim has won.
      // Other errors (including timeout and absent migration) are UNKNOWN.
      if (error.code !== '23505') return unavailable;
      const existing = await sb.from(EXIT_ORDER_INTENT_TABLE)
        .select('client_order_id,connection_id,symbol,owner_token,state,mode')
        .eq('client_order_id', intent.clientOrderId).maybeSingle();
      if (existing.error) return unavailable;
      const row = parseRecord(existing.data);
      return row ? { code: 'EXISTS', record: row } : unavailable;
    } catch {
      return unavailable;
    }
  };

  const load = async (clientOrderId: string, connectionId: string):
    Promise<DurableExitIntent | null> => {
    if (!verifiedTestnet || !clientOrderId || !connectionId)
      throw new Error('TESTNET_EXIT_INTENT_READ_BLOCKED');
    const { data, error } = await sb.from(EXIT_ORDER_INTENT_TABLE)
      .select('client_order_id,connection_id,symbol,owner_token,state,mode')
      .eq('client_order_id', clientOrderId)
      .eq('connection_id', connectionId).maybeSingle();
    if (error) throw new Error('TESTNET_EXIT_INTENT_READ_FAILED');
    if (data == null) return null;
    const row = parseRecord(data);
    if (!row || row.clientOrderId !== clientOrderId
      || row.connectionId !== connectionId)
      throw new Error('TESTNET_EXIT_INTENT_EVIDENCE_MISMATCH');
    return { clientOrderId: row.clientOrderId, state: row.state };
  };

  return { claim, load };
}
