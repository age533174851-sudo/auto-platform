-- 069: 예약을 지우지 않고 **취소한 사실을 남긴다**
--
-- 지금은 DELETE가 `enabled = false`만 한다. 그래서 화면에서 "삭제"를
-- 눌러도 **끈 것과 구분되지 않는다** — 나중에 "이 예약이 왜 안 도나"를
-- 물었을 때, 사용자가 껐는지 취소했는지 알 방법이 없다.
--
-- 그렇다고 행을 지우면 안 된다. 지우면 '켠 적 없다'와 '취소했다'가
-- 같아지고, 이미 실행된 예약의 이력도 함께 사라진다.
--
-- ADDITIVE 전용이다. 기존 줄은 NULL로 남고, NULL은 "취소된 적 없음"이다.
ALTER TABLE public.autotrade_schedules
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- 누가 취소했는가. 사람이 눌렀는지 시스템이 정리했는지 구분한다.
ALTER TABLE public.autotrade_schedules
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

-- 워커는 살아 있는 예약만 훑는다. 취소된 줄이 그 인덱스에 남아 있을
-- 이유가 없다.
CREATE INDEX IF NOT EXISTS autotrade_schedules_live_idx
  ON public.autotrade_schedules (enabled)
  WHERE enabled = true AND cancelled_at IS NULL;
