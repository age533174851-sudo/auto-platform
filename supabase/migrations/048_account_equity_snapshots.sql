-- 048_account_equity_snapshots.sql
--
-- **"언제 얼마 벌었는지"는 지금 계좌를 봐서는 알 수 없다.**
--
-- 자산 그래프를 그리려면 과거 시점의 총자산이 있어야 한다. 그런데 그걸
-- 저장한 적이 없으면, 남는 방법은 하나뿐이다 — **현재 잔고에서 거래
-- 내역을 거꾸로 빼면서 과거를 지어내는 것.** 그러면 안 된다:
--
--   · 입출금이 빠지면 곡선이 통째로 어긋난다. 어제 100만원을 넣었으면
--     그래프는 "어제 100만원 벌었다"고 그린다
--   · 수수료·펀딩을 못 되돌리면 조금씩 어긋나고, 오래된 구간일수록
--     더 어긋난다. 그런데 그래프는 아무렇지 않게 매끄럽다
--   · 못 되돌린 구간이 있어도 선은 이어진다. **틀렸다는 표시가 없다**
--
-- 역산한 곡선은 "대충 맞는 그림"이 아니라 **틀렸는데 그럴듯한 그림**이다.
-- 그걸 보고 사용자는 어느 전략이 언제 돈을 벌었는지 판단한다.
--
-- 그래서 찍어서 쌓는다
-- ────────────────────
-- 주기적으로 그때의 총자산을 그대로 한 줄 남긴다. 곡선은 그 점들을
-- 잇는 것뿐이고, 점이 없는 구간은 **선을 긋지 않는다.**
--
-- 점이 없으면 그래프도 없다. 그게 정직한 상태다 — 오늘 표를 만들어도
-- 어제 값은 생기지 않는다.

CREATE TABLE IF NOT EXISTS account_equity_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,

  -- ── 환경을 절대 섞지 않는다 ──
  --
  -- 실전·테스트넷·모의를 한 곡선에 그리면 그 그래프는 아무 뜻이 없다.
  -- LIVE / TESTNET / MOCK
  env           TEXT NOT NULL DEFAULT 'TESTNET',
  -- 계좌를 나눠 볼 수 있게. 비우면 그 환경 전체 합계다.
  account_key   TEXT NOT NULL DEFAULT '',

  taken_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── 그때의 값 ──
  --
  -- **NULL은 0이 아니다.** 못 읽은 칸은 비워 둔다. 0으로 채우면
  -- 그래프가 바닥으로 떨어지고, 사용자는 그 시각에 전액을 잃은 줄 안다.
  total_equity  NUMERIC,
  currency      TEXT NOT NULL DEFAULT 'USDT',

  -- ── 자산이 왜 변했는가 ──
  --
  -- 이게 이 표의 핵심이다. 총자산만 찍으면 "올랐다"는 알아도
  -- **"벌어서 올랐는지 넣어서 올랐는지"는 모른다.**
  realized_pnl    NUMERIC,
  unrealized_pnl  NUMERIC,
  deposit         NUMERIC,
  withdrawal      NUMERIC,
  transfer        NUMERIC,
  fees            NUMERIC,
  funding         NUMERIC,
  dividend        NUMERIC,
  interest        NUMERIC,

  -- 이 점을 무엇이 찍었는가. 크론이 빠진 구간을 나중에 찾을 수 있다.
  source        TEXT NOT NULL DEFAULT '',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 같은 순간을 두 번 찍지 않는다. 두 번 찍히면 그날 손익이 두 배로 보인다.
  UNIQUE (user_id, env, account_key, taken_at)
);

CREATE INDEX IF NOT EXISTS aes_user_env_idx
  ON account_equity_snapshots (user_id, env, taken_at DESC);

COMMENT ON TABLE account_equity_snapshots IS
  '과거 시점의 총자산을 그대로 찍어 둔 것. 곡선은 이 점들을 잇는 것뿐이고, 점이 없는 구간은 선을 긋지 않는다 — 현재 잔고로 과거를 역산하면 틀렸는데 그럴듯한 그림이 나온다';
COMMENT ON COLUMN account_equity_snapshots.total_equity IS
  'NULL은 0이 아니라 못 읽었다는 뜻이다. 0으로 채우면 그래프가 바닥으로 떨어지고 사용자는 전액을 잃은 줄 안다';
COMMENT ON COLUMN account_equity_snapshots.deposit IS
  '입금은 수익이 아니다. 이 칸이 없으면 100만원을 넣은 날이 100만원 번 날로 그려진다';
COMMENT ON COLUMN account_equity_snapshots.env IS
  'LIVE/TESTNET/MOCK. 한 곡선에 섞으면 그 그래프는 아무 뜻이 없다';

ALTER TABLE account_equity_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY aes_own ON account_equity_snapshots
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
