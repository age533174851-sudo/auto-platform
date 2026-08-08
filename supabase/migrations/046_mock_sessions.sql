-- 046_mock_sessions.sql
--
-- **모의 자동매매가 새로고침 한 번에 사라진다.**
--
--   src/components/MockAutoTrade.tsx
--   const [positions, setPositions] = useState([]);
--   const [cash, setCash] = useState(SEED);
--
-- 세션이 컴포넌트 상태 안에만 있다. 탭을 닫으면 끝이고, 새로고침하면
-- 종잣돈으로 돌아간다. 사흘 돌린 모의 성과가 실수로 새로고침 한 번에
-- 없어진다.
--
-- 옮기는 순간 더 위험한 실수가 가능해진다
-- ────────────────────────────────────────
-- 세션을 서버에 저장하면 "12시간 꺼져 있었다"는 사실이 남는다. 그러면
-- 놓친 720번의 틱을 되돌려 계산하고 싶어진다. **하면 안 된다:**
--
--   · 그 구간의 시장 움직임을 우리는 모른다. 1분봉을 다시 받아 와도
--     그건 체결이 아니라 재구성이다
--   · 지어낸 체결은 없던 거래를 만든다
--   · 그 성과를 보고 사용자는 실전 전환을 결정한다.
--     **거짓 성과가 실제 돈을 움직인다**
--
-- 그래서 이 표에는 따라잡기용 칸이 없고, 대신 gap_count/gap_ms가 있다.
-- **빈 구간은 채우는 것이 아니라 세는 것이다.**
--
-- 왜 config_version이 있는가
-- ──────────────────────────
-- 돌던 중에 레버리지를 3배에서 20배로 바꿨다고 하자. 판이 없으면
-- 3배로 번 것과 20배로 잃은 것이 한 줄에 섞이고, 어느 설정이 좋았는지
-- 영영 알 수 없다. 세션을 지우자는 게 아니라 **경계를 남기자는 것이다.**

CREATE TABLE IF NOT EXISTS mock_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  -- 같은 사용자가 여러 모의를 동시에 돌릴 수 있다 (전략별·심볼별)
  scope_key      TEXT NOT NULL DEFAULT '',

  -- ── 성과의 출발점 ──
  --
  -- **종잣돈이 없으면 수익률을 낼 수 없다.** NULL을 0으로 채우면
  -- 수익률이 종잣돈만큼 통째로 틀린다.
  seed           NUMERIC NOT NULL,
  cash           NUMERIC NOT NULL,

  positions      JSONB NOT NULL DEFAULT '[]'::JSONB,
  open_orders    JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- 마지막으로 본 가격. 평가에는 쓰지 않는다 —
  -- **멈춘 시계로 손익을 재면 급락 중에도 화면이 평온하다.**
  -- 재개할 때 "그때는 얼마였는지"를 보여주는 용도다.
  last_price     JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- 실제로 한 틱을 돈 시각. NULL은 '한 번도 안 돌았다'이고
  -- '1970년에 돌았다'가 아니다.
  last_tick_at   TIMESTAMPTZ,
  interval_sec   INTEGER NOT NULL DEFAULT 60,

  -- RUNNING / PAUSED / STOPPED / GAP
  status         TEXT NOT NULL DEFAULT 'STOPPED',

  -- 설정 판. 바꾸면 오르고, 성과는 판 단위로 끊어 센다.
  config         JSONB NOT NULL DEFAULT '{}'::JSONB,
  config_version INTEGER NOT NULL DEFAULT 1,

  -- ── 빈 구간 ──
  --
  -- 되돌려 계산하지 않는 대신 센다. 성과 옆에 이 숫자가 있어야
  -- "수익률 12%"를 제대로 읽을 수 있다 — 그중 절반이 꺼져 있었다면
  -- 그건 연속 운용의 결과가 아니다.
  gap_count      INTEGER NOT NULL DEFAULT 0,
  gap_ms         BIGINT  NOT NULL DEFAULT 0,

  started_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, scope_key)
);

CREATE INDEX IF NOT EXISTS mock_sessions_user_idx
  ON mock_sessions (user_id, updated_at DESC);

COMMENT ON TABLE mock_sessions IS
  '모의 자동매매 세션. 여기 든 잔고는 실제 자산이 아니다 — 지갑 총자산에 더하지 않는다';
COMMENT ON COLUMN mock_sessions.last_tick_at IS
  'NULL은 한 번도 안 돌았다는 뜻이다. 0이나 1970년으로 읽으면 빈 구간 계산이 통째로 틀린다';
COMMENT ON COLUMN mock_sessions.gap_count IS
  '꺼져 있던 구간의 수. 그 구간은 되돌려 계산하지 않는다 — 지어낸 체결은 없던 거래를 만들고, 그 성과를 보고 실전 전환을 결정하게 된다';
COMMENT ON COLUMN mock_sessions.config_version IS
  '설정 판. 바꾸면 오른다. 판이 다르면 성과를 한 줄로 잇지 않는다';
COMMENT ON COLUMN mock_sessions.last_price IS
  '마지막으로 본 가격. 평가에는 쓰지 않는다 — 멈춘 시계로 손익을 재면 급락이 안 보인다';

-- ── RLS ───────────────────────────────────────────────────
--
-- 모의라도 남의 것이 보이면 안 된다. 전략과 성과가 그대로 노출된다.
ALTER TABLE mock_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY mock_sessions_own ON mock_sessions
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
