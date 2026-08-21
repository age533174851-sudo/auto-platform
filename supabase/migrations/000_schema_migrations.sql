-- 000_schema_migrations.sql
--
-- **마지막 손 마이그레이션을 만들기 위한 표.**
--
-- 지금까지 마이그레이션은 사람이 Supabase SQL 편집기에 파일을 복사해
-- 붙여 넣는 일이었다. 그래서 054가 빠진 채로 워커 버전이 영영 '모름'이었고,
-- 055 없이 중지가 반쪽으로 돌았고, 056 없이 장부 writer가 조용히
-- TABLE_MISSING만 남겼다. 셋 다 코드는 맞고 DB만 뒤처진 상태였는데,
-- **그걸 알아채는 유일한 방법이 사람의 기억이었다.**
--
-- 이 표가 그 기억을 대신한다. `scripts/apply-migrations.mjs`가 여기에
-- 적고, `/api/system/status`가 여기를 읽는다.
--
-- 왜 000인가
-- ─────────
-- 번호가 가장 작아야 다른 무엇보다 먼저 적용된다. 이 표가 없으면
-- 나머지를 적용했는지조차 적을 곳이 없다.
--
-- 이 표에 값은 담기지 않는다
-- ──────────────────────────
-- 접속 문자열도, 키도 넣지 않는다. 파일 이름과 체크섬, 시각, 그리고
-- 그때 돌던 커밋만 남는다.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  -- 파일 내용의 sha256 앞 16자. 적용된 뒤 파일이 바뀌면 이 값이 달라진다.
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 누가 적용했는가: 'github-actions' · 'baseline-verified' · 'manual'
  applied_by  TEXT NOT NULL,
  -- 적용 당시 main 커밋. "코드는 있는데 DB가 없다"의 반대편을 적는다.
  runtime_sha TEXT,
  -- APPLIED · FAILED · BASELINE
  status      TEXT NOT NULL DEFAULT 'APPLIED',
  duration_ms INTEGER,
  -- 실패 사유. **여기에 접속 문자열이나 키가 들어가면 안 된다.**
  error       TEXT,
  -- 적용 후 카탈로그에서 표·칸·인덱스·정책을 실제로 확인했는가.
  -- **psql이 0으로 끝난 것과 표가 생긴 것은 다른 사실이다.**
  verified    BOOLEAN,
  verify_detail TEXT
);

CREATE INDEX IF NOT EXISTS schema_migrations_applied_at_idx
  ON schema_migrations (applied_at DESC);

COMMENT ON TABLE schema_migrations IS 'TRAIGO 마이그레이션 적용 기록 — scripts/apply-migrations.mjs가 씁니다';

-- ── 두 배포가 동시에 마이그레이션을 돌리지 않게 ──
--
-- 자동 머지가 연달아 두 번 일어나면 워크플로 두 개가 같은 순간에
-- 같은 파일을 적용하려 든다. 그러면 한쪽은 "이미 있음"으로 통과하고
-- 다른 쪽은 실패로 기록되거나, 최악에는 두 번 실행된다.
--
-- 한 줄짜리 표로 잠근다. 15분이 지난 잠금은 죽은 것으로 보고 가져간다
-- (배포가 중간에 죽으면 잠금이 영원히 남는다).
CREATE TABLE IF NOT EXISTS schema_migration_lock (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder      TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE schema_migration_lock IS '마이그레이션 동시 실행 방지 — 15분 지나면 만료로 봅니다';

-- 두 표 모두 서비스 롤만 읽고 쓴다. 정책을 만들지 않으므로
-- anon·authenticated 키로는 한 줄도 보이지 않는다.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migration_lock ENABLE ROW LEVEL SECURITY;
