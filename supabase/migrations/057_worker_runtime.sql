-- 057_worker_runtime.sql
--
-- **워커가 자기 이야기를 스스로 적는다.**
--
-- 지금까지 "어디서 도는가"는 사람이 넣는 환경변수(`WORKER_PROVIDER`)에
-- 달려 있었다. 안 넣으면 화면은 그냥 '실행기'라고만 적었고, 잘못 넣으면
-- **Railway로 옮긴 적도 없는데 'Railway'라고 적혀 있었다.**
--
-- 그리고 "지금 살아 있나 / 어느 커밋인가 / 같은 DB를 보고 있나"에
-- 답하려면 `fly logs`를 사람이 스크롤해야 했다. 2026-08-19에 그것 때문에
-- 사흘을 잃었다 — 로그에는 tick이 찍히는데 heartbeat 표의 마지막 줄은
-- 사흘 전이었고, 둘이 동시에 참이려면 **다른 곳에 쓰고 있어야** 했는데
-- 그걸 확인할 값이 어디에도 없었다.
--
-- 이 칸들이 그 값이다. 전부 워커가 스스로 적고, `/api/system/runtime-health`
-- 하나가 읽는다. **사람이 로그를 여는 일이 없어진다.**
--
-- 값은 담기지 않는다
-- ─────────────────
-- 지문은 sha256 앞 6자다. 되찾을 수 없고, **같은지 다른지만** 말한다.

ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS machine_id TEXT;
-- 이 워커 프로세스가 언제 떴는가. 재시작이 반복되는지를 이 값으로 본다.
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS tick_count BIGINT;
-- 워커가 보고 있는 Supabase의 지문. 웹이 보는 것과 다르면 **다른 DB다.**
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS supabase_fingerprint TEXT;
-- 거래소 키를 푸는 암호화 키의 지문. 다르면 워커는 키를 복호화하지 못한다.
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS encryption_fingerprint TEXT;
-- 기동 점검 결과. 실패했으면 무엇이 없어서인지 한 줄.
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS startup_ok BOOLEAN;
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS startup_detail TEXT;

COMMENT ON COLUMN worker_heartbeat.provider IS '워커가 스스로 판단한 실행 환경 (FLY/RAILWAY/RENDER/LOCAL). 사람이 넣는 값이 아닙니다';
COMMENT ON COLUMN worker_heartbeat.supabase_fingerprint IS 'SUPABASE_URL의 sha256 앞 6자 — 값이 아니라 같은지 여부만 봅니다';
COMMENT ON COLUMN worker_heartbeat.encryption_fingerprint IS 'EXCHANGE_ENCRYPTION_KEY의 sha256 앞 6자 — 값이 아니라 같은지 여부만 봅니다';
