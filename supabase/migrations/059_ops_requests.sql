-- 059_ops_requests.sql
--
-- **명령과 실행 사이의 다리.**
--
-- "배포해"를 화면에서 눌렀을 때, 그 화면(Vercel)은 GitHub 워크플로를 부를
-- 자격이 없고 Fly 머신을 재시작할 자격도 없다. 그 자격은 GitHub Actions가
-- 이미 가지고 있다(GITHUB_TOKEN · FLY_API_TOKEN).
--
-- 그래서 새 토큰을 하나 더 만들지 않는다. **화면은 요청을 적고, 이미
-- 자격을 가진 쪽이 그것을 집어 간다.** 새로 연결할 권한은 0이다 —
-- 마이그레이션에 이미 필요한 `SUPABASE_DB_URL` 하나로 둘 다 된다.
--
-- 왜 표인가
-- ────────
-- 요청이 큐에 남아 있으면 **무엇을 부탁했고 어떻게 끝났는지**가 사라지지
-- 않는다. "배포해라고 했는데 됐나?"를 사람이 대시보드를 뒤져 확인하는
-- 일이 없어진다.
--
-- 두 번 실행하지 않는다
-- ────────────────────
-- 집어 갈 때 상태를 PENDING → CLAIMED로 바꾸면서 가져간다. 이미 남이
-- 가져간 것은 못 가져간다. 가져간 채로 죽으면 15분 뒤 만료로 본다.

CREATE TABLE IF NOT EXISTS ops_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CHECK_ALL · DEPLOY · VERIFY_TESTNET · RECOVER · STOP_NOW · APPROVE_LIVE_SMALL
  command       TEXT NOT NULL,
  requested_by  UUID,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- **실제 자금·파괴적 변경은 이 칸이 true여야 실행된다.**
  approved      BOOLEAN NOT NULL DEFAULT false,
  -- PENDING · CLAIMED · DONE · FAILED · EXPIRED
  status        TEXT NOT NULL DEFAULT 'PENDING',
  claimed_by    TEXT,
  claimed_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  -- 무엇을 했는가. **사람이 로그를 열지 않아도 되게 결과를 여기 담는다**
  result        JSONB,
  -- 자동으로 못 한 이유. 값·시크릿은 절대 담지 않는다
  error         TEXT
);

CREATE INDEX IF NOT EXISTS ops_requests_pending_idx
  ON ops_requests (status, requested_at);
CREATE INDEX IF NOT EXISTS ops_requests_recent_idx
  ON ops_requests (requested_at DESC);

COMMENT ON TABLE ops_requests IS '운영 명령 요청 — 화면이 적고, 자격을 가진 실행기(GitHub Actions)가 집어 갑니다';
COMMENT ON COLUMN ops_requests.approved IS '실제 자금·파괴적 변경은 이 값이 true여야 실행됩니다';

ALTER TABLE ops_requests ENABLE ROW LEVEL SECURITY;
