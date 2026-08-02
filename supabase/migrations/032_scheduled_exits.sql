-- 032_scheduled_exits.sql
--
-- **시간 예약 청산** — "내일 15:30에 판다".
--
-- 이 표에서 가장 위험한 것
-- ────────────────────────
-- 예약해 놓고 안 나가는 것이다. 화면에 "15:30 매도 예약됨"이 뜨면 사람은
-- 그 시각에 팔릴 것을 전제로 다른 결정을 한다 — 자러 가거나, 다른 포지션을
-- 더 연다. 그 전제가 틀리면 예약 기능이 없는 것보다 나쁘다.
--
-- 그래서 **실행 결과를 반드시 남긴다.** 성공만 적으면 "아직 시각이 안 됐다"와
-- "시각이 지났는데 아무도 안 봤다"가 화면에서 똑같아 보인다.
--
-- 왜 fired_at과 result를 나눠 두는가
-- ──────────────────────────────────
-- fired_at은 '이 예약을 처리했다', result는 '어떻게 됐다'다. 둘을 합치면
-- 주문이 실패한 예약이 '아직 안 됨'으로 남아 다음 실행기가 또 낸다.
-- 한 번 처리한 예약은 결과가 무엇이든 다시 내지 않는다.

CREATE TABLE IF NOT EXISTS scheduled_exits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 어느 연결로 낼 것인가. **NULL이면 주문할 수 없다**
  connection_id  UUID,
  symbol         TEXT NOT NULL,

  -- 'CLOSE' — 전량 청산. 지금은 이것뿐이다.
  -- 문자열로 두는 이유: 나중에 'REDUCE'가 생겨도 표를 안 고쳐도 된다.
  action         TEXT NOT NULL DEFAULT 'CLOSE',

  -- 일부만 닫을 때의 비율(1~100). NULL이면 전량.
  -- **0을 기본값으로 두지 않는다** — 0%는 '아무것도 안 판다'인데,
  -- 그게 기본이면 예약이 나가도 포지션이 그대로 남는다.
  portion_pct    NUMERIC CHECK (portion_pct IS NULL OR (portion_pct > 0 AND portion_pct <= 100)),

  -- 실행 시각. **UTC로 저장한다.**
  -- 화면이 고른 '오늘 15:30'은 시간대에 따라 다른 순간이므로, 화면에서
  -- Intl로 UTC로 바꿔 넣는다. 여기에 벽시계 시각을 넣으면 안 된다.
  run_at         TIMESTAMPTZ NOT NULL,
  -- 사용자가 무슨 시간대로 골랐는지. 화면에 되돌려 보여줄 때 쓴다 —
  -- 이게 없으면 서울에서 만든 예약이 다른 기기에서 다른 시각으로 보인다.
  time_zone      TEXT NOT NULL DEFAULT 'Asia/Seoul',

  enabled        BOOLEAN NOT NULL DEFAULT true,

  -- 처리한 시각. **결과가 무엇이든 채운다** — 실패한 예약을 '아직 안 됨'
  -- 으로 남기면 다음 실행기가 또 낸다.
  fired_at       TIMESTAMPTZ,
  -- 'ok' | 'failed' | 'stale' | 'no_position'
  --
  -- stale: 너무 늦어서 자동 실행하지 않았다. 이건 실패가 아니라
  --        **일부러 안 낸 것**이고, 둘을 합치면 왜 안 나갔는지 모른다.
  result         TEXT,
  detail         TEXT,
  -- 예정보다 얼마나 늦게 처리됐나(ms). 실행기가 제대로 도는지가 여기 남는다.
  lateness_ms    BIGINT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 실행기가 매번 훑는 질의: 아직 안 나갔고 켜져 있는 것들.
CREATE INDEX IF NOT EXISTS scheduled_exits_pending_idx
  ON scheduled_exits (run_at) WHERE fired_at IS NULL AND enabled = true;

CREATE INDEX IF NOT EXISTS scheduled_exits_user_idx
  ON scheduled_exits (user_id, run_at DESC);

ALTER TABLE scheduled_exits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_exits_service ON scheduled_exits;
CREATE POLICY scheduled_exits_service ON scheduled_exits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS scheduled_exits_owner ON scheduled_exits;
CREATE POLICY scheduled_exits_owner ON scheduled_exits
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
