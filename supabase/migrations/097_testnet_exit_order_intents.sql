-- 097_testnet_exit_order_intents.sql
--
-- Issue #325: Write-ahead durable exit-intent ledger for Binance TESTNET.
-- *** DRAFT ONLY: do not apply to production until migration preflight,
-- runtime wiring and rollback are reviewed. ***
--
-- Do not reuse live_orders (entry-order ledger). A close request may time
-- out after reaching the exchange. A process-local flag or a preflight SELECT
-- cannot prevent two restarted workers from sending the same close.
--
-- Atomic INSERT + PRIMARY KEY provides a single claim winner. Any conflict,
-- read failure, or UNKNOWN state forbids blind resend. The claimant must also
-- verify the existing fence, venue readiness, side and reduceOnly constraints.
-- This table alone does not prove the venue rejected duplicate market orders.
--
-- These rows record *possible submission* from BEFORE the first HTTP request.
-- SENT therefore means "may have been sent", not exchange-acknowledged.
-- No secret keys, API payloads or credentials may be stored here.

CREATE TABLE IF NOT EXISTS public.exit_order_intents (
  client_order_id TEXT PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES public.exchange_connections(id),
  symbol TEXT NOT NULL,
  state TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exit_order_intents_client_id_valid
    CHECK (length(client_order_id) BETWEEN 1 AND 36),
  CONSTRAINT exit_order_intents_symbol_valid
    CHECK (symbol = upper(symbol) AND length(symbol) BETWEEN 1 AND 40),
  CONSTRAINT exit_order_intents_owner_valid
    CHECK (length(owner_token) BETWEEN 1 AND 128),
  CONSTRAINT exit_order_intents_state_valid
    CHECK (state IN ('SENT', 'UNKNOWN', 'ACCEPTED', 'REJECTED', 'FILLED')),
  CONSTRAINT exit_order_intents_testnet_only
    CHECK (mode = 'TESTNET')
);

CREATE INDEX IF NOT EXISTS exit_order_intents_connection_created_idx
  ON public.exit_order_intents (connection_id, created_at DESC);

ALTER TABLE public.exit_order_intents ENABLE ROW LEVEL SECURITY;

-- Supabase service_role is server-only and may bypass RLS. Remove table
-- privileges from browser roles, including legacy default grants.
REVOKE ALL PRIVILEGES ON TABLE public.exit_order_intents
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.exit_order_intents
  TO service_role;

COMMENT ON TABLE public.exit_order_intents IS
  'Issue #325: TESTNET exit write-ahead claim. One client order ID admits one claimant; persistence precedes submission. Does NOT authorize LIVE orders.';
COMMENT ON COLUMN public.exit_order_intents.state IS
  'SENT includes unacknowledged pre-submit intent: a timeout/crash requires venue reconciliation, NEVER automatic resend.';
COMMENT ON COLUMN public.exit_order_intents.owner_token IS
  'Per-attempt opaque owner identity; never grants permission on its own without a successful atomic insert and current lease.';
