-- 024_sub_accounts.sql
--
-- 가상 서브계좌 — 한 거래소 계좌를 앱 안에서 **장부로** 나눈다.
--
-- 왜 진짜 계좌를 여러 개 만들지 않는가
-- ────────────────────────────────────
-- 거래소 계좌를 쪼개면 이체가 필요하고, 이체는 시간이 걸리고 실패한다.
-- 실험 계정이 기회를 봤는데 자금이 성장 계정에 묶여 있으면 그 사이에 기회가
-- 사라진다. 장부로만 나누면 자금은 한 곳에 있고 한도만 갈린다.
--
-- 대신 장부가 거래소보다 느슨해서는 안 된다 — 이 표의 값은
-- `lib/portfolio/subAccount.ts`가 읽어 **주문을 실제로 막는 데** 쓴다.
-- (체크리스트 항목 SUBACCOUNT_LIMIT)
--
-- allocated_usd가 NULL을 허용하는 이유
-- ────────────────────────────────────
-- '한도 없음'이 아니라 **'아직 안 정했다'**를 표현해야 하기 때문이다.
-- 0으로 두면 "이 바구니는 안 쓴다"가 되고, 그건 완전히 다른 뜻이다.
-- 판정 함수도 NULL을 unknown으로, 0을 '한도 0'으로 다르게 다룬다.

CREATE TABLE IF NOT EXISTS sub_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,

  name           TEXT NOT NULL,                 -- '성장' · '안정' · '실험'
  allocated_usd  NUMERIC,                       -- NULL = 미설정 (0과 다르다)

  -- 이 바구니가 맡는 범위. 비어 있으면 '전부'.
  -- 종목까지 지정한 바구니가 시장만 지정한 바구니보다 우선한다
  -- (subAccount.ts의 pickAccount).
  markets         TEXT[],                       -- {'SPOT','USDM','COINM'}
  symbol_prefixes TEXT[],                       -- {'BTC','ETH'}

  note           TEXT,
  -- 같은 조건이 겹칠 때 **먼저 정의한 것**을 쓴다. 순서가 우선순위다.
  sort_order     INT NOT NULL DEFAULT 0,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sub_acct_user_idx
  ON sub_accounts (user_id, sort_order, created_at);

-- 같은 사용자가 같은 이름을 두 번 만들면 화면에서 구분이 안 된다.
CREATE UNIQUE INDEX IF NOT EXISTS sub_acct_name_uniq
  ON sub_accounts (user_id, name);

-- RLS. `public` 스키마의 표는 PostgREST로 인터넷에 노출되고, anon 키는
-- 브라우저 번들에 들어 있는 공개 값이다 (022 마이그레이션 참조).
ALTER TABLE sub_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sub_acct_service ON sub_accounts;
CREATE POLICY sub_acct_service ON sub_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 것만 읽고 쓴다. 이건 **사용자가 직접 정하는 설정**이라 쓰기도 연다 —
-- 성적표(ai_predictions)와 달리 스스로 고칠 수 있어야 하는 값이다.
DROP POLICY IF EXISTS sub_acct_owner ON sub_accounts;
CREATE POLICY sub_acct_owner ON sub_accounts
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
