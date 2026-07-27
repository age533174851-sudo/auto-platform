-- ═══════════════════════════════════════════════════════════════════════
-- TRAIGO Supabase Schema v2
-- Supabase Dashboard → SQL Editor → 전체 붙여넣기 → Run
-- ═══════════════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── updated_at trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ════════════════════════════════════════════════════════════════════
-- 1. PROFILES
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT        UNIQUE NOT NULL,
  display_name  TEXT,
  avatar_url    TEXT,
  role          TEXT        NOT NULL DEFAULT 'user'
                              CHECK (role IN (
                                'user', 'vip', 'lifetime', 'founder',
                                'admin', 'developer', 'super_admin'
                              )),
  plan          TEXT        NOT NULL DEFAULT 'free'
                              CHECK (plan IN (
                                'free', 'pro', 'premium', 'lifetime', 'founder', 'admin'
                              )),
  status        TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'banned', 'suspended', 'pending')),
  badges        TEXT[]      NOT NULL DEFAULT '{}',
  expires_at    TIMESTAMPTZ,
  granted_by    UUID        REFERENCES profiles(id),
  invite_code   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_profiles_updated
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Auto-create profile on sign-up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data->>'display_name',
      SPLIT_PART(NEW.email, '@', 1)
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own"        ON profiles;
DROP POLICY IF EXISTS "profiles_update_own"        ON profiles;
DROP POLICY IF EXISTS "profiles_service_role_all"  ON profiles;

CREATE POLICY "profiles_select_own"
  ON profiles
  FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles_update_own"
  ON profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_service_role_all"
  ON profiles
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 2. WATCHLISTS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS watchlists (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  symbol        TEXT        NOT NULL,
  name_kr       TEXT        NOT NULL,
  symbol_ticker TEXT        NOT NULL,
  color         TEXT        NOT NULL DEFAULT '#3B82F6',
  category      TEXT        NOT NULL DEFAULT 'coin',
  exchange      TEXT        NOT NULL DEFAULT 'BINANCE',
  tv_symbol     TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, symbol)
);

ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "watchlists_own"              ON watchlists;
DROP POLICY IF EXISTS "watchlists_service_role_all" ON watchlists;

