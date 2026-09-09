-- 080_execution_profile_selective.sql
--
-- **전면 금지를 조합 하나 허용으로 바꾼다.**
--
-- 077은 실행 프로필을 가진 예약을 켤 수 없게 했다:
--
--   CHECK (execution_profile_id IS NULL OR enabled = false)
--
-- 그때는 실행기가 계약을 읽지 않았으니 맞는 규칙이었다. 켤 수 있게
-- 두면 "화면은 연구용인데 실제는 ATR"이 정식 기능이 된다.
--
-- 이제 딱 한 조합에서만 실행 의미가 실제로 연결됐다. 그래서 **그
-- 조합만** 연다. 전면 해제가 아니다.
--
--   실행 프로필  MAX_LEV_100X
--   프리셋       EXACT_100X
--   계약 버전    2
--   운영 모드    TESTNET
--   증거금 배정  입력돼 있을 것
--
-- 왜 DB가 이걸 알아야 하는가
-- ──────────────────────────
-- 코드 층(POST·PATCH·실행 직전)에도 같은 판정이 있다. 그런데 워커는 웹
-- 평가기를 **빌드 시점에 번들**한다(`worker/src/index.ts` → `rootDir: ".."`).
-- 배포가 엇갈리는 창에서 구 워커는 이 조합을 모르는 옛 코드로 돈다.
-- 그 창을 코드 층만으로는 막지 못한다. 077이 DB 제약을 둔 이유가 그것이고,
-- 여기서도 같은 이유로 DB에 남긴다.
--
-- 왜 LIVE를 열지 않는가
-- ─────────────────────
-- 이 프로필은 고정 손절을 걸지 않는다. 그것을 대신할 자동 종료 권한이
-- 실제로 배선돼 있다는 증거가 아직 없다 — `exitLifecycle`에서 손절 없이
-- 도는 것은 시간 청산 하나뿐이고, 그 정책조차 전략 id로만 조회되어
-- 이 실행 프로필과 연결이 없다. 증거가 나오기 전에는 실계좌를 열지 않는다.
--
-- 왜 증거금 배정이 조건인가
-- ─────────────────────────
-- 손절이 없으면 크기를 정할 근거가 그 값 하나뿐이다. 비어 있으면 크기를
-- 만들 수 없고, 만들 수 없는 예약을 켜 두면 켜져 있는데 아무것도 안 하는
-- 상태가 된다 — 사용자는 도는 줄 안다.
--
-- `_complete`는 그대로 둔다. 반쪽 선택은 지금도 선택이 아니다.

ALTER TABLE public.autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_execution_profile_dormant;

ALTER TABLE public.autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_execution_profile_selective;

ALTER TABLE public.autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_execution_profile_selective
  CHECK (
    execution_profile_id IS NULL
    OR enabled = false
    OR (
      execution_profile_id = 'MAX_LEV_100X'
      AND execution_preset_id = 'EXACT_100X'
      AND execution_contract_version = 2
      AND mode = 'TESTNET'
      AND margin_allocation_pct IS NOT NULL
    )
  );

COMMENT ON CONSTRAINT autotrade_schedules_execution_profile_selective
  ON public.autotrade_schedules IS
  '실행 프로필을 가진 예약은 검증된 조합에서만 켤 수 있다: MAX_LEV_100X + EXACT_100X + 계약 v2 + TESTNET + 증거금 배정 입력. 나머지는 enabled=false여야 한다.';
