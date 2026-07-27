-- ═══════════════════════════════════════════════════════════
-- TRAIGO 통합 마이그레이션 (008 ~ 015)
--
-- 사용법: Supabase 대시보드 → SQL Editor → 전체 붙여넣기 → Run
-- 모든 문장이 IF NOT EXISTS 이므로 여러 번 실행해도 안전합니다.
-- ═══════════════════════════════════════════════════════════


-- ───────── 008_signals.sql ─────────

-- 008_signals.sql
-- 표준 신호 수신 기록 (Signal Gateway)
-- TradingView/자체 전략이 보낸 신호를 원문 그대로 남긴다. 감사·재처리·중복추적용.

CREATE TABLE IF NOT EXISTS signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id     TEXT NOT NULL,              -- 클라이언트가 준 고유 ID (멱등 키)
  user_id       UUID,
  strategy_id   TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  signal        TEXT NOT NULL,              -- LONG | SHORT | CLOSE
  bucket        TEXT,                       -- scalping | daytrading | swing | position | longterm ...
  confidence    NUMERIC,
  entry_price   NUMERIC,
  stop_loss     NUMERIC,
  take_profit   NUMERIC,
  timeframe     TEXT,
  source        TEXT DEFAULT 'tradingview', -- tradingview | internal | manual
  status        TEXT NOT NULL DEFAULT 'received',
                -- received | rejected | queued | planned | executed | failed
  reject_reason TEXT,
  warnings      TEXT[],
  raw_payload   JSONB,                      -- 원문 (키 등 민감정보는 저장 전 제거)
  job_id        UUID,                       -- 큐에 넣은 작업 ID
  signal_ts     TIMESTAMPTZ,                -- 신호가 만들어진 시각
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 같은 signal_id 재수신 방지 (멱등)
CREATE UNIQUE INDEX IF NOT EXISTS signals_signal_id_uniq ON signals (signal_id);
CREATE INDEX IF NOT EXISTS signals_created_idx  ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS signals_strategy_idx ON signals (strategy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS signals_status_idx   ON signals (status);

ALTER TABLE signals ENABLE ROW LEVEL SECURITY;

-- 서비스 롤(서버)만 쓰기. 사용자는 자기 신호만 읽기.
DROP POLICY IF EXISTS signals_service_all ON signals;
CREATE POLICY signals_service_all ON signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS signals_owner_read ON signals;
CREATE POLICY signals_owner_read ON signals
  FOR SELECT TO authenticated USING (user_id = auth.uid());


-- ───────── 009_position_plans.sql ─────────

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


-- ───────── 010_paper_trading.sql ─────────

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


-- ───────── 011_ai_usage.sql ─────────

-- 011_ai_usage.sql
-- AI 비용 통제: 사용량 기록 + 개인 API 키(BYOK) + 공유 분석 캐시.

-- 일일 사용량 (크레딧 기준)
CREATE TABLE IF NOT EXISTS ai_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID,
  usage_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  tier         TEXT NOT NULL,             -- L0_RULES | L1_CHEAP | L2_PREMIUM | L3_COMMITTEE
  kind         TEXT,                      -- news | signal | explain | decision
  credits      NUMERIC NOT NULL DEFAULT 0,
  used_own_key BOOLEAN NOT NULL DEFAULT FALSE,
  cache_hit    BOOLEAN NOT NULL DEFAULT FALSE,
  input_tokens  INT,
  output_tokens INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_usage_user_date_idx ON ai_usage (user_id, usage_date);
CREATE INDEX IF NOT EXISTS ai_usage_created_idx   ON ai_usage (created_at DESC);

-- 개인 API 키 (BYOK) — 암호화 저장. 평문은 절대 저장하지 않는다.
CREATE TABLE IF NOT EXISTS ai_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  provider      TEXT NOT NULL,            -- openai | anthropic | gemini
  key_enc       TEXT NOT NULL,            -- 암호화된 키
  key_masked    TEXT NOT NULL,            -- 화면 표시용 (sk-...abcd)
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- 공유 분석 캐시 — 같은 뉴스/시장 분석을 여러 사용자가 재사용
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key   TEXT PRIMARY KEY,
  kind        TEXT,
  tier        TEXT,
  result      JSONB NOT NULL,
  hit_count   INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_cache_expires_idx ON ai_cache (expires_at);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_keys  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_service ON ai_usage;
CREATE POLICY ai_usage_service ON ai_usage FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ai_usage_owner ON ai_usage;
CREATE POLICY ai_usage_owner ON ai_usage FOR SELECT TO authenticated USING (user_id = auth.uid());

-- 개인 키는 서비스롤만 접근. 사용자도 암호문을 직접 못 읽는다.
DROP POLICY IF EXISTS ai_keys_service ON ai_keys;
CREATE POLICY ai_keys_service ON ai_keys FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ai_cache_service ON ai_cache;
CREATE POLICY ai_cache_service ON ai_cache FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ───────── 012_live_orders.sql ─────────

-- 012_live_orders.sql
-- 실주문 의도 기록 (테스트넷 포함).
-- 핵심 원칙: 거래소에 보내기 "전에" 의도를 먼저 기록한다.
-- 그래야 응답을 못 받고 서버가 죽어도, 재시작 후 거래소와 대조해 복구할 수 있다.

CREATE TABLE IF NOT EXISTS live_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_order_id   TEXT NOT NULL,             -- 멱등 키. 거래소에 그대로 전달.
  signal_id         TEXT,
  user_id           UUID,
  connection_id     UUID,

  exchange          TEXT NOT NULL,             -- binance | gate
  mode              TEXT NOT NULL,             -- TESTNET | LIVE
  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL,             -- BUY | SELL
  order_type        TEXT NOT NULL DEFAULT 'MARKET',
  quantity          NUMERIC NOT NULL,
  price             NUMERIC,
  leverage          INT,
  reduce_only       BOOLEAN NOT NULL DEFAULT FALSE,

  -- 상태 머신
  status            TEXT NOT NULL DEFAULT 'INTENT',
                    -- INTENT: 기록만 함 (아직 안 보냄)
                    -- SENT: 거래소에 전송함 (응답 대기)
                    -- ACKED: 거래소가 접수 확인
                    -- FILLED: 체결 완료
                    -- REJECTED: 거래소가 거부
                    -- FAILED: 전송 실패 (재시도 가능)
                    -- UNKNOWN: 응답 못 받음 → 반드시 대조 필요
                    -- RECONCILED: 대조로 상태 확정
  exchange_order_id TEXT,
  filled_qty        NUMERIC,
  avg_price         NUMERIC,
  error_message     TEXT,

  -- 손절/익절 부착 결과
  sl_order_id       TEXT,
  tp_order_id       TEXT,
  stop_loss         NUMERIC,
  take_profit       NUMERIC,

  attempt_count     INT NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ,
  acked_at          TIMESTAMPTZ,
  reconciled_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 같은 clientOrderId로 두 번 주문 못 나가게 (멱등의 핵심)
CREATE UNIQUE INDEX IF NOT EXISTS live_orders_coid_uniq ON live_orders (client_order_id);
CREATE INDEX IF NOT EXISTS live_orders_status_idx  ON live_orders (status)
  WHERE status IN ('SENT', 'UNKNOWN', 'INTENT');
CREATE INDEX IF NOT EXISTS live_orders_created_idx ON live_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS live_orders_user_idx    ON live_orders (user_id, created_at DESC);

ALTER TABLE live_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_orders_service ON live_orders;
CREATE POLICY live_orders_service ON live_orders FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS live_orders_owner ON live_orders;
CREATE POLICY live_orders_owner ON live_orders FOR SELECT TO authenticated USING (user_id = auth.uid());


-- ───────── 013_daily_slots.sql ─────────

-- 013_daily_slots.sql
-- DAILY_HIGH_LEV 전략의 슬롯 상태.
--
-- 왜 DB인가: 슬롯 사용 기록이 서버 메모리에 있으면 Vercel 재시작·다중 인스턴스에서
-- 초기화되어 "슬롯당 하루 1회" 제한이 무력화된다. 하루 10회가 30회가 될 수 있다.
-- UNIQUE 제약으로 DB가 직접 중복 사용을 막는다.

CREATE TABLE IF NOT EXISTS daily_slot_days (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,
  trade_date        DATE NOT NULL,

  -- 하루 시작 시점에 고정. 이후 잔고가 변해도 슬롯 크기는 바뀌지 않는다.
  -- (현재 잔고 ÷ 10으로 매번 재계산하면 지고 있을 때 슬롯이 작아져 의도와 달라짐)
  start_equity      NUMERIC NOT NULL,
  slot_size         NUMERIC NOT NULL,        -- start_equity / slot_count
  slot_count        INT     NOT NULL DEFAULT 10,

  -- 안전장치 (사용자 설정 가능)
  max_daily_loss    NUMERIC,                 -- 이 금액 넘게 잃으면 당일 중단
  max_consecutive_losses INT DEFAULT 3,      -- 연속 손실 시 중단

  slots_used        INT     NOT NULL DEFAULT 0,
  realized_pnl      NUMERIC NOT NULL DEFAULT 0,
  consecutive_losses INT    NOT NULL DEFAULT 0,
  halted            BOOLEAN NOT NULL DEFAULT FALSE,
  halt_reason       TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, trade_date)
);

