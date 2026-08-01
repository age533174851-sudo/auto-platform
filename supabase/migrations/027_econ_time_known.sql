-- 027_econ_time_known.sql
--
-- 발표 **시각을 아는가**를 따로 적는다.
--
-- 왜 필요한가
-- ───────────
-- FRED(연준)는 무료지만 날짜만 준다. 시각이 없다.
--
-- 여기서 "미국 지표는 보통 8시 30분 ET니까 그걸 쓰자"는 유혹이 있는데,
-- 그건 추측이고 서머타임까지 얽히면 최대 한 시간이 어긋난다. 회피 창이
-- ±30분인데 시각이 한 시간 틀리면 **정확히 발표 순간에 진입이 열려 있다.**
-- 그건 회피가 없는 것보다 나쁘다 — 있다고 믿기 때문이다.
--
-- 그래서 시각을 지어내지 않고 '모른다'를 기록한다. timestamp_utc에는
-- 그날 00:00 UTC가 들어가지만 **그건 발표 시각이 아니다.** 이 칸이
-- 그 사실을 들고 가고, 회피 판정은 그런 일정을 하루 전체로 본다.
--
-- 기본값이 true인 이유
-- ────────────────────
-- 이미 들어 있는 행은 시각을 아는 공급자(TradingEconomics·FMP)에서 왔다.
-- NULL이나 false로 두면 그것들이 전부 '하루 종일 회피'가 되어, 켜는 순간
-- 매매가 통째로 멈춘다.

ALTER TABLE econ_events
  ADD COLUMN IF NOT EXISTS time_known BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS econ_events_dayonly_idx
  ON econ_events (timestamp_utc) WHERE time_known = FALSE;
