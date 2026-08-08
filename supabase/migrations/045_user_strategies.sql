-- 045_user_strategies.sql
--
-- **전략빌더 전략은 이 브라우저에만 있다.**
--
-- `AutoTradeEngine`이 60초마다 전략을 평가한다. 그런데 그 전략들은
-- `listStrategies()`가 읽고, 그건 이렇다:
--
--   src/lib/strategies/store.ts
--   // 사용자 전략 CRUD (localStorage 기반)
--   window.localStorage.getItem(KEY)
--
-- 즉 전략이 **브라우저 안에만** 있다. 서버는 그 전략이 있는지조차 모른다.
--
-- 그래서 이건 타이머 문제가 아니다
-- ────────────────────────────────
-- 예약 청산은 실행 주소가 이미 서버에 있어서, 그것을 부르는 크론만
-- 붙이면 됐다. 여기는 다르다 — **크론을 붙여도 돌릴 것이 없다.**
-- 서버가 읽을 수 있는 곳에 전략이 없기 때문이다.
--
-- 그리고 이건 실행 문제만이 아니다:
--
--   · 휴대폰에서 만든 전략이 PC에 없다
--   · 브라우저 데이터를 지우면 전략이 사라진다
--   · 시크릿 모드에서는 아예 안 남는다
--   · 기기를 바꾸면 처음부터 다시 만들어야 한다
--
-- 이 표가 그 전제를 바꾼다
-- ────────────────────────
-- 표를 만드는 것이 첫 걸음이다. 이 표가 없으면 서버 실행기를 아무리
-- 잘 만들어도 읽을 것이 없다.
--
-- **다만 이 표만으로 전략이 상시 실행되는 것은 아니다.** 화면이 여기에
-- 저장하도록 바꾸고, 서버 실행기가 이 표를 읽도록 붙이는 것이 남아 있다.
-- 그때까지 화면은 "이 브라우저에만 있습니다"라고 사실대로 적어야 한다.

CREATE TABLE IF NOT EXISTS user_strategies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,

  name          TEXT NOT NULL,
  -- ema_cross / rsi_reversal / breakout / dca / funding_rate / ai_strategy …
  strategy_type TEXT NOT NULL DEFAULT '',
  market        TEXT NOT NULL DEFAULT 'crypto',
  asset         TEXT NOT NULL DEFAULT '',
  timeframe     TEXT NOT NULL DEFAULT '',

  -- 진입 조건·주문·위험 설정. 모양이 계속 바뀌므로 JSONB로 둔다.
  conditions    JSONB NOT NULL DEFAULT '[]'::JSONB,
  order_spec    JSONB NOT NULL DEFAULT '{}'::JSONB,
  risk_spec     JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- ── 생명주기 ──
  --
  -- DRAFT / BACKTESTED / PAPER / SHADOW / TESTNET / LIVE_SMALL / LIVE
  --
  -- **검증 안 된 전략을 토글 하나로 실행할 수 없게 하는 근거다.**
  -- enabled와 따로 두는 이유: '사용자가 켰다'와 '실행해도 되는 단계다'는
  -- 다른 사실이고, 하나로 합치면 검증 단계가 화면에서 사라진다.
  stage         TEXT NOT NULL DEFAULT 'DRAFT',
  enabled       BOOLEAN NOT NULL DEFAULT false,

  -- 이 전략을 무엇이 만들었는가. AI가 만든 것을 검증된 것처럼 다루지 않는다.
  -- AI_GENERATED / FALLBACK_TEMPLATE / MANUAL
  source        TEXT NOT NULL DEFAULT 'MANUAL',

  -- ── 버전 ──
  --
  -- 전략을 고치면 버전이 오른다. **과거 성과를 수정된 전략의 성과와
  -- 섞지 않기 위해서다** — TP/SL을 언제 바꿨는지 모르면 비교가 안 된다.
  version       INTEGER NOT NULL DEFAULT 1,
  -- 복제해서 만든 것이면 어디서 왔는지 남긴다.
  parent_id     UUID REFERENCES user_strategies(id) ON DELETE SET NULL,
  parent_version INTEGER,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_strategies_user_idx
  ON user_strategies (user_id, updated_at DESC);

-- 서버 실행기가 읽을 줄만 빠르게 집는다.
CREATE INDEX IF NOT EXISTS user_strategies_active_idx
  ON user_strategies (enabled, stage) WHERE enabled = true;

COMMENT ON TABLE user_strategies IS
  '전략빌더 전략. 이 표가 생기기 전에는 localStorage에만 있어서 서버가 읽을 수 없었다';
COMMENT ON COLUMN user_strategies.stage IS
  '검증 단계. enabled와 따로 둔다 — 사용자가 켠 것과 실행해도 되는 단계인 것은 다른 사실이다';
COMMENT ON COLUMN user_strategies.version IS
  '전략을 고치면 오른다. 과거 성과를 수정된 전략의 성과와 섞지 않기 위해서다';
