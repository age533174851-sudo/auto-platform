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
