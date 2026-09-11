-- 078_live_orders_stop_policy.sql
--
-- **고정 손절을 쓰지 않는 주문이라는 사실을 장부에 적는다.**
--
-- 왜 칸이 필요한가
-- ────────────────
-- 복구 경로(`attachStopIfMissing`)는 `stop_loss`가 비어 있으면 아무것도
-- 하지 않는다. 그래서 고정 손절이 없는 프로필은 지금도 손절이 다시
-- 붙지는 않는다. **그런데 그것은 값이 없어서 생긴 결과이지 규칙이 아니다.**
--
-- 이 저장소에서 반복된 고장이 정확히 그 모양이다 — 우연히 맞아 있던 것이
-- 나중에 다른 이유로 값이 채워지면서 조용히 깨진다. 예를 들어 누가
-- 진입 시점 참고 손절가를 기록용으로 `stop_loss`에 넣으면, 복구 경로는
-- 그것을 "걸어야 할 손절"로 읽고 100배 포지션에 STOP_MARKET을 새로 낸다.
--
-- 그래서 **의도를 값으로 적는다.** `NO_FIXED_SL`이면 복구 경로가 이유를
-- 말하고 멈춘다. 판단이 `stop_loss`의 유무가 아니라 정책에서 나온다.
--
-- 기존 행에 미치는 영향
-- ─────────────────────
-- NULL로 남는다. 기존 주문 경로는 이 칸을 쓰지 않으므로 계속 NULL이고,
-- 복구 경로도 NULL을 지금까지와 똑같이 다룬다(= `stop_loss`를 본다).
-- 값을 채우는 것은 고정 손절을 쓰지 않는 프로필뿐이다.
--
-- 왜 NOT NULL이 아닌가
-- ────────────────────
-- 이미 쌓인 행에 기본값을 채우면 "그때 그렇게 판단했다"는 거짓 기록이
-- 생긴다. 모르는 것은 NULL로 둔다.

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS stop_policy text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'live_orders_stop_policy_known'
  ) THEN
    ALTER TABLE public.live_orders
      ADD CONSTRAINT live_orders_stop_policy_known
      CHECK (stop_policy IS NULL OR stop_policy IN ('FIXED_SL', 'NO_FIXED_SL'));
  END IF;
END $$;

COMMENT ON COLUMN public.live_orders.stop_policy IS
  'FIXED_SL | NO_FIXED_SL | NULL(기록 없음). NO_FIXED_SL이면 복구·청산 감시가 고정 손절을 다시 붙이지 않는다.';
