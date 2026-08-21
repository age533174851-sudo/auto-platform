-- 060_ops_bootstrap.sql
--
-- **"있을 것으로 보입니다"를 없앤다.**
--
-- 자동화가 스스로 할 수 있는 일과 없는 일을 가르려면, 어떤 권한이 실제로
-- 연결돼 있는지 알아야 한다. 그런데 화면(Vercel)은 GitHub Secrets에 무엇이
-- 들어 있는지 볼 수 없다. 지금까지는 그래서 추측했다 — **추측은 화면이
-- 'Railway'라고 적어 두던 것과 같은 종류의 거짓말이다.**
--
-- 그래서 자격을 가진 쪽(GitHub Actions)이 **직접 써 보고** 그 결과를
-- 여기에 적는다. `FLY_API_TOKEN`이 있는지가 아니라 **그 토큰으로 실제로
-- 앱을 볼 수 있는지**를 적는다 — 있는데 만료된 토큰이 가장 흔한 고장이다.
--
-- 값은 담기지 않는다
-- ─────────────────
-- 상태 세 가지(CONNECTED · MISSING · INVALID)와 언제 확인했는지, 그리고
-- 사람이 읽을 한 줄뿐이다.

CREATE TABLE IF NOT EXISTS ops_bootstrap (
  -- SUPABASE_DB_URL · FLY_API_TOKEN · GITHUB_TOKEN ...
  credential  TEXT PRIMARY KEY,
  -- CONNECTED: 실제로 써 봤고 됐다
  -- MISSING:   값이 없다
  -- INVALID:   값은 있는데 안 된다 (만료·권한 부족)
  state       TEXT NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 어디서 확인했는가 (github-actions)
  checked_by  TEXT,
  -- 사람이 읽을 한 줄. **값·토큰은 절대 넣지 않는다**
  detail      TEXT
);

COMMENT ON TABLE ops_bootstrap IS '외부 서비스 권한 연결 상태 — 값이 아니라 실제로 써 본 결과만 담습니다';
COMMENT ON COLUMN ops_bootstrap.state IS 'CONNECTED(써 봤고 됨) · MISSING(값 없음) · INVALID(값은 있는데 안 됨)';

ALTER TABLE ops_bootstrap ENABLE ROW LEVEL SECURITY;
