-- 070: 예약청산도 **취소한 사실을 남긴다**
--
-- `scheduled_exits`의 DELETE는 `enabled = false`와 `result='cancelled'`를
-- 쓰고 있었다. 그건 069 이전의 예약(autotrade_schedules)보다 낫지만
-- 두 가지가 빠져 있다:
--
--   · 언제 취소했는지가 없다 (`result`는 실행 결과 칸이라 의미가 겹친다)
--   · **취소가 실행을 못 막는다** — 실행기가 줄을 읽고 나서 주문을 낼
--     때까지 아무 선점도 하지 않는다. 그 사이 취소가 커밋돼도 주문이 나간다
--
-- 두 번째는 코드로 막는다(선점 UPDATE). 이 마이그레이션은 그 선점이
-- 볼 칸과 취소 기록을 만든다.
--
-- ADDITIVE 전용이다. 기존 줄은 NULL이고, NULL은 "취소된 적 없음"이다.
ALTER TABLE public.scheduled_exits
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

ALTER TABLE public.scheduled_exits
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

-- 실행기는 아직 안 쏜 · 살아 있는 · 취소되지 않은 줄만 훑는다.
CREATE INDEX IF NOT EXISTS scheduled_exits_pending_idx
  ON public.scheduled_exits (run_at)
  WHERE enabled = true AND fired_at IS NULL AND cancelled_at IS NULL;
