// Issue #325: Binance USD-M order status adapter for read-only restart evidence.
// An HTTP error or malformed response is NOT equivalent to a missing order.
import type { ExitOrderState } from './exitRestartReconcile';

export interface ExitOrderLookup {
  ok: boolean;
  state: ExitOrderState;
}

/**
 * Only translate a successful Binance order lookup. Callers must treat
 * transport/auth errors and 404/-2013 separately as unresolved evidence.
 * NOT_FOUND is intentionally never produced by this adapter.
 */
export function binanceExitOrderStatus(
  response: { status?: unknown; clientOrderId?: unknown } | null | undefined,
  expectedClientOrderId: string,
): ExitOrderLookup {
  if (!response || !expectedClientOrderId.trim()
    || typeof response.clientOrderId !== 'string'
    || response.clientOrderId !== expectedClientOrderId
    || typeof response.status !== 'string')
    return { ok: false, state: 'UNKNOWN' };
  switch (response.status) {
    case 'NEW': return { ok: true, state: 'OPEN' };
    case 'PARTIALLY_FILLED': return { ok: true, state: 'PARTIAL' };
    case 'FILLED': return { ok: true, state: 'FILLED' };
    case 'CANCELED': case 'EXPIRED': case 'EXPIRED_IN_MATCH':
      return { ok: true, state: 'CANCELLED' };
    case 'REJECTED': return { ok: true, state: 'REJECTED' };
    default: return { ok: false, state: 'UNKNOWN' };
  }
}
