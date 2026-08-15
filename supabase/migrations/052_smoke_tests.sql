-- 052_smoke_tests.sql
--
-- **아침 9시를 기다리지 않고 배관을 한 바퀴 돌린다.**
--
-- 왜 표가 필요한가
-- ────────────────
-- 스모크 테스트는 "지금 진입하고 10분 뒤에 닫는다"이다. 그 10분 사이에
-- **브라우저가 닫힌다.** 화면 타이머로 닫으면 탭을 닫는 순간 포지션이
-- 그대로 남고, 그건 배관 확인이 아니라 사고다.
--
-- 그래서 마감 시각을 서버 DB에 적는다. 24시간 도는 Fly Worker가 이
-- 표를 보고 닫는다 — 예약(autotrade_schedules)을 보는 것과 같은 구조다.
--
-- 왜 live_orders에 섞지 않는가
-- ────────────────────────────
-- 이 거래는 **전략의 성과가 아니다.** 사람이 방향을 고른 10분짜리
-- 왕복이고, 승률·손익에 섞이면 전략 평가가 통째로 오염된다.
-- 주문 자체는 live_orders에 남지만(그건 실제 주문이니까) 판정과
-- 진행 상태는 여기 따로 산다. strategy_cycles는 건드리지 않는다.

CREATE TABLE IF NOT EXISTS smoke_tests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,
  connection_id     UUID,

  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),

  -- **테스트넷에서만 돈다.** 실계좌에서 "배관 확인용"으로 진짜 돈을 넣고
  -- 10분 뒤에 닫는 것은 스모크 테스트가 아니라 그냥 매매다.
  -- 제약으로 못 박아 둔다 — 코드 한 곳을 우회하는 호출이 생겨도 여기서 막힌다.
  mode              TEXT NOT NULL DEFAULT 'TESTNET' CHECK (mode = 'TESTNET'),

  margin_usd        NUMERIC NOT NULL,
  leverage          INTEGER NOT NULL,
  hold_min          INTEGER NOT NULL DEFAULT 10 CHECK (hold_min BETWEEN 1 AND 30),

  -- PREFLIGHT  시작 직후 · 사전 확인 중
  -- ENTERING   진입 주문을 보내는 중
  -- HOLDING    포지션을 들고 마감 시각을 기다리는 중  ← 워커가 보는 상태
  -- CLOSING    청산 중
  -- PASS/FAIL  최종 판정
  -- BLOCKED    기존 포지션·주문이 있어 시작하지 못했다
  state             TEXT NOT NULL DEFAULT 'PREFLIGHT',

  -- **같은 행동은 같은 id.** 재시도가 중복 주문이 되지 않는다.
  client_order_id   TEXT,
  entry_order_id    TEXT,
  -- 실제 체결. 참고가가 아니다.
  entry_avg_price   NUMERIC,
  entry_qty         NUMERIC,

  -- 실제 체결가 기준으로 계산해서 건 값 + 거래소에서 되읽어 확인한 id
  sl_order_id       TEXT,
  tp_order_id       TEXT,
  sl_trigger        NUMERIC,
  tp_trigger        NUMERIC,

  -- **언제 닫는가.** 워커가 이 시각을 보고 reduceOnly 전량청산을 낸다.
  hold_until        TIMESTAMPTZ,

  -- 단계별 결과. { PREFLIGHT: {state, note}, ENTRY: {...}, ... }
  -- **없는 단계는 PENDING이다** — 기록이 없는 것을 통과로 읽지 않는다.
  steps             JSONB NOT NULL DEFAULT '{}'::jsonb,

  verdict           TEXT,
  reason            TEXT,

  -- 두 실행기(워커·예비)가 같은 줄을 동시에 닫지 않게 하는 번호표.
  -- autotrade_schedules의 last_run_at과 같은 방식이다.
  settle_claimed_at TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ
);

-- 워커는 "닫을 때가 된 것"만 찾는다. 그 조회가 표 전체를 훑지 않게 한다.
CREATE INDEX IF NOT EXISTS smoke_tests_due_idx
  ON smoke_tests (state, hold_until)
  WHERE state IN ('HOLDING', 'CLOSING');

CREATE INDEX IF NOT EXISTS smoke_tests_user_idx
  ON smoke_tests (user_id, created_at DESC);

-- **같은 종목에 두 개를 동시에 열지 않는다.**
-- ONE_WAY 계좌는 종목당 포지션이 하나다. 두 테스트가 겹치면 한쪽의
-- 청산이 다른 쪽 포지션을 닫고, 둘 다 오판한다.
CREATE UNIQUE INDEX IF NOT EXISTS smoke_tests_one_live_per_symbol
  ON smoke_tests (user_id, connection_id, symbol)
  WHERE state IN ('PREFLIGHT', 'ENTERING', 'HOLDING', 'CLOSING');

ALTER TABLE smoke_tests ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY smoke_tests_service ON smoke_tests
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY smoke_tests_owner ON smoke_tests
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
