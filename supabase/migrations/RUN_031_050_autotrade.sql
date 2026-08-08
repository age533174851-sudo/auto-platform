-- ═══════════════════════════════════════════════════════════════
-- TRAIGO — 자동매매 예약 표 만들기 (031 + 050)
--
-- **Supabase 대시보드 → SQL Editor에 통째로 붙여넣고 Run** 하세요.
--
-- 왜 이 파일인가
-- ──────────────
-- 화면 아래에 이렇게 떠 있습니다:
--
--     autotrade_schedules 표가 없습니다 — 마이그레이션 031을 적용하세요
--
-- 그 표가 없으면 자동매매 예약을 켜도 **저장할 곳이 없습니다.** 화면에서
-- 무엇을 눌러도 여기서 막힙니다. 다른 문제(배율·연결)보다 이게 먼저입니다.
--
-- 031만 넣으면 안 됩니다
-- ──────────────────────
-- 031은 `(user_id, symbol)`로 한 줄인 옛 모양입니다. 그대로 두면 같은
-- 종목에 전략을 하나밖에 못 돌리고, 두 번째 전략을 켜는 순간 첫 번째가
-- **조용히 덮어써집니다**(upsert가 성공하기 때문입니다).
-- 050이 그 정체를 (user_id, strategy_id, symbol, connection_id, mode)로
-- 넓힙니다. 그래서 둘을 같이 넣습니다.
--
-- 여러 번 실행해도 안전합니다
-- ───────────────────────────
-- 전부 IF NOT EXISTS / 비어 있는 것만 UPDATE 입니다. 중간에 실패해서 다시
-- 돌려도 앞부분이 두 번 만들어지거나 값이 덮이지 않습니다.
--
-- 원본: supabase/migrations/031_autotrade_schedule.sql
--       supabase/migrations/050_schedule_strategy.sql
-- ═══════════════════════════════════════════════════════════════


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

-- ═══════════════════════════════════════════════════════════════
-- 여기부터 050 — 전략 칸 추가 + 예약 정체 재설계
-- ═══════════════════════════════════════════════════════════════

-- 050_schedule_strategy.sql
--
-- **예약에 "무슨 전략인지"를 적는다.**
--
-- 지금까지 `autotrade_schedules`는 `(user_id, symbol)`로 한 줄이었고, 그 줄을
-- 읽는 실행기는 `/api/autotrade/daily-ladder` 하나였다. 즉 "BTCUSDT 자동매매를
-- 켠다"는 사실상 **계단식 전략을 켠다**와 같은 말이었는데, 표에도 화면에도
-- 그 사실이 없다.
--
-- 그래서 두 가지가 불가능했다:
--   · 다른 전략을 켜는 것
--   · 같은 종목에 두 전략을 돌리는 것 (한 줄뿐이라 덮어쓴다)
--
-- 무엇을 바꾸나
-- ─────────────
--   1. strategy_id · strategy_version 칸 추가
--   2. 기존 줄을 **명시적으로** 'daily-ladder'로 이관 — 짐작이 아니다.
--      그 줄을 읽는 실행기가 하나뿐이었으므로 사실이다.
--   3. 한 줄의 정체를 (user_id, strategy_id, symbol, connection_id, mode)로 바꾼다
--
-- 왜 identity를 넓히나
-- ────────────────────
-- (user_id, symbol)이면 같은 종목에 전략 하나만 돌릴 수 있다. 계단식과
-- 분봉 돌파를 같이 시험하려는 순간 한쪽이 다른 쪽을 덮어쓴다 — 그리고
-- 그건 조용히 일어난다. upsert가 성공하기 때문이다.
--
-- **같은 종목에 반대 방향 전략이 붙는 문제는 여기서 풀지 않는다.**
-- 그건 포지션 소유권·충돌 정책이 판정할 일이고, 표의 문제가 아니다.
-- 임의로 netting하지 않는다.

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS strategy_id      TEXT,
  ADD COLUMN IF NOT EXISTS strategy_version TEXT;

-- ── 기존 줄 이관 ──
--
-- **비어 있는 것만 채운다.** 이미 값이 있으면 건드리지 않는다 —
-- 마이그레이션을 두 번 돌려도 사용자가 고른 전략을 덮어쓰면 안 된다.
UPDATE autotrade_schedules
   SET strategy_id = 'daily-ladder'
 WHERE strategy_id IS NULL OR strategy_id = '';

UPDATE autotrade_schedules
   SET strategy_version = '1'
 WHERE strategy_version IS NULL OR strategy_version = '';

ALTER TABLE autotrade_schedules
  ALTER COLUMN strategy_id SET DEFAULT 'daily-ladder';

-- ── 한 줄의 정체를 바꾼다 ──
--
-- 옛 제약(user_id, symbol)을 지우고 넓힌다. 이름은 환경마다 다를 수 있어
-- 있는 것만 지운다.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'autotrade_schedules'::regclass
       AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE autotrade_schedules DROP CONSTRAINT %I', c);
  END LOOP;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DROP INDEX IF EXISTS autotrade_schedules_user_symbol_idx;
DROP INDEX IF EXISTS autotrade_schedules_user_id_symbol_key;

-- **connection_id와 mode까지 정체에 넣는다.**
-- 같은 전략·같은 종목이라도 테스트넷 계좌와 실전 계좌는 다른 예약이다.
-- 하나로 묶으면 테스트넷 예약을 켜는 순간 실전 예약이 덮인다.
CREATE UNIQUE INDEX IF NOT EXISTS autotrade_schedules_identity_idx
  ON autotrade_schedules (user_id, strategy_id, symbol, connection_id, mode);

COMMENT ON COLUMN autotrade_schedules.strategy_id IS
  '어떤 전략인가. registry.ts의 STRATEGIES에 있는 id만 실행된다 — 모르는 값은 실행하지 않고 막는다';
COMMENT ON COLUMN autotrade_schedules.strategy_version IS
  '저장 당시의 전략 버전. 지금 코드와 다르면 임의로 최신 버전을 돌리지 않고 막는다 — 사용자가 검증한 것은 그때의 규칙이다';

-- ═══════════════════════════════════════════════════════════════
-- 확인
--
-- 아래가 1행 나오면 표가 만들어진 것입니다.
-- strategy_id 칸까지 보이면 050까지 들어간 것입니다.
-- ═══════════════════════════════════════════════════════════════
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'autotrade_schedules'
   AND column_name IN ('id', 'user_id', 'symbol', 'strategy_id', 'strategy_version')
 ORDER BY column_name;
