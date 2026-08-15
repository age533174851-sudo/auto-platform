-- 053_smoke_runs.sql
--
-- **한 번 통과한 것은 통과가 아니다.**
--
-- 스모크 테스트 1회가 PASS했다. 그런데 이번에 실제로 터진 고장들은
-- 전부 **두 번째 회차부터** 드러나는 것이었다:
--
--   · 전날 포지션이 남은 채 다음 진입 → 수량 2배 / netting 찌꺼기
--   · 이전 회차 SL/TP가 안 치워진 채 새것이 쌓임 (Gate Orders 4개)
--   · 소유권 형식이 깨져 내 보호주문을 매번 못 지움
--
-- 첫 회차는 깨끗한 계좌에서 시작하므로 무엇을 안 치웠는지 알 수가 없다.
-- 그래서 반복이 필요하고, 특히 **LONG↔SHORT 교대**가 필요하다 —
-- 매 회차가 반전 경로를 지나면서 "이전 방향이 완전히 정리됐는가"를 묻는다.
--
-- 왜 표를 따로 두나
-- ─────────────────
-- 회차 하나하나는 이미 `smoke_tests`에 있다. 여기 있는 것은 **묶음의
-- 계획과 상태**다: 몇 회를 돌 것인가 · 방향을 어떻게 정할 것인가 ·
-- 한 회 실패하면 멈출 것인가. 이걸 회차마다 복사해 두면 도중에 한쪽만
-- 바뀌고, 그때 5회차와 6회차가 서로 다른 규칙으로 돈다.

CREATE TABLE IF NOT EXISTS smoke_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,
  connection_id     UUID,

  symbol            TEXT NOT NULL,
  -- 1회차의 방향. 교대면 2회차부터 번갈아 간다.
  first_side        TEXT NOT NULL CHECK (first_side IN ('LONG', 'SHORT')),
  -- LONG 고정 · SHORT 고정 · LONG↔SHORT 교대
  direction_mode    TEXT NOT NULL DEFAULT 'ALTERNATE'
                      CHECK (direction_mode IN ('LONG', 'SHORT', 'ALTERNATE')),

  mode              TEXT NOT NULL DEFAULT 'TESTNET' CHECK (mode = 'TESTNET'),
  margin_usd        NUMERIC NOT NULL,
  leverage          INTEGER NOT NULL,
  hold_min          INTEGER NOT NULL CHECK (hold_min BETWEEN 1 AND 30),

  -- 몇 회를 돌 것인가. 상한은 코드(MAX_ATTEMPTS)와 같은 50이다 —
  -- 1분 × 50회면 50분, 10분 × 50회면 8시간이 넘고 그동안 워커가 죽으면
  -- 마지막 포지션이 남는다.
  attempts          INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 50),

  -- SAFE     한 번이라도 FAIL/UNKNOWN이면 즉시 전체 중지
  -- DURABLE  포지션 0 · 잔여 주문 0이 **증명된 경우에만** 계속
  failure_policy    TEXT NOT NULL DEFAULT 'SAFE'
                      CHECK (failure_policy IN ('SAFE', 'DURABLE')),

  -- RUNNING · PASS · FAIL · STOPPED
  state             TEXT NOT NULL DEFAULT 'RUNNING',
  verdict           TEXT,
  reason            TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ
);

-- **같은 종목에 묶음을 두 개 돌리지 않는다.**
-- ONE_WAY 계좌는 종목당 포지션이 하나다.
CREATE UNIQUE INDEX IF NOT EXISTS smoke_runs_one_live_per_symbol
  ON smoke_runs (user_id, connection_id, symbol)
  WHERE state = 'RUNNING';

CREATE INDEX IF NOT EXISTS smoke_runs_user_idx ON smoke_runs (user_id, created_at DESC);

ALTER TABLE smoke_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY smoke_runs_service ON smoke_runs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY smoke_runs_owner ON smoke_runs
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 회차 줄이 묶음을 가리킨다 ──
--
-- 그리고 회차마다 **성능을 잰다.** 10회를 돌리는 이유의 절반은
-- "되는가"이고 나머지 절반은 "얼마나 걸리는가"다. 진입이 매번 3초씩
-- 밀린다면 09:10~09:30 창에서 그게 그대로 문제가 된다.
--
-- **못 잰 값은 NULL이다.** 0으로 적으면 "지연 0ms"로 읽히고, 측정한 적
-- 없는 값이 성능 근거가 된다.
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS run_id UUID;
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS attempt_no INTEGER;
-- 누가 이 회차를 깨웠는가 (FLY_WORKER · USER · GITHUB_FALLBACK)
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS dispatch_source TEXT;
-- 수량 계산에 쓴 참고가. 실제 체결가와의 차이가 슬리피지다.
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS ref_price NUMERIC;
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS exit_avg_price NUMERIC;
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS exit_order_id TEXT;
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS entry_latency_ms INTEGER;
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS exit_latency_ms INTEGER;
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS slippage_pct NUMERIC;
ALTER TABLE smoke_tests ADD COLUMN IF NOT EXISTS api_latency_ms_max INTEGER;

CREATE INDEX IF NOT EXISTS smoke_tests_run_idx ON smoke_tests (run_id, attempt_no);

-- **같은 묶음의 같은 회차가 두 번 생기지 않는다.**
-- 워커와 사람이 동시에 다음 회차를 시작하려 하면 여기서 하나가 막힌다 —
-- 선점은 마지막 방어선이지 첫 방어선이 아니다.
CREATE UNIQUE INDEX IF NOT EXISTS smoke_tests_run_attempt
  ON smoke_tests (run_id, attempt_no)
  WHERE run_id IS NOT NULL;

-- 052의 "같은 종목에 하나만" 인덱스는 그대로 둔다. 반복도 **순차**이므로
-- 같은 순간에 살아 있는 회차는 언제나 하나뿐이다.
