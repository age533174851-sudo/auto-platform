-- 031_autotrade_schedule.sql
--
-- **자동매매를 누구에게 무엇으로 돌릴 것인가.**
--
-- 왜 이 표가 없어서 자동매매가 한 번도 안 돌았나
-- ─────────────────────────────────────────────
-- 진입 엔진(daily-ladder)은 POST로만 실행되고, 실행하려면 누가·어느
-- 종목·어느 연결로 할지를 본문에 받아야 한다.
--
-- 그런데 **Vercel 크론은 GET만 보내고 본문을 못 싣는다.** 그래서
-- vercel.json에 등록할 수가 없었고, 실제로 등록되어 있지도 않았다.
--
-- 결과: 화면에는 자동매매 설정이 다 있는데 **한 번도 실행된 적이 없다.**
-- 테스트넷에서도 안 돌았다. 에러도 안 났다 — 아무 일도 안 일어났으니까.
--
-- 이 표가 그 빈칸이다. 크론은 GET으로 들어와서 이 표를 읽고, 켜져 있는
-- 줄마다 진입 엔진을 부른다.
--
-- 왜 사용자별로 두는가
-- ────────────────────
-- 크론에는 로그인한 사람이 없다. 누구 계좌로 주문할지를 표에서 읽어야
-- 한다. 환경변수에 사용자 id를 박으면 사용자가 늘 때마다 배포해야 하고,
-- 무엇보다 **그 값이 틀려도 아무도 모른다.**

CREATE TABLE IF NOT EXISTS autotrade_schedules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,

  symbol         TEXT NOT NULL DEFAULT 'BTCUSDT',

  -- 어느 연결로 주문할 것인가. **NULL이면 주문할 수 없다** —
  -- 진입 엔진이 connectionId 없이는 거부한다.
  connection_id  UUID,

  -- 운영 사다리: UI_DEMO · PAPER · TESTNET · SHADOW_LIVE · LIVE_SMALL · LIVE_LIMITED
  --
  -- **기본값이 TESTNET이다.** 실전은 명시적으로 올려야 한다 — 이 표에
  -- 줄을 만드는 것만으로 실제 돈이 나가면 안 된다.
  mode           TEXT NOT NULL DEFAULT 'TESTNET',

  enabled        BOOLEAN NOT NULL DEFAULT false,

  -- 마지막으로 실행한 시각과 결과. **없으면 한 번도 안 돈 것이다.**
  -- 이 칸이 계속 비어 있으면 크론이 안 도는 것이고, 그게 지금까지
  -- 아무도 몰랐던 바로 그 상태다.
  last_run_at    TIMESTAMPTZ,
  last_result    TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 같은 사람이 같은 종목을 두 줄 넣으면 하루에 두 번 진입한다.
  UNIQUE (user_id, symbol)
);

CREATE INDEX IF NOT EXISTS autotrade_schedules_enabled_idx
  ON autotrade_schedules (enabled) WHERE enabled = true;

ALTER TABLE autotrade_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS autotrade_schedules_service ON autotrade_schedules;
CREATE POLICY autotrade_schedules_service ON autotrade_schedules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS autotrade_schedules_owner ON autotrade_schedules;
CREATE POLICY autotrade_schedules_owner ON autotrade_schedules
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
