-- 035_autotrade_interval.sql
--
-- **얼마나 자주 진입을 볼 것인가.**
--
-- 왜 필요한가
-- ───────────
-- Vercel 무료 플랜은 크론을 **하루 1회**만 허용한다. 그래서 자동매매가
-- 하루 한 번 진입 여부를 본다. 단타를 하려면 그 주기로는 안 된다.
--
-- 그런데 진입 엔진을 분 단위로 부르면, 조건이 맞는 동안 **매 분 진입**한다.
-- 그건 자동매매가 아니라 사고다. 그래서 "얼마나 자주 볼 것인가"를 줄마다
-- 저장하고, 그보다 자주 부르면 건너뛴다.
--
-- 기본값이 1440(하루)인 이유
-- ──────────────────────────
-- 지금 돌고 있는 예약의 동작을 바꾸지 않기 위해서다. 이 칸이 생겼다는
-- 이유만으로 하루 한 번 돌던 것이 분 단위가 되면, 아무도 고르지 않은
-- 변화가 실계좌에서 일어난다.

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS interval_min INTEGER NOT NULL DEFAULT 1440;

-- 1분보다 자주 보게 두지 않는다. 거래소 레이트리밋과 수수료 양쪽에서
-- 의미가 없고, 그보다 잦은 진입은 사람이 확인할 수 없다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_interval_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_interval_chk
  CHECK (interval_min >= 1 AND interval_min <= 10080);
