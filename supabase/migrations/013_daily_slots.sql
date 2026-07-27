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
