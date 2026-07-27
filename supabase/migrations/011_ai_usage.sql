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
