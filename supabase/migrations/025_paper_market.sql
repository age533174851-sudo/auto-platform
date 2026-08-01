-- 025_paper_market.sql
--
-- 모의 포지션에 **어느 시장인지**를 적는다.
--
-- 왜 필요한가
-- ───────────
-- 지금까지 모의는 USDT 선물만 있었다. 현물을 넣으면 두 종류가 한 표에
-- 섞이는데, 둘은 화면에 보여야 하는 것이 다르다:
--
--   선물  배율 · 청산가 · 증거금
--   현물  **셋 다 없다** (배율 1, 청산 없음, 산 만큼 돈이 나간다)
--
-- 칸이 없으면 현물 포지션에도 '1배 · 청산가 —'가 뜨고, 사용자는 그것을
-- "청산가를 못 읽었다"로 읽는다. 없는 것과 못 읽은 것은 다르다.
--
-- 기본값을 USDM으로 두는 이유
-- ───────────────────────────
-- 이미 들어 있는 행은 전부 선물이다. NULL로 두면 기존 포지션이 '시장 모름'이
-- 되고, 그러면 서브계좌 한도(SUBACCOUNT_LIMIT)가 그것들을 어느 바구니로도
-- 세지 못한다 — 없던 unknown이 생긴다.

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'USDM';

-- 'SPOT' | 'USDM' | 'COINM' 외의 값이 들어가면 판정 함수들이 조용히
-- '해당 없음'으로 흘려보낸다. 그럴 바에 쓰기를 막는다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_pos_market_chk'
  ) THEN
    ALTER TABLE paper_positions
      ADD CONSTRAINT paper_pos_market_chk CHECK (market IN ('SPOT', 'USDM', 'COINM'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS paper_pos_market_idx
  ON paper_positions (user_id, market, status);
