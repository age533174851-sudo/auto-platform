-- 056_ledger_events.sql
--
-- **잔고가 변한 것과 번 것은 다르다.**
--
-- 왜 이 표가 필요한가
-- ───────────────────
-- 지금까지 손익은 자산 스냅샷의 차이로 추측했다. 그런데 자산은 매매가
-- 아닌 이유로도 변한다:
--
--   · 입금 · 출금 · 계좌 간 이체
--   · 수수료 · 펀딩비
--   · **Gate 테스트넷 일일 충전 · Binance 테스트 자금 초기화**
--
-- 마지막 줄이 특히 위험하다. 테스트넷 충전을 수익으로 세면 전략이
-- 실제로 버는 것처럼 보이고, 그 숫자를 믿고 실전으로 넘어간다.
--
-- 그래서 **사실을 하나씩 적는다.** 합계는 그 사실에서 나온다.
--
-- 불변이다
-- ────────
-- 한 번 적힌 사건은 고치지 않는다. 틀렸으면 ADJUSTMENT를 새로 적는다 —
-- 지우고 다시 쓰면 "언제부터 틀렸는지"를 되짚을 수 없다.

CREATE TABLE IF NOT EXISTS ledger_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,

  -- **환경이 다르면 다른 돈이다.** 절대 합치지 않는다.
  env               TEXT NOT NULL CHECK (env IN ('LIVE', 'TESTNET', 'MOCK')),
  connection_id     UUID,
  exchange          TEXT,

  kind              TEXT NOT NULL,

  -- 누가 만든 사건인가. 거래소는 전략을 모르므로 우리가 적어 둔다.
  strategy_id       TEXT,
  strategy_hash     TEXT,

  symbol            TEXT,
  -- **거래소 주문 번호는 TEXT다.** Gate price order id는 int64라
  -- 숫자로 담으면 자릿수가 날아간다(#139).
  venue_order_id    TEXT,
  order_intent_id   TEXT,

  -- 금액과 통화. 부호는 계좌 관점이다(들어오면 +, 나가면 −).
  amount            NUMERIC NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USDT',
  quantity          NUMERIC,
  price             NUMERIC,

  -- 언제 일어난 일인가(거래소 시각). 적은 시각과 다르다.
  occurred_at       TIMESTAMPTZ NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 어디서 온 사실인가: EXCHANGE_FILL · EXCHANGE_INCOME · ENGINE · MANUAL
  source            TEXT NOT NULL,
  -- 판단 → 주문 → 체결 → 정리 → 장부를 한 줄로 잇는 끈
  correlation_id    TEXT,

  -- **같은 사건을 두 번 적지 않는다.**
  --
  -- 거래소를 다시 읽거나 워커가 재시작하면 같은 체결이 또 온다.
  -- 그때 합계가 두 배가 되면 장부는 쓸모가 없다.
  idempotency_key   TEXT NOT NULL,

  note              TEXT,
  raw               JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_idem
  ON ledger_events (idempotency_key);

CREATE INDEX IF NOT EXISTS ledger_events_user_env_time
  ON ledger_events (user_id, env, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ledger_events_conn
  ON ledger_events (connection_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ledger_events_strategy
  ON ledger_events (strategy_id, occurred_at DESC);

ALTER TABLE ledger_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY ledger_events_service ON ledger_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 사용자는 **자기 것만 읽는다.** 쓰기는 service_role만 한다 —
-- 장부는 사람이 고치는 것이 아니다.
DO $$ BEGIN
  CREATE POLICY ledger_events_owner ON ledger_events
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
