-- 079_schedule_margin_allocation.sql
--
-- **증거금 배정 비율은 예약이 갖는다. 프로필이 아니라.**
--
-- 왜 프로필 상수가 아닌가
-- ───────────────────────
-- 처음에는 `StrategyProfile.marginAllocationPct`로 뒀다. 그러면 계약
-- 정본에 `null`이 박히고, 사용자가 나중에 화면에서 비율을 입력해도
-- **계약은 계속 그 null을 가리킨다.** 값이 두 곳에 생기고 실행은 옛 쪽을
-- 읽는 구조가 된다 — 이 저장소가 반복해서 없애 온 모양이다.
--
-- 배정 비율은 "이 예약에 얼마를 걸 것인가"라서 예약마다 다르다. 그러니
-- 예약 줄에 있어야 하고, 계약에는 **그 값을 쓴다는 사실**(`sizingPolicy`)만
-- 남는다.
--
-- 기존 margin_pct와 무엇이 다른가
-- ───────────────────────────────
-- `margin_pct`는 손절 거리 기반 사이징에서 **증거금 상한**으로 쓰인다.
-- 화면 기본값이 '10'이고, 사용자가 고른 적 없어도 그 값이 들어간다.
--
-- 이 칸은 그것과 다르다. 손절이 없는 프로필에서 **크기를 정하는 유일한
-- 근거**라, 기본값이 있으면 안 된다. 사용자가 이 예약을 위해 직접 넣은
-- 값일 때만 값이 있고, 없으면 NULL이며 그 예약은 주문하지 않는다.
-- `margin_pct`를 여기로 상속하지 않는다.

ALTER TABLE public.autotrade_schedules
  ADD COLUMN IF NOT EXISTS margin_allocation_pct numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'autotrade_schedules_margin_allocation_range'
  ) THEN
    ALTER TABLE public.autotrade_schedules
      ADD CONSTRAINT autotrade_schedules_margin_allocation_range
      CHECK (
        margin_allocation_pct IS NULL
        OR (margin_allocation_pct > 0 AND margin_allocation_pct <= 100)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.autotrade_schedules.margin_allocation_pct IS
  '가용 잔고 대비 1회 증거금 배정 비율(%). 사용자가 이 예약에 직접 입력한 값만 들어간다. NULL이면 미지정이고 MARGIN_ALLOCATION 사이징은 주문하지 않는다. margin_pct를 상속하지 않는다.';
