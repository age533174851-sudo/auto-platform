# TESTNET 청산 자리 원자 선점 — 설계 및 배포 차단 조건 (2026-10-16)

> **DRAFT / NOT DEPLOYED.** This document is an architecture sketch, **not a migration**,
> authorization to submit orders, or a guarantee that exit recovery is complete.
> No migration has been applied to Supabase and no TESTNET/LIVE Binance order
> was sent. PR #341 still uses the existing non-atomic same-seat preflight;
> the atomic API in `exitIntentStore.ts` is only exercised by fake-store tests.

## Why the previous preflight is insufficient

For one connection/symbol, both workers may read zero pending rows:

| Clock | Worker A, qty .010 (client key A) | Worker B, qty .006 (client key B) |
|---|---|---|
| t1 | SELECT open pending exits → 0 | |
| t2 | | SELECT open pending exits → 0 |
| t3 | INSERT live_orders, key A | |
| t4 | | INSERT live_orders, key B (not unique conflict) |
| t5 | close send | close send **duplicate/overclose risk** |

`client_order_id` uniqueness is not **seat** uniqueness. The required
scope is `(user_id, connection_id, exchange, mode, symbol)`, without
`quantity` or `client_order_id`. ONE_WAY net positions also mean not
partitioning the seat by LONG/SHORT merely to admit two close orders.

Read-only production evidence (2026-10-16): 43 TESTNET UNKNOWN/ACKED
`live_orders` rows; 14 have `reduce_only=true`; two separate connection+
symbol seats have multiple distinct historical pending close IDs, with a
maximum of 11 rows in one seat. This **does not** establish 11 exchange
open orders; connected Binance reads are still missing.

## Future database migration proposal (NOT READY TO APPLY)

Use the Supabase CLI on a verified repository checkout to generate a proper
migration filename; this illustrative SQL is **not** a migration file.
The design requires review of the existing schema and startup migrations.

```sql
-- EXAMPLE ONLY: DO NOT RUN IN PRODUCTION
CREATE TABLE public.exit_seat_claims (
  user_id UUID NOT NULL,
  connection_id UUID NOT NULL REFERENCES public.exchange_connections(id),
  exchange TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'TESTNET'),
  symbol TEXT NOT NULL CHECK (symbol = upper(symbol) AND length(symbol) BETWEEN 1 AND 40),
  client_order_id TEXT NOT NULL CHECK (length(client_order_id) BETWEEN 1 AND 36),
  owner_token TEXT NOT NULL CHECK (length(owner_token) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connection_id, exchange, mode, symbol),
  UNIQUE (client_order_id)
);
ALTER TABLE public.exit_seat_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.exit_seat_claims
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.exit_seat_claims TO service_role;
```

The only permitted automatic claim primitive is **single INSERT**
on the unique seat, with SQL error `23505` interpreted as
`ALREADY_HELD` (not authorization). A failed read, failed insert,
missing migration (`42P01`), RLS/permission error (`42501`), network
timeout or mismatched echoed identity is `UNAVAILABLE`. Neither
`upsert` nor a preliminary `SELECT` can supply atomic ownership.
Use server-only service-role credentials; never expose this adapter or a
privileged RPC from a browser route.

### Recovery / safe release — intentionally not implemented

A claimed seat **cannot be cleared just because a TTL elapsed**, a process
restarted, or a missing-order lookup returned NOT_FOUND. A request may be
accepted at the venue but its response lost. Before an authorized
release/reuse, obtain independently verified, connection-scoped venue
position (flat), all known and older reduceOnly order states, cancellation
ack/readback when required, execution identity and the prior owner's
fencing token. Reconciliation must distinguish `FILLED`,
`PARTIAL`, `ACKED`, `UNKNOWN`, and venue-read failure.

A lock retained after verified closure can block later trades on the same
seat. **Do not wire the adapter to an auto-close route** without
implementing, reviewing, and testing a safe release/recovery protocol.
Emergency human close is a separately authenticated policy with audit and
different duplicate/ownership risks; NEVER silently bypass a held claim.

## Required before changing the live route

1. Historical 43 records must be reconciled against authorized Binance
   TESTNET order/status/position evidence (READ ONLY), and uncertain
   records must remain UNKNOWN.
2. Stage schema migration in isolated test DB; verify unique constraint
   with concurrent SQL transactions and permissions for anon/authenticated
   and service_role. The TypeScript fake-store races prove only the
   consumer contract, **not real PostgreSQL serialization**.
3. Implement connection- and venue-scoped release guarded by confirmed
   flat + no unresolved older close intents; simulate 3 restarts, partial
   fills, stale fence, DB outage, manual/external orders, and multiple
   symbols/users. Treat failed reconciliations as block/alert.
4. Define deploy order and rollback: schema first, adapter second,
   route wiring only after both are proven. Never deploy a blocking
   route before the schema is present.
5. Preserve Exact100X `NO_FIXED_SL`/`NO_FIXED_TP`, current exit policy,
   user schedules and sizing. Keep LIVE disabled. No automatic cancellations.

**Status at authoring:** PR #331/#341 unmerged. The new
`claimAtomicExitSeatForResearch` result is marked
`executionAuthorized:false` by type, even for a successful mock claim.
