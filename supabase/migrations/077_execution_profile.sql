-- 077_execution_profile.sql
--
-- 실행 프로필 선택을 예약에 저장한다 — **세 칸이 한 덩어리다.**
--
-- 왜 세 칸인가
-- ────────────
-- 이 저장소의 실행 설정은 두 층이다. 기본 프로필(SCALP_HIGH_LEV 등) 위에
-- 위험 프리셋(STABILIZE · RESEARCH)이 얹힌다. 한 칸으로 적으면
-- SCALP_HIGH_LEV + RESEARCH(25배)와 SCALP_HIGH_LEV + STABILIZE(5배)를
-- 구분할 수 없다. 다섯 배 차이가 같은 값으로 남는다.
--
-- 세 번째 칸은 계약 버전이다. 프리셋의 위험 0.25%가 나중에 0.4%로 바뀌면
-- 같은 예약이 다른 의미로 실행된다 — 버전이 그 변화를 가리킨다.
--
-- 왜 지금은 켤 수 없는가 (dormant)
-- ────────────────────────────────
-- 이 마이그레이션과 함께 나가는 코드는 계약을 **저장하고 전달만** 한다.
-- 실행기는 아직 이 값을 읽지 않는다. 그러니 이 칸이 채워진 예약을 켤 수
-- 있게 두면 "화면은 연구용인데 실제는 ATR"이라는, 지금 없애려는 바로 그
-- 고장을 정식 기능으로 만드는 셈이다.
--
-- 코드로만 막으면 부족하다. Worker는 웹의 evaluator를 **빌드 시점에
-- 번들**하므로(worker/src/index.ts → ../../src/lib/autotrade/evaluationRunner),
-- 배포가 엇갈리는 동안 구 Worker는 이 칸을 모르는 옛 코드로 계속 돈다.
-- 그래서 DB가 마지막 방어선이다 — 켜진 채로 프로필을 가진 행이 **존재할
-- 수 없게** 한다.
--
-- 1C에서 실행 의미가 실제로 연결되면 아래 dormant 제약만 정확히 떼어낸다:
--   ALTER TABLE autotrade_schedules
--     DROP CONSTRAINT autotrade_schedules_execution_profile_dormant;
-- `_complete` 제약은 그대로 둔다. 반쪽 선택은 그때도 선택이 아니다.

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS execution_profile_id       text,
  ADD COLUMN IF NOT EXISTS execution_preset_id        text,
  ADD COLUMN IF NOT EXISTS execution_contract_version int;

-- 세 칸은 전부 있거나 전부 없다. 반쪽은 추측을 부른다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_execution_profile_complete;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_execution_profile_complete
  CHECK (
    (execution_profile_id IS NULL
     AND execution_preset_id IS NULL
     AND execution_contract_version IS NULL)
    OR
    (execution_profile_id IS NOT NULL
     AND execution_preset_id IS NOT NULL
     AND execution_contract_version IS NOT NULL)
  );

-- 프로필을 가진 예약은 켤 수 없다 (1A 한정).
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_execution_profile_dormant;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_execution_profile_dormant
  CHECK (execution_profile_id IS NULL OR enabled = false);
