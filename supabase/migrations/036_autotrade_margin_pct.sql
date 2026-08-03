-- 036_autotrade_margin_pct.sql
--
-- **"100배로 10%씩 10번"을 실제로 돌리기 위한 칸.**
--
-- 왜 지금까지 100배가 안 나왔나
-- ─────────────────────────────
-- 배율은 역산된다: 포지션 명목가 ÷ 증거금 예산.
--
--   증거금 예산 = min(가용 증거금, maxMargin)
--
-- 그런데 `maxMargin`을 채우는 곳이 계단식(ladder) 하나뿐이었다. 자동매매
-- 예약에는 그 칸이 없어서 **증거금 예산 = 가용 전액**이 됐다.
--
-- 계좌 전체를 증거금으로 쓰면 배율이 낮게 나온다. 예를 들어 1회 위험 10%,
-- 손절 2%면 명목가는 자산의 약 4.65배이고, 증거금이 자산 전액이면
-- 배율은 4.65배다. 화면에 100을 적어도 4.65배가 나간다.
--
-- 100배가 나오려면 **증거금이 작아야** 한다. 같은 조건에서 증거금을
-- 자산의 4.65%로 묶으면 배율이 100배가 된다.
--
-- 그게 "10%씩 10번"의 뜻이다
-- ──────────────────────────
-- 한 번에 자산의 10%만 증거금으로 넣고, 그걸 열 번 나눠 쓴다. 각 자리가
-- 청산돼도 잃는 것은 그 10%다. 열 번을 다 잃어야 계좌가 빈다.
--
-- 이 칸이 그 10%다. NULL이면 예전처럼 동작한다(계단식이 정하거나 무제한).
ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS margin_pct NUMERIC;

-- 1회에 계좌 전부를 증거금으로 넣는 것은 '분할'이 아니다. 100%까지는
-- 받되, 0이나 음수는 받지 않는다 — 0이면 주문이 통째로 막힌다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_margin_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_margin_chk
  CHECK (margin_pct IS NULL OR (margin_pct > 0 AND margin_pct <= 100));
