-- 038_webhook_secrets.sql
--
-- 웹훅 시크릿을 사람마다 따로 둔다.
--
-- 지금까지 무엇이 문제였나
-- ────────────────────────
-- 트레이딩뷰 웹훅은 환경변수 시크릿 **하나**로 인증했다. 그 값을 아는
-- 사람은 누구든 신호를 넣을 수 있었고, connectionId만 바꾸면 남의 계좌로
-- 주문을 냈다. (연결 소유권 검사가 뒤늦게 붙었지만, 시크릿 자체가
-- 공용이라는 사실은 그대로였다.)
--
-- 그리고 이 값은 트레이딩뷰 알림 본문에 **평문으로** 들어간다. 알림
-- 설정을 화면 공유하거나 스크린샷을 찍는 순간 노출되고, 공용이면 그
-- 한 번으로 모든 사용자가 뚫린다.
--
-- 평문을 저장하지 않는다
-- ──────────────────────
-- 해시만 둔다. 데이터베이스가 새어도 그 값으로 주문을 낼 수 없어야 한다 —
-- API 키를 다루는 원칙과 같다.
--
-- 그래서 시크릿은 **만들 때 한 번만** 보여 준다. 잃어버리면 새로 발급하는
-- 것이지 되찾는 것이 아니다. 되찾을 수 있다면 평문을 어딘가 들고 있다는 뜻이다.

CREATE TABLE IF NOT EXISTS webhook_secrets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,

  -- sha256 hex. **평문은 어디에도 저장하지 않는다.**
  secret_hash TEXT NOT NULL,

  -- 화면에 "지금 걸려 있는 것이 내가 아는 그것인가"를 확인시켜 주는 값.
  -- 해시 앞 6자리라 되돌릴 수 없다.
  fingerprint TEXT NOT NULL,

  -- 사용자가 붙이는 이름. 여러 개를 쓸 때 어느 것을 폐기할지 고르려면 필요하다.
  label       TEXT NOT NULL DEFAULT '',

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 마지막으로 이 시크릿으로 들어온 시각. 안 쓰이는 것을 지울 때 본다.
  last_used_at TIMESTAMPTZ,
  -- 폐기 시각. **행을 지우지 않는다** — 언제 폐기했는지가 사고 조사에
  -- 필요하고, 지워 버리면 "그때 그 시크릿이 살아 있었나"를 알 수 없다.
  revoked_at  TIMESTAMPTZ
);

-- 검증은 해시로 찾는다. 사용자별로 여러 개를 둘 수 있으므로 해시가 열쇠다.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_secrets_hash_idx
  ON webhook_secrets (secret_hash);
CREATE INDEX IF NOT EXISTS webhook_secrets_user_idx
  ON webhook_secrets (user_id, created_at DESC);

ALTER TABLE webhook_secrets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_secrets_service ON webhook_secrets;
CREATE POLICY webhook_secrets_service ON webhook_secrets
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 사용자는 **자기 것의 메타데이터만** 읽는다. secret_hash도 읽히지만
-- 해시라 그것으로 주문을 낼 수는 없다. 그래도 화면은 fingerprint만 쓴다.
DROP POLICY IF EXISTS webhook_secrets_owner ON webhook_secrets;
CREATE POLICY webhook_secrets_owner ON webhook_secrets
  FOR SELECT TO authenticated USING (user_id = auth.uid());
