-- 061_self_heal.sql
--
-- **시스템이 스스로 고친 것과, 고치려다 못 한 것을 남긴다.**
--
-- 자동 복구에는 두 가지 위험이 있다.
--
--   1. 무한 재시작 — 고쳐지지 않는 원인을 계속 재시작으로 덮는다.
--      워커는 3초마다 죽고 살아나고, 로그는 그 소리로 가득 차고,
--      진짜 원인은 그 안에 묻힌다.
--   2. 눈감고 재시작 — 주문이 떠 있는 동안 워커를 갈아 끼우면 그 사이
--      체결을 아무도 안 본다.
--
-- 그래서 시도마다 남긴다. **몇 번째 시도인지 모르면 멈출 줄도 모른다.**

CREATE TABLE IF NOT EXISTS self_heal_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  -- 무엇을 고치려 했는가: STALE_HEARTBEAT · SHA_MISMATCH · MIGRATION_PENDING ...
  trigger      TEXT NOT NULL,
  -- 실제로 한 일: RECONCILE_FIRST · RESTART_WORKER · REDEPLOY_WORKER · APPLY_MIGRATIONS
  action       TEXT NOT NULL,
  -- 같은 원인으로 몇 번째인가. **이 값이 있어야 멈출 줄 안다**
  attempt      INTEGER NOT NULL DEFAULT 1,
  -- HEALED · FAILED · BLOCKED · SKIPPED
  outcome      TEXT NOT NULL DEFAULT 'RUNNING',
  -- 고친 뒤 실제로 나아졌는가. **명령이 0으로 끝난 것과 낫는 것은 다르다**
  verified     BOOLEAN,
  detail       TEXT,
  -- 그때 열려 있던 주문 수. null이면 **못 읽은 것이고, 그때는 재시작하지 않는다**
  open_orders  INTEGER
);

CREATE INDEX IF NOT EXISTS self_heal_runs_recent_idx ON self_heal_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS self_heal_runs_trigger_idx ON self_heal_runs (trigger, started_at DESC);

COMMENT ON TABLE self_heal_runs IS '자동 복구 시도 기록 — 몇 번째인지 알아야 멈출 줄 압니다';

-- ── 배포가 정말 끝났는가 ──
--
-- "머지됐다"와 "배포됐다"와 "그 코드가 돌고 있다"는 서로 다른 사실이다.
-- 이 저장소는 그 셋을 섞어서 두 번 사고를 냈다(8/13 · 8/15).
--
-- 이 표는 **여섯 가지가 전부 확인됐을 때만** VERIFIED를 적는다:
-- main SHA · Vercel SHA · Fly SHA · 워커 생존 · 마이그레이션 적용 · 스키마 검증.
CREATE TABLE IF NOT EXISTS deployment_verifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  main_sha     TEXT,
  vercel_sha   TEXT,
  fly_sha      TEXT,
  worker_fresh BOOLEAN,
  migrations_applied BOOLEAN,
  -- VERIFIED · MISMATCH · UNKNOWN
  verdict      TEXT NOT NULL,
  reason       TEXT
);

CREATE INDEX IF NOT EXISTS deployment_verifications_recent_idx
  ON deployment_verifications (checked_at DESC);

COMMENT ON TABLE deployment_verifications IS '배포 검증 결과 — 여섯 가지가 전부 확인돼야 VERIFIED입니다';

ALTER TABLE self_heal_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployment_verifications ENABLE ROW LEVEL SECURITY;
