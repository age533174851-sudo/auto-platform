// Evidence-first regression probes. Intentionally RED until missing-order reconciliation is fail-closed.
// No exchange requests, DB writes, or trading signals.
import { test, eq } from '../../test/harness';
import { resolveUnknown, resolveAcked, REFLECT_GRACE_MS } from './unknownResolver';
import { ledgerStatusOf } from './reconcileLedgerStatus';

export function runMissingOrderEvidenceTests() {
  const elapsedMs = REFLECT_GRACE_MS + 60_000;
  const query = { ok: true, order: null };

  test('ACKED missing from lookup without trade-history evidence must not release entry lock', () => {
    const verdict = resolveAcked({ clientOrderId: 'acked-missing', elapsedMs, query,
      position: { qtyBefore: 0, qtyNow: 0 } });
    const ledger = ledgerStatusOf(verdict.state);
    eq(ledger.terminal, false, 'Missing order is not proof of fill/cancel; terminal releases ledger lock');
  });

  test('UNKNOWN missing from lookup without position evidence must remain unresolved', () => {
    const verdict = resolveUnknown({ clientOrderId: 'unknown-no-position', elapsedMs, query });
    eq(verdict.resolved, false, 'No position observation: cannot prove order was never accepted');
  });

  test('UNKNOWN missing from lookup with unchanged position must not prove no open order', () => {
    const verdict = resolveUnknown({ clientOrderId: 'unknown-open', elapsedMs, query,
      position: { qtyBefore: 0, qtyNow: 0 } });
    eq(verdict.resolved, false, 'Unfilled open order can coexist with unchanged position');
  });

  test('UNKNOWN with unreadable position remains unresolved', () => {
    const verdict = resolveUnknown({ clientOrderId: 'unknown-unreadable', elapsedMs, query,
      position: { qtyBefore: 0, qtyNow: null } });
    eq(verdict.resolved, false);
  });
}
