-- 055_smoke_cancel.sql
--
-- **"중지"가 두 가지였는데 칸이 하나도 없었다.**
--
-- 지금까지 중지는 `state = 'STOPPED'` 하나였고 그 뜻은 "다음 회차를 더
-- 열지 않는다"였다. 열려 있는 회차는 원래 마감 시각까지 그대로 간다.
-- 그런데 사람이 누른 버튼은 "지금 당장 그만"이었고, 화면은 계속 진행
-- 중을 보여 줬다 — 기능이 틀린 게 아니라 **뜻이 두 개인데 이름이 하나**였다.
--
-- 그래서 뜻을 적어 둔다:
--   stop_intent = 'STOP_AFTER_CURRENT'  지금 회차는 끝내고 다음은 안 연다
--   stop_intent = 'CANCEL_NOW'          지금 회차를 즉시 청산하고 끝낸다
--
-- 그리고 **중지는 한 순간이 아니라 절차다.** 청산 → 포지션 0 확인 →
-- 보호주문 정확한 번호로 취소 → 재조회 확인까지 가야 끝이다. 그 사이의
-- 상태(CANCEL_REQUESTED · CLOSING · CLEANING_PROTECTION)가 DB에 있어야
-- **브라우저를 닫아도 워커가 이어서 끝낼 수 있다.**

ALTER TABLE smoke_runs ADD COLUMN IF NOT EXISTS stop_intent TEXT;
ALTER TABLE smoke_runs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
-- 두 실행기가 같은 묶음을 동시에 청산하지 않게 하는 선점.
ALTER TABLE smoke_runs ADD COLUMN IF NOT EXISTS cancel_claimed_at TIMESTAMPTZ;
-- 중지가 왜 끝났는지 / 왜 못 끝났는지 한 줄.
ALTER TABLE smoke_runs ADD COLUMN IF NOT EXISTS cancel_note TEXT;

-- ── 중지가 도는 동안에도 같은 종목에 새 묶음을 못 연다 ──
--
-- 기존 인덱스는 `state = 'RUNNING'`만 막았다. 그래서 중지 절차가 도는
-- 동안(CANCEL_REQUESTED·CLOSING·CLEANING_PROTECTION) 같은 종목에 새
-- 묶음을 시작할 수 있었다 — 그러면 청산 중인 포지션 위로 새 진입이
-- 올라간다. ONE_WAY 계좌에서 그건 수량이 겹치는 사고다.
DROP INDEX IF EXISTS smoke_runs_one_live_per_symbol;
CREATE UNIQUE INDEX IF NOT EXISTS smoke_runs_one_live_per_symbol
  ON smoke_runs (user_id, connection_id, symbol)
  WHERE state IN ('RUNNING', 'CANCEL_REQUESTED', 'CLOSING', 'CLEANING_PROTECTION');

-- 워커가 "이어서 끝내야 하는 묶음"을 싸게 찾는다.
CREATE INDEX IF NOT EXISTS smoke_runs_cancel_inflight
  ON smoke_runs (state, cancel_requested_at)
  WHERE state IN ('CANCEL_REQUESTED', 'CLOSING', 'CLEANING_PROTECTION');
