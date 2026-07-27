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