CREATE POLICY "watchlists_own"
  ON watchlists
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "watchlists_service_role_all"
  ON watchlists
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 3. PORTFOLIOS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS portfolios (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL DEFAULT '',
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_portfolios_updated
  BEFORE UPDATE ON portfolios
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "portfolios_own"              ON portfolios;
DROP POLICY IF EXISTS "portfolios_service_role_all" ON portfolios;

CREATE POLICY "portfolios_own"
  ON portfolios
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "portfolios_service_role_all"
  ON portfolios
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 4. PORTFOLIO_POSITIONS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS portfolio_positions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  portfolio_id   UUID        REFERENCES portfolios(id) ON DELETE SET NULL,
  asset_id       TEXT        NOT NULL,
  name_kr        TEXT        NOT NULL,
  symbol         TEXT        NOT NULL,
  color          TEXT        NOT NULL DEFAULT '#3B82F6',
  type           TEXT        NOT NULL DEFAULT 'long'
                               CHECK (type IN ('long', 'short', 'cash', 'dca', 'etf', 'spot')),
  avg_price      NUMERIC     NOT NULL DEFAULT 0,
  quantity       NUMERIC     NOT NULL DEFAULT 0,
  invested       NUMERIC     NOT NULL DEFAULT 0,
  target_price   NUMERIC     NOT NULL DEFAULT 0,
  stop_price     NUMERIC     NOT NULL DEFAULT 0,
  leverage       INTEGER     NOT NULL DEFAULT 1,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_positions_updated
  BEFORE UPDATE ON portfolio_positions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE portfolio_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "positions_own"              ON portfolio_positions;
DROP POLICY IF EXISTS "positions_service_role_all" ON portfolio_positions;

CREATE POLICY "positions_own"
  ON portfolio_positions
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "positions_service_role_all"
  ON portfolio_positions
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 5. TRADING_STRATEGIES
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS trading_strategies (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  type              TEXT        NOT NULL DEFAULT 'ema_cross',
  asset             TEXT        NOT NULL DEFAULT 'BTC',
  asset_name_kr     TEXT        NOT NULL DEFAULT '비트코인',
  timeframe         TEXT        NOT NULL DEFAULT '4h',
  leverage          INTEGER     NOT NULL DEFAULT 1,
  max_leverage      INTEGER     NOT NULL DEFAULT 10,
  risk_level        TEXT        NOT NULL DEFAULT 'medium'
                                  CHECK (risk_level IN ('low', 'medium', 'high')),
  tp                NUMERIC     NOT NULL DEFAULT 5,
  sl                NUMERIC     NOT NULL DEFAULT 2.5,
  enabled           BOOLEAN     NOT NULL DEFAULT FALSE,
  status            TEXT        NOT NULL DEFAULT 'stopped'
                                  CHECK (status IN ('running', 'paused', 'stopped', 'error')),
  win_rate          NUMERIC     NOT NULL DEFAULT 0,
  total_pnl         NUMERIC     NOT NULL DEFAULT 0,
  trades            INTEGER     NOT NULL DEFAULT 0,
  max_daily_loss    NUMERIC     NOT NULL DEFAULT 500000,
  max_position_size NUMERIC     NOT NULL DEFAULT 3000000,
  cooldown_min      INTEGER     NOT NULL DEFAULT 60,
  params            JSONB       NOT NULL DEFAULT '{}',
  description       TEXT,
  exec_mode         TEXT        NOT NULL DEFAULT 'paper'
                                  CHECK (exec_mode IN ('paper', 'simulated', 'real')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_strategies_updated
  BEFORE UPDATE ON trading_strategies
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE trading_strategies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "strategies_own"              ON trading_strategies;
DROP POLICY IF EXISTS "strategies_service_role_all" ON trading_strategies;

CREATE POLICY "strategies_own"
  ON trading_strategies
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "strategies_service_role_all"
  ON trading_strategies
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 6. EXCHANGE_CONNECTIONS
-- SECURITY: encrypted_secret / api_secret_enc NEVER returned to client
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS exchange_connections (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  exchange_id         TEXT        NOT NULL,
  label               TEXT,
  api_key_masked      TEXT        NOT NULL,
  api_secret_enc      TEXT        NOT NULL,
  api_passphrase_enc  TEXT,
  has_withdrawal      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  last_tested_at      TIMESTAMPTZ,
  test_status         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, exchange_id)
);

CREATE OR REPLACE TRIGGER trg_exchange_updated
  BEFORE UPDATE ON exchange_connections
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE exchange_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "exchange_select_own"        ON exchange_connections;
DROP POLICY IF EXISTS "exchange_insert_own"        ON exchange_connections;
DROP POLICY IF EXISTS "exchange_update_own"        ON exchange_connections;
DROP POLICY IF EXISTS "exchange_delete_own"        ON exchange_connections;
DROP POLICY IF EXISTS "exchange_service_role_all"  ON exchange_connections;

CREATE POLICY "exchange_select_own"
  ON exchange_connections
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "exchange_insert_own"
  ON exchange_connections
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "exchange_update_own"
  ON exchange_connections
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "exchange_delete_own"
  ON exchange_connections
  FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "exchange_service_role_all"
  ON exchange_connections
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 7. TRADE_ORDERS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS trade_orders (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  exchange_id TEXT,
  symbol      TEXT        NOT NULL,
  name_kr     TEXT        NOT NULL,
  side        TEXT        NOT NULL CHECK (side IN ('buy', 'sell')),
  price       NUMERIC     NOT NULL DEFAULT 0,
  quantity    NUMERIC     NOT NULL DEFAULT 0,
  amount      NUMERIC     NOT NULL DEFAULT 0,
  leverage    INTEGER     NOT NULL DEFAULT 1,
  fee         NUMERIC     NOT NULL DEFAULT 0,
  slippage    NUMERIC     NOT NULL DEFAULT 0,
  status      TEXT        NOT NULL DEFAULT 'filled'
                            CHECK (status IN ('pending', 'filled', 'cancelled', 'failed')),
  pnl         NUMERIC     NOT NULL DEFAULT 0,
  pnl_pct     NUMERIC     NOT NULL DEFAULT 0,
  mode        TEXT        NOT NULL DEFAULT 'paper'
                            CHECK (mode IN ('paper', 'simulated', 'real')),
  note        TEXT,
  emotion     TEXT,
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at   TIMESTAMPTZ
);

ALTER TABLE trade_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orders_own"              ON trade_orders;
DROP POLICY IF EXISTS "orders_service_role_all" ON trade_orders;

CREATE POLICY "orders_own"
  ON trade_orders
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "orders_service_role_all"
  ON trade_orders
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 8. PNL_REPORTS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pnl_reports (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  period         TEXT        NOT NULL,
  realized_pnl   NUMERIC     NOT NULL DEFAULT 0,
  unrealized_pnl NUMERIC     NOT NULL DEFAULT 0,
  total_fee      NUMERIC     NOT NULL DEFAULT 0,
  trade_count    INTEGER     NOT NULL DEFAULT 0,
  win_count      INTEGER     NOT NULL DEFAULT 0,
  loss_count     INTEGER     NOT NULL DEFAULT 0,
  win_rate       NUMERIC     NOT NULL DEFAULT 0,
  best_trade     NUMERIC     NOT NULL DEFAULT 0,
  worst_trade    NUMERIC     NOT NULL DEFAULT 0,
  tax_estimate   NUMERIC     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, period)
);

CREATE OR REPLACE TRIGGER trg_pnl_updated
  BEFORE UPDATE ON pnl_reports
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE pnl_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pnl_own"              ON pnl_reports;
DROP POLICY IF EXISTS "pnl_service_role_all" ON pnl_reports;

CREATE POLICY "pnl_own"
  ON pnl_reports
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "pnl_service_role_all"
  ON pnl_reports
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 9. ALERTS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS alerts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  asset_id     TEXT        NOT NULL,
  name_kr      TEXT        NOT NULL,
  condition    TEXT        NOT NULL CHECK (condition IN ('above', 'below')),
  value        NUMERIC     NOT NULL,
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  triggered_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alerts_own"              ON alerts;
DROP POLICY IF EXISTS "alerts_service_role_all" ON alerts;

CREATE POLICY "alerts_own"
  ON alerts
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "alerts_service_role_all"
  ON alerts
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 10. AUDIT_LOGS  (append-only from users; full access for service role)
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  action     TEXT        NOT NULL,
  target_id  UUID,
  resource   TEXT,
  details    JSONB,
  result     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_insert_own"       ON audit_logs;
DROP POLICY IF EXISTS "audit_select_own"       ON audit_logs;
DROP POLICY IF EXISTS "audit_service_role_all" ON audit_logs;

CREATE POLICY "audit_insert_own"
  ON audit_logs
  FOR INSERT
  WITH CHECK (auth.uid() = actor_id);

CREATE POLICY "audit_select_own"
  ON audit_logs
  FOR SELECT
  USING (auth.uid() = actor_id);

CREATE POLICY "audit_service_role_all"
  ON audit_logs
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- 11. BACKTEST_RESULTS
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS backtest_results (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  strategy_id    UUID        REFERENCES trading_strategies(id) ON DELETE SET NULL,
  strategy_name  TEXT        NOT NULL,
  asset          TEXT        NOT NULL,
  timeframe      TEXT        NOT NULL,
  start_date     DATE        NOT NULL,
  end_date       DATE        NOT NULL,
  total_trades   INTEGER     NOT NULL DEFAULT 0,
  win_rate       NUMERIC     NOT NULL DEFAULT 0,
  total_pnl      NUMERIC     NOT NULL DEFAULT 0,
  max_drawdown   NUMERIC     NOT NULL DEFAULT 0,
  sharpe_ratio   NUMERIC,
  params         JSONB       NOT NULL DEFAULT '{}',
  equity_curve   JSONB       NOT NULL DEFAULT '[]',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE backtest_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "backtest_own"              ON backtest_results;
DROP POLICY IF EXISTS "backtest_service_role_all" ON backtest_results;

CREATE POLICY "backtest_own"
  ON backtest_results
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "backtest_service_role_all"
  ON backtest_results
  FOR ALL
  USING (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════
-- INDEXES
-- ════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_watchlists_user     ON watchlists (user_id);
CREATE INDEX IF NOT EXISTS idx_positions_user      ON portfolio_positions (user_id);
CREATE INDEX IF NOT EXISTS idx_strategies_user     ON trading_strategies (user_id);
CREATE INDEX IF NOT EXISTS idx_exchange_user       ON exchange_connections (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user         ON trade_orders (user_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_pnl_user_period     ON pnl_reports (user_id, period);
CREATE INDEX IF NOT EXISTS idx_alerts_user         ON alerts (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor         ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_user       ON backtest_results (user_id);

-- ════════════════════════════════════════════════════════════════════
-- ADMIN PROMOTION
-- Run this manually in SQL Editor to grant admin role:
--
--   UPDATE profiles
--   SET role = 'admin'
--   WHERE email = 'your@email.com';
--
-- Never promote via frontend or API.
-- ════════════════════════════════════════════════════════════════════
