-- 014_derivatives_daily.sql
-- 파생시장 일별 히스토리 (펀딩비 · OI 변화율).
--
-- 왜 저장하나: 백테스트가 매번 거래소 API를 호출하면 느리고 레이트리밋에 걸린다.
-- 한 번 수집해 저장해두고 백테스트는 DB에서 읽는다.
--
-- 주의: Binance OI 히스토리는 최근 30일치만 제공한다.
--       그 이전 구간은 coverage='funding_only'로 남는다.

CREATE TABLE IF NOT EXISTS derivatives_daily (
  symbol         TEXT NOT NULL,
  trade_date     DATE NOT NULL,
  funding_rate   NUMERIC,          -- 그날 평균 펀딩비 (%)
  oi_change_pct  NUMERIC,          -- 전일 대비 OI 변화율 (%)
  coverage       TEXT NOT NULL DEFAULT 'none',   -- full | funding_only | none
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, trade_date)
);

CREATE INDEX IF NOT EXISTS derivatives_daily_symbol_idx ON derivatives_daily (symbol, trade_date DESC);
CREATE INDEX IF NOT EXISTS derivatives_daily_coverage_idx ON derivatives_daily (coverage);

ALTER TABLE derivatives_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS derivatives_daily_service ON derivatives_daily;
CREATE POLICY derivatives_daily_service ON derivatives_daily
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 시장 데이터라 모든 로그인 사용자가 읽을 수 있다
DROP POLICY IF EXISTS derivatives_daily_read ON derivatives_daily;
CREATE POLICY derivatives_daily_read ON derivatives_daily
  FOR SELECT TO authenticated USING (true);
