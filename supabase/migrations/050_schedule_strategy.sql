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
