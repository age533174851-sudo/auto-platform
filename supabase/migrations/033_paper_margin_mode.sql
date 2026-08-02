-- 033_paper_margin_mode.sql
--
-- **모의 포지션에도 마진 모드를 둔다.**
--
-- 왜 없었나
-- ─────────
-- 모의 엔진은 청산가를 `진입가 · 배율`만으로 냈다. 그건 순수 격리 공식이다.
-- 그래서 화면의 '격리' 칩은 눌러도 아무 일도 안 했고, 교차를 고를 수도
-- 없었다 — 고르게 해 봐야 계산이 안 바뀌니까.
--
-- 교차는 다른 계산이다
-- ────────────────────
-- 격리는 이 포지션에 떼어 둔 증거금만 걸린다. 교차는 **계좌 전체가**
-- 포지션을 받친다. 그래서 남은 잔고가 많으면 청산가가 멀어지고 적으면
-- 가까워진다 — 같은 10배라도 잔고에 따라 청산가가 완전히 다르다.
--
-- 이 칸이 없으면 그 차이를 저장할 데가 없고, 저장할 데가 없으면 화면이
-- 무엇을 골랐든 계산은 하나뿐이다.
--
-- 왜 기본값이 ISOLATED인가
-- ────────────────────────
-- 지금까지 만들어진 모든 모의 포지션이 격리 공식으로 계산됐다. 기본값을
-- CROSSED로 두면 **과거 포지션의 청산가가 소급해서 바뀐다** — 장부에
-- 남은 숫자와 화면이 어긋나고, 어느 쪽이 맞는지 알 수 없게 된다.

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS margin_mode TEXT NOT NULL DEFAULT 'ISOLATED';

-- 아는 값만 들어가게 한다. 오타 하나가 '교차인데 격리로 계산'을 만든다.
ALTER TABLE paper_positions
  DROP CONSTRAINT IF EXISTS paper_positions_margin_mode_chk;
ALTER TABLE paper_positions
  ADD CONSTRAINT paper_positions_margin_mode_chk
  CHECK (margin_mode IN ('ISOLATED', 'CROSSED'));
