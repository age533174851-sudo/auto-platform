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
