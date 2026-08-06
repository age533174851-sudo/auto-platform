-- 037_creator_ledger.sql
--
-- 신호 하나마다 장부 세 권(FOLLOW · INVERSE · IGNORE)을 남긴다.
--
-- 왜 이 표가 필요한가
-- ───────────────────
-- 장부 계산은 순수 함수(lib/signals/creatorLedger)가 한다. 그런데 그
-- 계산은 **신호 시점 전후의 가격 경로**를 필요로 하고, 그건 화면을 열
-- 때마다 다시 가져올 수 있는 것이 아니다. 거래소 캔들 보관 기간이 지나면
-- 아예 못 가져온다.
--
-- 그래서 계산된 결과를 남긴다. 남기지 않으면 **과거 신호의 성적을 다시는
-- 계산할 수 없고**, 그러면 표본이 쌓이지 않는다. 표본이 안 쌓이면 판정은
-- 영원히 INSUFFICIENT_DATA다.
--
-- 무엇을 새로 다는가
-- ──────────────────
-- trader_signals에 세 가지가 없었다. 셋 다 없으면 장부를 만들 수 없다.
--
--  1) said_at   — **발언한 시각.** 지금은 detected_at(감지한 시각)뿐이다.
--                 둘의 차이가 곧 지연이고, 지연은 이 시스템에서 성과를
--                 가장 크게 가르는 값이다. 방송은 수십 초 늦게 나가므로
--                 감지 시각으로 체결하면 **볼 수 없었던 가격**에 들어간
--                 성과가 나온다 — 그리고 그건 언제나 실제보다 좋다.
--
--  2) utterance_kind — "지금 롱 잡았다"와 "비트는 장기적으로 오를 것
--                 같다"를 같은 칸에 넣으면 안 된다. 기존 action 컬럼은
--                 ENTRY/EXIT 같은 **무엇을**이지 **어떤 성격의 발언인가**가
--                 아니다. gateSignal은 EXPLICIT_ENTRY만 통과시키는데,
--                 그 판단 근거가 표에 없었다.
--
--  3) extract_confidence — 추출기의 확신도(0~1). 기존 confidence 컬럼은
--                 'confirmed'/'likely'/'uncertain' 세 칸짜리 등급이라
--                 다른 값이다. 하나로 합치면 화면 확인을 거친 신호와
--                 파서가 자신 있어 한 신호가 구별되지 않는다.
--
-- 그리고 review_status — 사람이 검수했는가. 검수 안 된 신호가 판정에
-- 들어가면, 재는 것이 그 사람의 성과가 아니라 우리 파서의 성과가 된다.

ALTER TABLE trader_signals
  ADD COLUMN IF NOT EXISTS said_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS utterance_kind     TEXT,
  ADD COLUMN IF NOT EXISTS extract_confidence NUMERIC,
  -- 'pending' | 'approved' | 'rejected'
  --
  -- 기본이 pending이다. **검수를 통과한 것만 판정에 넣는다** — 기본을
  -- approved로 두면 아무도 검수하지 않고 전부 들어간다.
  ADD COLUMN IF NOT EXISTS review_status      TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_note        TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at        TIMESTAMPTZ,
  -- 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'UNKNOWN'
  -- 신호 당시의 시장 국면. 세그먼트 판정에 쓴다.
  ADD COLUMN IF NOT EXISTS regime             TEXT NOT NULL DEFAULT 'UNKNOWN';

-- **said_at을 detected_at으로 채우지 않는다.**
--
-- 기존 행에는 발언 시각이 없다. 감지 시각으로 대신 채우면 지연이 전부
-- 0초가 되고, 그 신호들은 FAST 칸에 앉는다 — 성적이 가장 좋게 나오는
-- 칸이다. 모르는 것이 가장 좋은 칸을 채우는 셈이라, 그냥 NULL로 둔다.
-- NULL이면 코드가 지연을 UNKNOWN으로 읽는다.

CREATE INDEX IF NOT EXISTS trader_signals_review_idx
  ON trader_signals (user_id, review_status, detected_at DESC);

-- ── 장부 ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS creator_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  signal_id   UUID NOT NULL REFERENCES trader_signals(id) ON DELETE CASCADE,

  -- 세그먼트 축. 신호에서 복사해 온다 — 조인 없이 집계하기 위해서고,
  -- 신호가 나중에 고쳐져도 **이 장부가 계산될 때의 값**이 남아야 한다.
  creator     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  direction   TEXT NOT NULL,
  regime      TEXT NOT NULL DEFAULT 'UNKNOWN',
  said_at     TIMESTAMPTZ NOT NULL,

  -- 세 장부에 **똑같이** 적용된 조건. 하나라도 다르면 비교가 성립하지
  -- 않으므로, 나중에 대조할 수 있게 그대로 남긴다.
  delay_sec        NUMERIC NOT NULL,
  fee_pct_side     NUMERIC NOT NULL,
  slippage_pct     NUMERIC NOT NULL,
  max_hold_sec     NUMERIC NOT NULL,
  risk_distance    NUMERIC,

  -- 결과. **못 돌렸으면 NULL이다. 0으로 채우지 않는다** — 0은
  -- '거래해서 본전'이라는 뜻이고, 그러면 IGNORE 장부와 구별되지 않는다.
  follow_r     NUMERIC,
  follow_exit  TEXT,
  inverse_r    NUMERIC,
  inverse_exit TEXT,
  -- IGNORE는 컬럼을 두지 않는다. 언제나 0이고, 그건 계산이 아니라 정의다.
  -- 컬럼으로 두면 언젠가 0이 아닌 값이 들어가고 기준선이 흔들린다.

  hold_sec    NUMERIC,
  -- 못 돌린 이유. 비어 있으면 정상.
  skipped     TEXT NOT NULL DEFAULT '',

  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 신호 하나에 장부는 한 벌. 조건을 바꿔 다시 돌리면 덮어쓴다.
  UNIQUE (signal_id)
);

CREATE INDEX IF NOT EXISTS creator_ledger_seg_idx
  ON creator_ledger (user_id, creator, symbol, direction, said_at);
CREATE INDEX IF NOT EXISTS creator_ledger_time_idx
  ON creator_ledger (user_id, said_at DESC);

ALTER TABLE creator_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creator_ledger_service ON creator_ledger;
CREATE POLICY creator_ledger_service ON creator_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 읽기만. 진 신호를 지워 성적을 좋게 만들 수 있으면 이 기록의 존재
-- 이유가 사라진다 — trader_signals와 같은 규칙이다.
DROP POLICY IF EXISTS creator_ledger_owner ON creator_ledger;
CREATE POLICY creator_ledger_owner ON creator_ledger
  FOR SELECT TO authenticated USING (user_id = auth.uid());
