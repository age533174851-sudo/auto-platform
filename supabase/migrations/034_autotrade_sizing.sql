-- 034_autotrade_sizing.sql
--
-- **자동매매의 크기와 배율을 화면에서 정한다.**
--
-- 왜 필요한가
-- ───────────
-- 지금 배율은 `riskManager`가 **손절 거리에서 역산**한다. 그래서 "100배로
-- 하겠다"고 지정할 방법이 없다. 프로필 주석에도 이렇게 적혀 있다:
--
--   "100배를 쓰려면 손절이 0.26% 안쪽이어야 하는데, 이는 BTC 노이즈
--    수준이라 진입 직후 손절될 가능성이 높다. 즉 100배는 사실상
--    선택되지 않는다."
--
-- 역산 자체는 맞는 순서다 — 배율을 먼저 정하면 손절이 청산가 밖으로
-- 밀린다. 다만 **상한을 사용자가 정할 수 있어야** 한다. 지금은 코드에
-- 박힌 값이라 화면에서 손댈 수 없다.
--
-- 왜 '상한'이지 '배율'이 아닌가
-- ─────────────────────────────
-- 여기에 `leverage = 100`을 저장하고 그대로 쓰면, 손절이 2%인 자리에도
-- 100배가 나간다. 그건 진입 직후 청산이다. 상한으로 두면 역산 결과가
-- 그보다 작을 때는 작은 쪽이 나간다 — 안전한 쪽으로 틀린다.

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS leverage_cap INTEGER;

ALTER TABLE autotrade_schedules
  ADD COLUMN IF NOT EXISTS risk_pct NUMERIC;

-- 아는 값만 들어가게 한다. NULL은 '정하지 않음'이고, 그때는 코드 기본값을
-- 쓴다 — 0으로 채우면 '배율 0'이 되어 주문이 통째로 막힌다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_lev_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_lev_chk
  CHECK (leverage_cap IS NULL OR (leverage_cap >= 1 AND leverage_cap <= 125));

-- 1회 위험 비율(%). 10슬롯 방식이면 10이다.
-- 100을 넘으면 계좌보다 큰 위험을 지겠다는 뜻이라 받지 않는다.
ALTER TABLE autotrade_schedules
  DROP CONSTRAINT IF EXISTS autotrade_schedules_risk_chk;
ALTER TABLE autotrade_schedules
  ADD CONSTRAINT autotrade_schedules_risk_chk
  CHECK (risk_pct IS NULL OR (risk_pct > 0 AND risk_pct <= 100));
