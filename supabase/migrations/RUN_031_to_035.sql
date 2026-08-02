-- RUN_031_to_035.sql
--
-- **031~035를 한 번에. 통째로 복사해서 Supabase SQL Editor에 붙이고 Run.**
--
-- 왜 이 파일이 필요한가
-- ─────────────────────
-- 화면에 "autotrade_schedules 표가 없습니다"가 떴다. 즉 031이 안 들어갔다.
-- 그런데 034·035는 그 표에 칸을 **더하는** 마이그레이션이다. 표가 없는
-- 상태에서 실행하면 "relation does not exist"로 죽는다. 순서가 하나
-- 어긋나면 뒤가 전부 무너지는 구조라, 순서를 사람이 지키게 두지 않는다.
--
-- 몇 번을 돌려도 안전하다
-- ───────────────────────
-- 전부 IF NOT EXISTS / DROP ... IF EXISTS다. 이미 들어간 것이 있어도
-- 덮어쓰거나 지우지 않는다. **어디까지 했는지 기억하지 않아도 된다** —
-- 기억에 의존하는 절차는 지금처럼 틀린다.
--
-- 마지막에 확인 질의가 붙어 있다
-- ──────────────────────────────
-- Run 하면 표가 하나 나온다. 그 표가 '됐다'의 증거다. 에러가 안 났다는
-- 것은 증거가 아니다 — 이번에도 에러 없이 안 들어가 있었다.

-- ════════════════════════════════════════════════════════════
-- 031 — 자동매매 예약 (크론이 읽는 표)
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS autotrade_schedules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  symbol         TEXT NOT NULL DEFAULT 'BTCUSDT',
  connection_id  UUID,
  mode           TEXT NOT NULL DEFAULT 'TESTNET',
  enabled        BOOLEAN NOT NULL DEFAULT false,
  last_run_at    TIMESTAMPTZ,
  last_result    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

-- ════════════════════════════════════════════════════════════
-- 032 — 시간 예약 청산
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS scheduled_exits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id  UUID,
  symbol         TEXT NOT NULL,
  action         TEXT NOT NULL DEFAULT 'CLOSE',
  portion_pct    NUMERIC CHECK (portion_pct IS NULL OR (portion_pct > 0 AND portion_pct <= 100)),
  run_at         TIMESTAMPTZ NOT NULL,
  time_zone      TEXT NOT NULL DEFAULT 'Asia/Seoul',
  enabled        BOOLEAN NOT NULL DEFAULT true,
  fired_at       TIMESTAMPTZ,
  result         TEXT,
  detail         TEXT,
  lateness_ms    BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- ════════════════════════════════════════════════════════════
-- 033 — 모의 포지션 마진 모드 (격리/교차)
-- ════════════════════════════════════════════════════════════
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS margin_mode TEXT NOT NULL DEFAULT 'ISOLATED';

ALTER TABLE paper_positions
  DROP CONSTRAINT IF EXISTS paper_positions_margin_mode_chk;
ALTER TABLE paper_positions
  ADD CONSTRAINT paper_positions_margin_mode_chk
  CHECK (margin_mode IN ('ISOLATED', 'CROSSED'));

-- ════════════════════════════════════════════════════════════
-- 034 — 자동매매 크기·배율 상한
-- ════════════════════════════════════════════════════════════
ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS leverage_cap INTEGER;
ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS risk_pct NUMERIC;

ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_lev_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_lev_chk
  CHECK (leverage_cap IS NULL OR (leverage_cap >= 1 AND leverage_cap <= 125));

ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_risk_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_risk_chk
  CHECK (risk_pct IS NULL OR (risk_pct > 0 AND risk_pct <= 100));

-- ════════════════════════════════════════════════════════════
-- 035 — 얼마나 자주 볼 것인가 (분)
-- ════════════════════════════════════════════════════════════
ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS interval_min INTEGER NOT NULL DEFAULT 1440;

ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_interval_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_interval_chk
  CHECK (interval_min >= 1 AND interval_min <= 10080);

-- ════════════════════════════════════════════════════════════
-- 확인 — **이 결과를 보고 판단한다. 에러가 없다는 것은 증거가 아니다.**
-- ════════════════════════════════════════════════════════════
--
-- 기대하는 결과: 아래 8줄이 전부 '있음'.
-- 하나라도 '없음'이면 그 줄 위쪽 블록만 다시 돌린다.

SELECT '표 autotrade_schedules' AS 항목,
       CASE WHEN to_regclass('public.autotrade_schedules') IS NULL THEN '없음' ELSE '있음' END AS 상태
UNION ALL SELECT '표 scheduled_exits',
       CASE WHEN to_regclass('public.scheduled_exits') IS NULL THEN '없음' ELSE '있음' END
UNION ALL SELECT '칸 autotrade_schedules.leverage_cap',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name='autotrade_schedules' AND column_name='leverage_cap') THEN '있음' ELSE '없음' END
UNION ALL SELECT '칸 autotrade_schedules.risk_pct',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name='autotrade_schedules' AND column_name='risk_pct') THEN '있음' ELSE '없음' END
UNION ALL SELECT '칸 autotrade_schedules.interval_min',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name='autotrade_schedules' AND column_name='interval_min') THEN '있음' ELSE '없음' END
UNION ALL SELECT '칸 paper_positions.margin_mode',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_name='paper_positions' AND column_name='margin_mode') THEN '있음' ELSE '없음' END
UNION ALL SELECT '표 cron_runs (029)',
       CASE WHEN to_regclass('public.cron_runs') IS NULL THEN '없음' ELSE '있음' END
UNION ALL SELECT '표 trader_signals (030)',
       CASE WHEN to_regclass('public.trader_signals') IS NULL THEN '없음' ELSE '있음' END;
