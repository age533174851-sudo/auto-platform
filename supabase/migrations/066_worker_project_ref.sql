-- 066_worker_project_ref.sql
--
-- **6자 지문이 같다는 것만으로 같은 데이터베이스라고 단정하지 않는다.**
--
-- 무엇이 있었나
-- ─────────────
-- 워커는 `supabase_fingerprint`(sha256 앞 6자)를 남기고, 웹도 같은
-- 방식으로 자기 지문을 보여 준다. 두 값이 같으면 "같은 DB"라고 읽었다.
--
-- 그런데 6자는 6자다. 그리고 실제로 이런 상태를 겪었다:
--
--   Fly 로그      8/23 현재 `[heartbeat] ok ... target=1351b7` 반복
--   웹 진단       supabase.fingerprint = 1351b7 (같다)
--   같은 표       최신 줄은 8/21 · version 0a3a5cf · alive=false
--
-- 지문만으로는 이 모순을 좁힐 수 없었다. `https://<ref>.supabase.co`의
-- `<ref>`는 **공개 URL의 일부라 비밀이 아니고**, 프로젝트를 정확히
-- 가리킨다. 그래서 지문 옆에 같이 적는다.
--
-- 비밀이 아닌가
-- ─────────────
-- 아니다. 이 값은 브라우저 번들의 `NEXT_PUBLIC_SUPABASE_URL`에 이미
-- 들어 있다. 비밀은 키이지 프로젝트 이름이 아니다.
--
-- 안전한가
-- ────────
-- 칸을 더하기만 한다. 지우지도, 이름을 바꾸지도, 타입을 바꾸지도 않는다.
-- 없어도 워커는 그대로 돈다 — 칸이 없다는 오류가 나면 이 값을 빼고
-- 다시 적는 경로가 이미 있다(`runtimeColumnsMissing`).

ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS project_ref TEXT;

COMMENT ON COLUMN worker_heartbeat.project_ref IS
  'https://<ref>.supabase.co 의 <ref>. 워커가 URL에서 스스로 읽는 값입니다 — 사람이 넣지 않습니다. 지문 6자만으로 같은 DB라고 단정하지 않기 위해 함께 기록합니다';
