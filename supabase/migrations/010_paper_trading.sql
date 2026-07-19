-- 010_paper_trading.sql
-- 서버측 가상 매매(Paper Trading) 기록.
-- Risk Manager가 승인한 계획을 실제 주문 없이 체결시켜 손익을 추적한다.
-- 실주문 전에 전체 파이프라인을 검증하는 단계.

-- 가상 포지션
CREATE TABLE IF NOT EXISTS paper_positions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID,
  signal_id       TEXT,
  strategy_id     TEXT,
  bucket          TEXT,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL,             -- LONG | SHORT
  status          TEXT NOT NULL DEFAULT 'open',  -- open | closed

  -- 진입
  entry_price     NUMERIC NOT NULL,
  fill_price      NUMERIC NOT NULL,          -- 슬리피지 반영 실제 체결가
  quantity        NUMERIC NOT NULL,
  notional        NUMERIC NOT NULL,          -- 명목가치
  leverage        INT     NOT NULL DEFAULT 1,
  margin          NUMERIC NOT NULL,          -- 사용 증거금
  stop_loss       NUMERIC,
  take_profit     NUMERIC,
  liquidation_price NUMERIC,
  entry_fee       NUMERIC NOT NULL DEFAULT 0,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 청산
  exit_price      NUMERIC,
  exit_reason     TEXT,                      -- TP | SL | LIQUIDATION | MANUAL | REVERSE
  exit_fee        NUMERIC DEFAULT 0,
  gross_pnl       NUMERIC,                   -- 수수료 전 손익
  realized_pnl    NUMERIC,                   -- 수수료 후 순손익
  pnl_pct         NUMERIC,                   -- 증거금 대비 수익률(ROE)
  closed_at       TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS paper_pos_user_idx    ON paper_positions (user_id, status);
CREATE INDEX IF NOT EXISTS paper_pos_symbol_idx  ON paper_positions (symbol, status);
CREATE INDEX IF NOT EXISTS paper_pos_opened_idx  ON paper_positions (opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS paper_pos_signal_uniq ON paper_positions (signal_id) WHERE signal_id IS NOT NULL;

-- 가상 계좌 (사용자별 잔고)
CREATE TABLE IF NOT EXISTS paper_accounts (
  user_id         UUID PRIMARY KEY,
  balance         NUMERIC NOT NULL DEFAULT 10000,   -- USDT
  initial_balance NUMERIC NOT NULL DEFAULT 10000,
  total_pnl       NUMERIC NOT NULL DEFAULT 0,
  total_fees      NUMERIC NOT NULL DEFAULT 0,
  trade_count     INT     NOT NULL DEFAULT 0,
  win_count       INT     NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE paper_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_accounts  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_pos_service ON paper_positions;
CREATE POLICY paper_pos_service ON paper_positions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS paper_pos_owner ON paper_positions;
CREATE POLICY paper_pos_owner ON paper_positions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS paper_acct_service ON paper_accounts;
CREATE POLICY paper_acct_service ON paper_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS paper_acct_owner ON paper_accounts;
CREATE POLICY paper_acct_owner ON paper_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());
