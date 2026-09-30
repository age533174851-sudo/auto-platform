-- 089_live_orders_execution_identity.sql
--
-- 진입 시점의 실행 계약 정체를 live_orders에 남긴다.
--
-- 왜 필요한가
-- ──────────
-- 예약에는 execution_profile_id / execution_preset_id / execution_contract_version가
-- 있지만 주문 장부에는 남지 않았다. 그래서 포지션을 나중에 볼 때 "이 주문이
-- Exact100X 계약으로 실제 진입한 것인가"를 증명할 수 없고, leverage=100 /
-- isolated / NO_FIXED_SL 같은 결과값으로 역추정하게 된다.
--
-- 결과값은 정체가 아니다. 같은 숫자를 다른 전략도 만들 수 있고, 계약 버전이
-- 달라져도 숫자가 우연히 같을 수 있다. 그래서 **진입을 승인한 세 축 자체**를
-- 주문 의도와 함께 저장한다.
--
-- 기존 행은 전부 NULL로 남긴다. 과거 주문에 계약을 소급 추정하지 않는다.
-- 세 칸은 all-null 또는 all-set만 허용한다.

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS execution_profile_id text,
  ADD COLUMN IF NOT EXISTS execution_preset_id text,
  ADD COLUMN IF NOT EXISTS execution_contract_version int;

ALTER TABLE public.live_orders
  DROP CONSTRAINT IF EXISTS live_orders_execution_identity_complete;

ALTER TABLE public.live_orders
  ADD CONSTRAINT live_orders_execution_identity_complete
  CHECK (
    (execution_profile_id IS NULL
     AND execution_preset_id IS NULL
     AND execution_contract_version IS NULL)
    OR
    (execution_profile_id IS NOT NULL
     AND execution_preset_id IS NOT NULL
     AND execution_contract_version IS NOT NULL)
  );

COMMENT ON COLUMN public.live_orders.execution_profile_id IS
  '진입 승인 시 해석된 실행 프로필 id. NULL은 과거/비계약 주문이며 추정하지 않는다.';
COMMENT ON COLUMN public.live_orders.execution_preset_id IS
  '진입 승인 시 해석된 실행 프리셋 id. profile/version과 한 묶음이다.';
COMMENT ON COLUMN public.live_orders.execution_contract_version IS
  '진입 승인 시 해석된 실행 계약 버전. 숫자 결과로 역추정하지 않는다.';
