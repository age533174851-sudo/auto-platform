-- 041_strategy_accounts.sql
--
-- **거래소 계좌는 하나여도 장부는 나뉘어야 한다.**
--
-- 왜 필요한가
-- ───────────
-- 전략을 열두 개 동시에 돌리면 거래소에는 계좌가 하나다. 그 하나에
-- BTCUSDT 롱이 1.0 있다고 하자. **그게 누구 것인가.**
--
-- 지금은 아무도 모른다. 그래서 이런 일이 난다:
--
--  · 추세 전략이 0.6을 열었는데 평균회귀 전략이 [전량청산]을 눌러
--    남의 포지션까지 닫는다
--  · 두 전략이 같은 잔고를 각자 자기 것으로 세고, 둘 다 진입하는
--    순간 증거금이 모자라 둘 다 거부된다
--  · 한 전략이 손실 한도에 걸려 멈춰야 하는데, 그 전략만의 손익을
--    잴 방법이 없어 멈추지 못한다
--
-- 판정은 `src/lib/strategies/sleeveLedger.ts`가 한다(테스트가 붙어
-- 있다). 이 표는 그 상태를 담아 둘 뿐이다.
--
-- 왜 거래소에 서브계좌를 만들지 않는가
-- ────────────────────────────────────
-- 만들 수 있으면 그게 낫다. 그런데 서브계좌는 거래소마다 조건이 다르고
-- (Gate는 등급 제한이 있다) 키를 열두 벌 관리해야 한다. **앱의 장부로
-- 나누는 것은 그 앞 단계**다 — 거래소는 그대로 두고 소유권만 기록한다.
--
-- 그래서 이 표는 **거래소가 기준이라는 원칙을 뒤집지 않는다.** 실제
-- 포지션은 여전히 거래소가 정하고, 이 표는 "그 중 얼마가 누구 몫인가"만
-- 말한다. 둘이 어긋나면 reconcileSleeves가 그 사실을 드러낸다 —
-- **사용자 확인 없이 어느 쪽도 지우지 않는다.**

CREATE TABLE IF NOT EXISTS strategy_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,

  -- 전략 식별자. 'MINERVINI_TREND'처럼 사람이 읽을 수 있는 값을 쓴다 —
  -- 주문에 이 값이 새겨지므로, 나중에 로그만 보고도 누가 낸 주문인지
  -- 알 수 있어야 한다.
  sleeve_id    TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',

  -- 어느 거래소 연결 안에 있는가. NULL이면 아직 안 붙인 것이다 —
  -- **0이나 빈 문자열로 두지 않는다.** 안 붙인 것과 못 읽은 것을
  -- 구분할 수 있어야 한다.
  connection_id UUID,

  -- ── 배정과 한도 ──
  allocated            NUMERIC NOT NULL DEFAULT 0,
  risk_per_trade_pct   NUMERIC,
  max_drawdown_pct     NUMERIC,
  max_leverage         NUMERIC,

  -- 승격 단계. 기본은 가장 앞이다 — 새로 만든 전략이 곧바로 돈을
  -- 쓸 수 있으면 이 단계 구분이 있는 이유가 사라진다.
  -- SPECIFICATION | BACKTEST | WALK_FORWARD | PAPER | SHADOW
  -- | TESTNET | LIVE_SMALL | LIVE_LIMITED
  stage        TEXT NOT NULL DEFAULT 'SPECIFICATION',

  -- ── 장부 ──
  reserved_margin  NUMERIC NOT NULL DEFAULT 0,
  realized_pnl     NUMERIC NOT NULL DEFAULT 0,
  unrealized_pnl   NUMERIC NOT NULL DEFAULT 0,
  fees             NUMERIC NOT NULL DEFAULT 0,
  -- 낙폭은 최고점 대비로 잰다. 최고점을 안 들고 있으면 "지금 -12%"가
  -- 배정 원금 대비인지 최고점 대비인지 알 수 없다.
  peak_equity      NUMERIC NOT NULL DEFAULT 0,
  max_drawdown_seen_pct NUMERIC NOT NULL DEFAULT 0,

  -- 심볼 → 이 계좌가 소유한 수량 (롱 +, 숏 −)
  -- {"BTCUSDT": 0.6, "ETHUSDT": -2}
  positions    JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- 멈춤. 낙폭·한도로 자동으로 서기도 하고 사람이 세우기도 한다.
  halted       BOOLEAN NOT NULL DEFAULT FALSE,
  halt_reason  TEXT NOT NULL DEFAULT '',

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 한 사람이 같은 전략 계좌를 둘 만들 수 없다. 둘이 되면 배분 합계가
-- 맞는지 검사하는 쪽(checkAllocation)이 같은 전략을 두 번 센다.
CREATE UNIQUE INDEX IF NOT EXISTS strategy_accounts_user_sleeve_uniq
  ON strategy_accounts (user_id, sleeve_id);

CREATE INDEX IF NOT EXISTS strategy_accounts_user_idx
  ON strategy_accounts (user_id);

ALTER TABLE strategy_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS strategy_accounts_service ON strategy_accounts;
CREATE POLICY strategy_accounts_service ON strategy_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 주문에 소유자를 새긴다 ──
--
-- **NULL을 허용한다.** 지금까지 나간 주문에는 이 값이 없고, 손으로
-- 누르는 주문에도 없을 수 있다. NOT NULL로 두면 마이그레이션이 기존
-- 행에서 실패하거나 아무 값이나 채워 넣게 되는데, 지어낸 소유자는
-- 소유자가 없는 것보다 나쁘다.
ALTER TABLE live_orders
  ADD COLUMN IF NOT EXISTS strategy_account_id UUID;

CREATE INDEX IF NOT EXISTS live_orders_strategy_idx
  ON live_orders (strategy_account_id)
  WHERE strategy_account_id IS NOT NULL;
