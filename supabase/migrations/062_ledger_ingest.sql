-- 062_ledger_ingest.sql
--
-- **어디까지 읽었는지 모르면 완전성을 말할 수 없다.**
--
-- 매매손익 = 자산변화 − 외부유입 − 수수료 − 펀딩.
-- 네 항을 전부 알 때만 숫자를 만든다는 규칙은 이미 있다(056).
-- 그런데 "수수료를 다 읽었는가"에 답하려면 **어느 구간을 읽었는지**를
-- 기록해 둬야 한다.
--
-- 절반만 읽고 계산하면 나머지 절반의 수수료와 펀딩이 **전부 수익으로
-- 둔갑한다.** 그건 없는 돈을 벌었다고 말하는 것이다.

CREATE TABLE IF NOT EXISTS ledger_ingest_state (
  user_id       UUID NOT NULL,
  connection_id UUID NOT NULL,
  -- LIVE · TESTNET · MOCK. **셋의 장부는 절대 합산하지 않는다**
  env           TEXT NOT NULL,
  -- 이 구간이 장부에 덮여 있다
  covered_from  TIMESTAMPTZ,
  covered_to    TIMESTAMPTZ,
  last_run_at   TIMESTAMPTZ,
  -- 이번에 몇 건을 적었는가
  last_written  INTEGER,
  -- 알아보지 못해 적지 않은 종류들. **조용히 버리지 않는다**
  last_skipped  JSONB,
  -- 실패 사유. 키·값은 절대 담지 않는다
  last_error    TEXT,
  PRIMARY KEY (user_id, connection_id, env)
);

CREATE INDEX IF NOT EXISTS ledger_ingest_state_run_idx
  ON ledger_ingest_state (last_run_at DESC);

COMMENT ON TABLE ledger_ingest_state IS '거래소 원장을 어디까지 읽었는가 — 이게 없으면 매매손익의 완전성을 말할 수 없습니다';
COMMENT ON COLUMN ledger_ingest_state.covered_to IS '이 시각까지 읽었습니다. 이후 구간의 수수료·펀딩은 아직 모릅니다';

ALTER TABLE ledger_ingest_state ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY ledger_ingest_state_own ON ledger_ingest_state
    FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
