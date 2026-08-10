-- 051_strategy_cycles.sql
--
-- **전략마다 자기 가상 원장을 갖는다.**
--
-- 왜 거래소 잔고를 쓰면 안 되나
-- ─────────────────────────────
-- 원본 전략의 자금관리는 자릿수 구간이 주문 크기를 정한다:
--
--     $100 ~ $999       → 주문 증거금 $10
--     $1,000 ~ $9,999   → 주문 증거금 $100
--     $10,000 ~ $99,999 → 주문 증거금 $1,000
--     $100,000          → 그 회차 완료
--
-- 그런데 **테스트넷 계좌에는 시작금과 무관한 가상 자금이 들어 있다.**
-- Gate 테스트넷이 $50,000을 넣어 줬다면, 계좌 잔고를 기준으로 삼는 순간
-- 첫 주문부터 $1,000이 나간다 — $1,000 → $10,000 → $100,000 규칙을
-- 시험하는 것이 아니라 거래소가 넣어 준 잔고를 시험하게 된다.
--
-- 그래서 전략별 원장을 따로 둔다. 여기에는 **실제로 확정된 것만** 더한다:
-- 체결 손익·수수료·펀딩. 미실현 손익은 넣지 않는다 — 포지션이 열려 있는
-- 동안 구간이 오르내리면 같은 회차 안에서 주문 크기가 흔들린다.
--
-- 회차를 왜 표로 두는가
-- ─────────────────────
-- $100,000에 닿으면 그 회차의 성과를 **보존**하고 다음 회차를 최초
-- 시드로 다시 시작한다. 한 줄을 덮어쓰면 "그 회차에 몇 번 만에 갔는지"가
-- 사라진다 — 파생 전략과 비교하려면 그 기록이 남아 있어야 한다.
--
-- **거래소 잔고는 건드리지 않는다.** COMPLETE는 장부상의 사건이다.
--
-- 하루 1회를 여기서 지킨다
-- ────────────────────────
-- `last_trading_day`는 **한국 날짜**다. UTC 날짜로 적으면 한국시간 아침
-- 9시가 전날로 찍혀서, 날짜 경계에서 하루 1회 제한이 두 번 열린다.

CREATE TABLE IF NOT EXISTS strategy_cycles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,

  -- 어느 전략의 원장인가. registry의 id와 같은 값이다.
  strategy_id       TEXT NOT NULL,
  strategy_version  TEXT NOT NULL DEFAULT '1',

  symbol            TEXT NOT NULL,
  connection_id     UUID,
  mode              TEXT NOT NULL DEFAULT 'TESTNET',

  -- 몇 번째 회차인가. 1부터.
  cycle_no          INTEGER NOT NULL DEFAULT 1,

  -- **최초 시드.** 다음 회차를 시작할 때 되돌아갈 값이다. 회차가 바뀌어도
  -- 이 값은 그대로다 — 그래야 "같은 시드로 몇 번 만에 갔는가"를 비교할 수 있다.
  first_seed_usd    NUMERIC NOT NULL,
  -- 이 회차를 시작한 금액. 보통 first_seed_usd와 같다.
  seed_usd          NUMERIC NOT NULL,

  -- 지금 가상 원장 잔고. **확정 손익만 반영된다.**
  equity_usd        NUMERIC NOT NULL,

  target_usd        NUMERIC NOT NULL DEFAULT 100000,

  -- RUNNING | COMPLETE | BELOW_FLOOR | STOPPED
  state             TEXT NOT NULL DEFAULT 'RUNNING',

  -- ── 하루 1회 ──
  -- 마지막으로 **판단한** 한국 거래일. 진입 여부와 무관하다 —
  -- 관망도 판단이다. NULL이면 아직 한 번도 판단하지 않은 것이다.
  last_trading_day  DATE,
  -- 그 판단의 결과. ENTERED | NO_TRADE | BLOCKED | MISSED | FAILED
  last_outcome      TEXT,
  last_reason       TEXT,

  entries           INTEGER NOT NULL DEFAULT 0,
  realized_pnl_usd  NUMERIC NOT NULL DEFAULT 0,

  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- **같은 조합에 돌고 있는 회차는 하나뿐이다.**
-- 완료된 회차는 기록으로 남으므로 부분 인덱스로 RUNNING만 묶는다.
CREATE UNIQUE INDEX IF NOT EXISTS strategy_cycles_running_idx
  ON strategy_cycles (user_id, strategy_id, symbol, connection_id, mode)
  WHERE state = 'RUNNING';

CREATE INDEX IF NOT EXISTS strategy_cycles_user_idx
  ON strategy_cycles (user_id, strategy_id, symbol);

ALTER TABLE strategy_cycles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS strategy_cycles_service ON strategy_cycles;
CREATE POLICY strategy_cycles_service ON strategy_cycles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS strategy_cycles_owner ON strategy_cycles;
CREATE POLICY strategy_cycles_owner ON strategy_cycles
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE strategy_cycles IS
  '전략별 가상 원장과 회차. 거래소 잔고가 아니라 이 값이 주문 크기를 정한다';
COMMENT ON COLUMN strategy_cycles.last_trading_day IS
  '마지막으로 판단한 한국(KST) 거래일. UTC 날짜가 아니다';
COMMENT ON COLUMN strategy_cycles.equity_usd IS
  '확정 손익만 반영된 가상 잔고. 미실현 손익은 넣지 않는다';
