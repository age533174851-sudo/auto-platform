-- 089_live_orders_execution_identity.sql
--
-- **어느 실행 계약으로 연 주문인지 장부에 적는다.**
--
-- 왜 칸이 필요한가
-- ────────────────
-- 지금 `live_orders`에는 이 주문이 어떤 실행 프로필로 나갔는지가 **없다.**
-- 계약은 진입 시점(`scalp/route.ts`의 `resolveExecutionProfile`)에만 존재하고,
-- 주문이 저장된 뒤에는 사라진다.
--
-- 그래서 나중에 그 포지션을 다루는 코드는 **추론할 수밖에 없다** —
-- "배율이 100이고 격리이고 손절이 없으니 Exact100X겠지". 이 저장소가
-- 그 추론을 금지해 온 이유는 분명하다: 그 셋은 우연히 겹칠 수 있고,
-- 겹치는 날 다른 전략의 포지션이 Exact100X 취급을 받는다.
--
-- PR-E와 PR1이 둘 다 이 칸이 없어서 멈췄다:
--
--   PR-E  "leverage=100 / isolated / strategyId=scalp 어떤 조합으로도
--          Exact100X identity를 추론 금지"
--   PR1   telemetry 이름을 `NO_FIXED_SL_EXIT_UNWIRED`처럼 **정책 상태**로만
--          적고 `EXACT_100X` 같은 identity 이름을 쓰지 못했다
--
-- 둘 다 "지금은 identity가 없으니 정책만 보고 판단한다"로 우회했다.
-- 이 칸이 그 우회를 끝낸다.
--
-- ★ 이 PR은 **적기만 한다**
-- ─────────────────────────
-- 이 값으로 무엇을 할지는 다음 단계의 일이다. 지금은 기록하고, 읽고,
-- 화면·telemetry에 사실로 드러낼 뿐 — **실행 판단은 한 줄도 바뀌지 않는다.**
-- 진입 차단도 종료 권한도 이 값을 보지 않는다.
--
-- 기존 행에 미치는 영향
-- ─────────────────────
-- NULL로 남는다. **백필하지 않는다** — 이미 쌓인 주문에 "그때 이 계약이었다"
-- 를 지금 적으면 거짓 기록이 된다(078이 같은 이유로 백필하지 않았다).
-- 모르는 것은 NULL이고, NULL은 "계약 없이 나간 주문"이 아니라
-- **"기록이 없다"**는 뜻이다.
--
-- 왜 세 칸인가
-- ────────────
-- `autotrade_schedules`가 이미 같은 세 칸으로 계약을 가리킨다(077).
-- 같은 이름을 쓴다 — 한쪽만 다른 이름이면 조인할 때 번역이 필요하고,
-- 번역하는 자리가 곧 틀리는 자리다.
--
-- `profileId`와 `presetId`는 **조합 키**라서 하나만으로는 계약이 정해지지
-- 않는다(`MAX_LEV_100X`는 `EXACT_100X`와만 짝이다). 버전까지 있어야
-- 나중에 계약 내용이 바뀌어도 "그때 무엇으로 나갔는지"를 말할 수 있다.

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS execution_profile_id text;

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS execution_preset_id text;

ALTER TABLE public.live_orders
  ADD COLUMN IF NOT EXISTS execution_contract_version integer;

-- 세 칸은 전부 있거나 전부 없다. 반쪽은 추측을 부른다.
--
-- `resolveExecutionProfile`이 코드에서 `INCOMPLETE_SELECTION`으로 막는 것과
-- 같은 규칙을 DB에도 둔다 — 한쪽에만 있으면 언젠가 갈린다.
-- (077의 `autotrade_schedules_execution_profile_complete`와 같은 모양이다.)
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
  '이 주문을 낸 실행 프로필 id (예: MAX_LEV_100X). NULL은 기록 없음이며 "계약 없이 나갔다"는 뜻이 아니다. 진입 시점에만 적히고 이후 바뀌지 않는다.';

COMMENT ON COLUMN public.live_orders.execution_preset_id IS
  '이 주문을 낸 위험 프리셋 id (예: EXACT_100X). profile_id와 조합 키다 — 하나만으로는 계약이 정해지지 않는다.';

COMMENT ON COLUMN public.live_orders.execution_contract_version IS
  '진입 당시의 실행 계약 버전. 계약 내용이 나중에 바뀌어도 그때 무엇으로 나갔는지를 말할 수 있게 한다.';

COMMENT ON CONSTRAINT live_orders_execution_identity_complete
  ON public.live_orders IS
  '실행 계약 세 칸은 전부 있거나 전부 없다. 반쪽 기록은 나머지를 추측하게 만든다 — 코드의 INCOMPLETE_SELECTION과 같은 규칙이다.';
