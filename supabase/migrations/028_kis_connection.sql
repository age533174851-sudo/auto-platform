-- 028_kis_connection.sql
--
-- 한국투자증권(KIS) 연결에 필요한 칸.
--
-- 왜 새 칸이 필요한가
-- ───────────────────
-- 거래소 연결 표는 코인 거래소를 전제로 만들어져 있다 — 키·시크릿·
-- (일부는) 패스프레이즈. 증권사는 여기에 **계좌번호**가 하나 더 붙는다.
-- 같은 앱키로 여러 계좌를 쓸 수 있어서 키만으로는 어디에 주문할지
-- 정할 수 없다.
--
-- 패스프레이즈 칸을 돌려 쓰지 않는다
-- ──────────────────────────────────
-- 구조상 넣을 수는 있다. 암호화도 되어 있고 자리도 남는다.
-- 그런데 그렇게 하면 반년 뒤에 이 표를 읽는 사람이 "패스프레이즈에
-- 왜 계좌번호가 들어 있지"를 겪는다. 그 순간 이 칸이 무엇을 담는지
-- 아무도 확신할 수 없게 되고, 그때부터 실수가 시작된다.
-- 칸 하나 늘리는 값이 그것보다 싸다.

ALTER TABLE exchange_connections
  ADD COLUMN IF NOT EXISTS account_no TEXT;

COMMENT ON COLUMN exchange_connections.account_no IS
  '증권 계좌번호 10자리 (앞 8 + 상품코드 2). 코인 거래소에서는 NULL.';

-- ── 접근토큰 캐시 ────────────────────────────────────────────
--
-- **KIS는 접근토큰 재발급 횟수를 제한한다.** 매 요청마다 새로 받으면
-- 금방 막히고, 막히면 주문도 조회도 전부 실패한다.
--
-- 그래서 반드시 저장한다. 토큰 자체는 24시간짜리 임시값이지만 그걸로
-- 주문을 낼 수 있으므로 **시크릿과 같은 취급**을 한다 — 사용자에게도
-- 안 보여준다(아래 RLS에 SELECT 정책이 없는 이유다).

ALTER TABLE exchange_connections
  ADD COLUMN IF NOT EXISTS kis_access_token TEXT;

ALTER TABLE exchange_connections
  ADD COLUMN IF NOT EXISTS kis_token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN exchange_connections.kis_access_token IS
  'KIS 접근토큰. 24시간짜리지만 주문 권한이 있으므로 시크릿으로 다룬다. 서비스 롤만 읽는다.';
COMMENT ON COLUMN exchange_connections.kis_token_expires_at IS
  '토큰 만료 시각. 이 값이 없으면 토큰을 못 믿는다 — 만료를 추측하지 않는다.';

-- 만료된 토큰을 들고 있을 이유가 없다. 다만 지우는 것은 앱이 아니라
-- 여기서 하지 않는다 — 지우는 순간 재발급이 필요해지고, 그 재발급이
-- 한도에 걸리면 매매가 멈춘다. 만료 판정은 앱이 하고(tokenNeedsRefresh),
-- 이 인덱스는 조회를 빠르게 하는 용도다.
CREATE INDEX IF NOT EXISTS exchange_connections_kis_token_idx
  ON exchange_connections (user_id, exchange_id)
  WHERE kis_access_token IS NOT NULL;
