-- 023_ai_predictions.sql
--
-- AI가 한 말과 **그래서 어떻게 됐는지**를 같이 남긴다.
--
-- 왜 필요한가
-- ───────────
-- "TRAIGO AI Score : 96/100"은 그 자체로는 아무 뜻이 없다. 96%라고 말한
-- 판단이 실제로 96% 맞았는지 재 본 적이 없으면, 그 숫자는 확신의 표현이지
-- 정보가 아니다. 이 표가 그 검증의 원장이다.
--
-- 한 행이 답하는 것 셋:
--   1. AI가 뭐라고 했나            direction · confidence · level
--   2. **몇이 답했나**             responded / asked
--   3. 그래서 어떻게 됐나          outcome · outcome_price (나중에 채운다)
--
-- 커버리지를 왜 열로 두는가
-- ─────────────────────────
-- 다섯에게 물어 둘이 답했는데 그 둘이 같은 말을 하면 level은 'UNANIMOUS'다.
-- 숫자만 보면 가장 강한 합의처럼 보이는데 실제로는 가장 적게 확인된 판단이다.
-- responded와 asked를 따로 남기지 않으면 이 구분이 영원히 사라진다.
--
-- outcome이 왜 NULL을 허용하는가
-- ──────────────────────────────
-- 결과는 예측보다 나중에 나온다. 그 사이를 '보합'이나 '맞음'으로 채우면
-- 적중률이 시간이 갈수록 좋아지는 것처럼 보인다. **모르는 것은 NULL이고,
-- 채점(lib/ai/calibration)은 NULL을 분자에도 분모에도 넣지 않는다.**

CREATE TABLE IF NOT EXISTS ai_predictions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID,

  -- 무엇에 대한 판단인가
  symbol         TEXT NOT NULL,
  source         TEXT NOT NULL,              -- 'consensus' | 'openai' | 'anthropic' | …

  -- AI가 한 말
  direction      TEXT,                       -- bullish | bearish | neutral | uncertain
  confidence     NUMERIC,                    -- 0~100. 모르면 NULL (0이 아니다)
  level          TEXT,                       -- UNANIMOUS | MAJORITY | SPLIT | INSUFFICIENT
  responded      INT,                        -- 실제로 답한 공급자 수
  asked          INT,                        -- 물어본 공급자 수
  reasons        JSONB,                      -- 근거. 나중에 왜 틀렸는지 되짚는 데 쓴다

  -- 이 판단이 실제 주문에 쓰였는가
  --   'INFO' 기록만 함 · 'VETO' 진입을 막음 · 'PASS' 반대하지 않아 통과
  -- 쓰이지 않은 판단까지 같이 채점해야 "막았을 때만 맞더라" 같은 착시를 피한다.
  applied        TEXT,
  side           TEXT,                       -- 그때 하려던 방향 LONG | SHORT

  decided_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_price    NUMERIC,                    -- 판단 시점 가격 — 정답지의 기준
  horizon_min    INT,                        -- 몇 분 뒤로 채점할 것인가

  -- 채점 결과. **나중에** 채운다
  outcome        TEXT,                       -- bullish | bearish | neutral. 모르면 NULL
  outcome_price  NUMERIC,
  scored_at      TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 최신 판단 조회 — 거부권은 "이 종목의 가장 최근 합의"를 본다
CREATE INDEX IF NOT EXISTS ai_pred_symbol_idx
  ON ai_predictions (user_id, symbol, decided_at DESC);

-- 채점 대상 찾기. 아직 결과가 없는 것만 훑는다
CREATE INDEX IF NOT EXISTS ai_pred_unscored_idx
  ON ai_predictions (decided_at) WHERE outcome IS NULL;

-- 캘리브레이션 조회
CREATE INDEX IF NOT EXISTS ai_pred_scored_idx
  ON ai_predictions (user_id, decided_at DESC) WHERE outcome IS NOT NULL;

-- RLS. `public` 스키마의 표는 PostgREST로 인터넷에 노출되고, anon 키는
-- 브라우저 번들에 들어 있는 공개 값이다 (022 마이그레이션 참조).
ALTER TABLE ai_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_pred_service ON ai_predictions;
CREATE POLICY ai_pred_service ON ai_predictions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 것만 읽는다. 쓰기는 서버(service_role)만 — 사용자가 직접 넣을 수
-- 있으면 성적표를 스스로 고칠 수 있고, 그러면 채점의 의미가 없다.
DROP POLICY IF EXISTS ai_pred_owner ON ai_predictions;
CREATE POLICY ai_pred_owner ON ai_predictions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
