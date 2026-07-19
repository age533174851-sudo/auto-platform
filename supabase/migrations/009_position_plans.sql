-- 009_position_plans.sql
-- Risk Manager가 산출한 포지션 계획 기록.
-- 승인이든 거부든 전부 남긴다 — "왜 이 주문이 나갔는가/안 나갔는가"를 추적하기 위해.

CREATE TABLE IF NOT EXISTS position_plans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id      TEXT NOT NULL,
  user_id        UUID,
  strategy_id    TEXT,
  symbol         TEXT NOT NULL,
  side           TEXT NOT NULL,               -- LONG | SHORT
  bucket         TEXT,

  approved       BOOLEAN NOT NULL,
  reject_code    TEXT,                        -- DAILY_LOSS_LIMIT | LIQUIDATION_BEFORE_STOP ...
  reject_reason  TEXT,

  -- 위험 기준 계산 결과
  account_equity     NUMERIC,
  risk_amount        NUMERIC,                 -- 이 거래 허용 손실액
  stop_distance_pct  NUMERIC,                 -- 명목 손절 거리
  effective_stop_pct NUMERIC,                 -- 수수료·슬리피지 포함 실효 거리
  position_size      NUMERIC,                 -- 명목가치
  quantity           NUMERIC,
  required_margin    NUMERIC,
  leverage           INT,
  liquidation_price  NUMERIC,
  liquidation_dist_pct NUMERIC,

  notes          TEXT[],
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS position_plans_signal_idx  ON position_plans (signal_id);
CREATE INDEX IF NOT EXISTS position_plans_created_idx ON position_plans (created_at DESC);
CREATE INDEX IF NOT EXISTS position_plans_reject_idx  ON position_plans (reject_code) WHERE approved = false;

ALTER TABLE position_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS position_plans_service_all ON position_plans;
CREATE POLICY position_plans_service_all ON position_plans
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS position_plans_owner_read ON position_plans;
CREATE POLICY position_plans_owner_read ON position_plans
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- 사용자별 위험 한도 설정 (없으면 기본값 사용)
CREATE TABLE IF NOT EXISTS risk_limits (
  user_id             UUID PRIMARY KEY,
  max_leverage        INT     NOT NULL DEFAULT 5,
  risk_per_trade_pct  NUMERIC NOT NULL DEFAULT 0.5,
  max_account_risk_pct NUMERIC NOT NULL DEFAULT 5,
  max_daily_loss_pct  NUMERIC NOT NULL DEFAULT 3,
  max_notional_pct    NUMERIC NOT NULL DEFAULT 300,
  fee_rate_pct        NUMERIC NOT NULL DEFAULT 0.1,
  slippage_pct        NUMERIC NOT NULL DEFAULT 0.05,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE risk_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS risk_limits_service_all ON risk_limits;
CREATE POLICY risk_limits_service_all ON risk_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS risk_limits_owner ON risk_limits;
CREATE POLICY risk_limits_owner ON risk_limits
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