-- 개별 슬롯 사용 기록
CREATE TABLE IF NOT EXISTS daily_slot_uses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id          UUID NOT NULL REFERENCES daily_slot_days(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  trade_date      DATE NOT NULL,
  slot_index      INT  NOT NULL,             -- 0..slot_count-1

  signal_id       TEXT,
  symbol          TEXT NOT NULL,
  side            TEXT NOT NULL,
  margin_mode     TEXT NOT NULL DEFAULT 'isolated',
  allocated_margin NUMERIC NOT NULL,         -- 이 슬롯에 격리한 증거금
  leverage        INT NOT NULL,
  position_size   NUMERIC NOT NULL,
  entry_price     NUMERIC,
  stop_loss       NUMERIC,
  take_profit     NUMERIC,
  liquidation_price NUMERIC,

  status          TEXT NOT NULL DEFAULT 'open',  -- open | closed
  exit_price      NUMERIC,
  exit_reason     TEXT,
  realized_pnl    NUMERIC,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 같은 날 같은 슬롯을 두 번 쓸 수 없다 (핵심 제약)
CREATE UNIQUE INDEX IF NOT EXISTS daily_slot_uses_uniq
  ON daily_slot_uses (user_id, trade_date, slot_index);
CREATE INDEX IF NOT EXISTS daily_slot_uses_day_idx ON daily_slot_uses (day_id);
CREATE INDEX IF NOT EXISTS daily_slot_uses_open_idx ON daily_slot_uses (user_id, status)
  WHERE status = 'open';

ALTER TABLE daily_slot_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_slot_uses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS slot_days_service ON daily_slot_days;
CREATE POLICY slot_days_service ON daily_slot_days FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS slot_days_owner ON daily_slot_days;
CREATE POLICY slot_days_owner ON daily_slot_days FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS slot_uses_service ON daily_slot_uses;
CREATE POLICY slot_uses_service ON daily_slot_uses FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS slot_uses_owner ON daily_slot_uses;
CREATE POLICY slot_uses_owner ON daily_slot_uses FOR SELECT TO authenticated USING (user_id = auth.uid());


-- ───────── 014_derivatives_daily.sql ─────────
-- 014_derivatives_daily.sql
-- 파생시장 일별 히스토리 (펀딩비 · OI 변화율).
--
-- 왜 저장하나: 백테스트가 매번 거래소 API를 호출하면 느리고 레이트리밋에 걸린다.
-- 한 번 수집해 저장해두고 백테스트는 DB에서 읽는다.
--
-- 주의: Binance OI 히스토리는 최근 30일치만 제공한다.
--       그 이전 구간은 coverage='funding_only'로 남는다.

CREATE TABLE IF NOT EXISTS derivatives_daily (
  symbol         TEXT NOT NULL,
  trade_date     DATE NOT NULL,
  funding_rate   NUMERIC,          -- 그날 평균 펀딩비 (%)
  oi_change_pct  NUMERIC,          -- 전일 대비 OI 변화율 (%)
  coverage       TEXT NOT NULL DEFAULT 'none',   -- full | funding_only | none
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, trade_date)
);

