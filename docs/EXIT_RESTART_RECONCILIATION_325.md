# Issue #325 — Restart close reconciliation integration audit

Status: **design and injected tests only**. This branch does **not** change operational close routing, DB schema, or exchange traffic.

## Existing components (do not duplicate)

- `src/lib/engine/exitIntent.ts`: deterministic exit intent identifier based on account, exchange, symbol, direction, execution identity, exit reason and observed quantity. The module expressly does **not** guarantee permanent exchange deduplication of completed MARKET orders.
- `src/lib/engine/venuePositionOps.ts`: `prepareSymbolClose` can carry `clientOrderId` into prepared close payload; `sendSymbolClose` sends it. `readOpenPosition` distinguishes failed reads from flat.
- `src/lib/engine/exitAuthorityRun.ts`: checks lease ownership, prepares exposure, revalidates fence, sends close, reads after. One read-after is **not** proof that an outstanding close order will not fill later.
- `src/lib/engine/exitLeaseStore.ts`: a **single global** exit-monitor lease row, not a per-position durable close-attempt ledger. `exitFenceChecker` returns true for untracked/missing lease; do not treat it as a strict single-writer guarantee.
- Generic lifecycle close uses `applyLifecycleClose` and returns `needsReconcile`, but this boolean alone is not durable restart reconciliation.

## Operational integration prerequisites

1. Identify the **actual** Exact100X and generic lifecycle close routes, their order IDs and exchange support. Verify whether any existing DB table already persists per-position close attempts before proposing a new migration.
2. Persist close attempt state with a unique position/execution identity, venue, direction, reason, normalized quantity, deterministic client order ID, fence, creation time, and outcome: `PREPARED`, `SUBMIT_UNKNOWN`, `ACCEPTED`, `PARTIAL`, `FLAT_VERIFIED`, `REJECTED_CONFIRMED`, `NEEDS_RECONCILE`. Do **not** interpret a timeout as a rejection.
3. Atomic DB claim must be keyed per execution/position, must survive restart, and must preserve ambiguous attempts. The global lease is insufficient to prove that an old exchange order has ceased to exist.
4. Reconcile by exact client order ID (when supported), pending reduce-only orders and actual position/side/quantity. If any read is unavailable, return `RECONCILE_FIRST` and never claim that a fresh send is safe.
5. Only permit a new close attempt after the prior attempt is conclusively terminal or cancelled **and** position/side/mode is freshly verified. The exchange's reuse rules for client IDs vary: do not assume permanent uniqueness.
6. Claim atomically, revalidate the fence immediately before write, and retain `reduceOnly` and side/mode guards. A stale worker may pass a fence check just before expiry; the DB cannot cancel an already transmitted order.
7. Add deterministic two-worker and multi-cycle fake-venue integration tests: accepted-but-timeout, delayed fill, partial fill, read failure, claim result unknown, restart, lease takeover, and old MARKET order ID reuse. Assert send counts, order state, position state and persistence across simulated process instances.
8. Document reconciliation latency, stuck attempts, operator escalation, and emergency close policy. Fail-closed can strand an exposed 100x position; do not silently suppress all emergency exits.

## What this PR proves / does not prove

`restartClosePreflight.ts` and `restartReconcileGate.ts` are pure injected seams, and tests in the existing registered `runLifecycleActionTests` exercise conservative decisions. They do not persist attempts, query the real exchange, guarantee atomic claims in a database, or prevent live duplicate orders. No production readiness claim is warranted.

**Forbidden without separate approval:** live/testnet orders, production migrations, changing Exact100X time-exit/stop/TP contracts, merges.
