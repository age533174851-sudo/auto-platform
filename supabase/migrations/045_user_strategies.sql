-- 045_user_strategies.sql
--
-- **이 파일의 앞 판은 틀렸다. 고쳐 두는 이유부터 적는다.**
--
-- 앞 판은 이렇게 시작했다:
--
--   CREATE TABLE IF NOT EXISTS user_strategies ( id UUID PRIMARY KEY … )
--
-- 그리고 주석에 "전략빌더 전략은 이 브라우저에만 있다, 크론을 붙여도
-- 돌릴 것이 없다"고 적었다. **둘 다 사실이 아니었다.**
--
--   supabase/migrations/005_user_strategies.sql   표가 이미 있다 (id는 TEXT)
--   src/app/api/strategies/sync/route.ts          pull·push·delete 라우트가 있다
--   src/lib/strategies/sync.ts                    클라이언트 쪽도 있다
--   StrategyBuilderPage.tsx                       실제로 부르고 있다
--
-- 그래서 앞 판은 **조용한 무효 파일**이었다. 표가 이미 있으니
-- `IF NOT EXISTS`가 통째로 건너뛰고, 적용해도 아무 일이 안 일어난다.
-- 그런데 파일 이름과 주석은 "표를 만든다"고 말하니, 적용한 사람은
-- stage·version 칸이 생긴 줄 안다. **조용히 틀리는 쪽이 언제나 더 나쁘다.**
--
-- 그리고 id 타입이 다르다. 005는 TEXT('str-m8x1k2-a9f3')이고 앞 판은
-- UUID였다. 만약 표가 없는 새 프로젝트에 앞 판이 먼저 적용됐다면,
-- 기존 sync 라우트의 INSERT가 전부 깨진다.
--
-- 이 판이 하는 일
-- ───────────────
-- 표를 만들지 않는다. **005가 만든 표에 없는 칸만 더한다.**
-- 그래서 이 파일은 표가 있든 없든(005 다음에 도는 한) 안전하다.

-- 005가 아직 안 돈 환경을 위한 최소 보장. 005의 정의를 그대로 따른다
-- (id는 TEXT다 — 브라우저가 만든 'str-…'를 그대로 쓴다).
CREATE TABLE IF NOT EXISTS user_strategies (
  id          TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  asset       TEXT NOT NULL DEFAULT '',
  market      TEXT NOT NULL DEFAULT 'crypto',
  timeframe   TEXT NOT NULL DEFAULT '',
  mode        TEXT NOT NULL DEFAULT 'paper',
  action      TEXT NOT NULL DEFAULT 'buy',
  conditions  JSONB NOT NULL DEFAULT '[]'::JSONB,
  order_spec  JSONB NOT NULL DEFAULT '{}'::JSONB,
  risk        JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled     BOOLEAN NOT NULL DEFAULT false,
  source      TEXT DEFAULT 'manual',
  prompt      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 여기부터가 이 마이그레이션의 알맹이 ───────────────────

-- **검증 단계.** enabled와 따로 두는 이유: '사용자가 켰다'와
-- '실행해도 되는 단계다'는 다른 사실이고, 하나로 합치면 검증 단계가
-- 화면에서 사라진다. 토글 하나로 백테스트도 안 한 전략이 실전에 간다.
--
-- DRAFT / BACKTESTED / PAPER / SHADOW / TESTNET / LIVE_SMALL / LIVE
ALTER TABLE user_strategies
  ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'DRAFT';

-- **전략을 고치면 오른다.** 과거 성과를 수정된 전략의 성과와 섞지
-- 않기 위해서다 — TP/SL을 언제 바꿨는지 모르면 비교 자체가 안 된다.
ALTER TABLE user_strategies
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 복제해서 만든 것이면 어디서 왔는지 남긴다. 005의 id가 TEXT이므로
-- 여기도 TEXT다 — 타입을 UUID로 두면 참조가 아예 안 걸린다.
ALTER TABLE user_strategies
  ADD COLUMN IF NOT EXISTS parent_id TEXT;
ALTER TABLE user_strategies
  ADD COLUMN IF NOT EXISTS parent_version INTEGER;

-- ema_cross / rsi_reversal / breakout / dca / funding_rate …
ALTER TABLE user_strategies
  ADD COLUMN IF NOT EXISTS strategy_type TEXT NOT NULL DEFAULT '';

-- 서버 실행기가 읽을 줄만 빠르게 집는다.
CREATE INDEX IF NOT EXISTS user_strategies_active_idx
  ON user_strategies (enabled, stage) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS user_strategies_user_idx
  ON user_strategies (user_id, updated_at DESC);

COMMENT ON COLUMN user_strategies.stage IS
  '검증 단계. enabled와 따로 둔다 — 사용자가 켠 것과 실행해도 되는 단계인 것은 다른 사실이다';
COMMENT ON COLUMN user_strategies.version IS
  '전략을 고치면 오른다. 과거 성과를 수정된 전략의 성과와 섞지 않기 위해서다';

-- ── 남아 있는 것 ──────────────────────────────────────────
--
-- **이 표가 있다고 전략이 상시 실행되는 것은 아니다.**
-- 서버가 읽을 수는 있는데, 읽고 돌리는 실행기가 아직 없다.
-- 그때까지 화면은 "이 화면에서만 돕니다"라고 사실대로 적어야 한다.
--
-- 그리고 미러링은 best-effort다 — 조용히 실패하면 서버의 것은 옛날
-- 것이고, 그 상태로 실행기를 붙이면 옛날 전략이 돈다.