CREATE INDEX IF NOT EXISTS derivatives_daily_symbol_idx ON derivatives_daily (symbol, trade_date DESC);
CREATE INDEX IF NOT EXISTS derivatives_daily_coverage_idx ON derivatives_daily (coverage);

ALTER TABLE derivatives_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS derivatives_daily_service ON derivatives_daily;
CREATE POLICY derivatives_daily_service ON derivatives_daily
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 시장 데이터라 모든 로그인 사용자가 읽을 수 있다
DROP POLICY IF EXISTS derivatives_daily_read ON derivatives_daily;
CREATE POLICY derivatives_daily_read ON derivatives_daily
  FOR SELECT TO authenticated USING (true);


-- ───────── 015_econ_events.sql ─────────
-- 015_econ_events.sql
-- 경제 캘린더 (Risk Veto가 사용하는 실제 일정).
--
-- 왜 필요한가: 정적 ECON_EVENTS는 연도가 없고 시간대가 정의되지 않아
-- 실제 발표 시각과 최대 9시간, 최대 1년까지 어긋난다.
-- 100배 레버리지에서 FOMC 회피가 어긋나면 Veto가 없는 것과 같다.
--
-- 이 테이블은 UTC 타임스탬프만 저장한다.

CREATE TABLE IF NOT EXISTS econ_events (
  id              TEXT PRIMARY KEY,
  timestamp_utc   TIMESTAMPTZ NOT NULL,      -- UTC 필수. 로컬 시각 저장 금지.
  event           TEXT NOT NULL,
  impact          TEXT NOT NULL DEFAULT 'low',   -- low | medium | high
  country         TEXT,
  affected_assets TEXT[],
  actual          TEXT,
  forecast        TEXT,
  previous        TEXT,
  source          TEXT NOT NULL DEFAULT 'manual', -- api | manual
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS econ_events_time_idx   ON econ_events (timestamp_utc);
CREATE INDEX IF NOT EXISTS econ_events_impact_idx ON econ_events (impact, timestamp_utc)
  WHERE impact = 'high';

ALTER TABLE econ_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS econ_events_service ON econ_events;
CREATE POLICY econ_events_service ON econ_events FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS econ_events_read ON econ_events;
CREATE POLICY econ_events_read ON econ_events FOR SELECT TO authenticated USING (true);
