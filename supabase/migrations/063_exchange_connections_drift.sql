-- 063_exchange_connections_drift.sql
--
-- **마이그레이션이 현실을 못 따라간 자리를 메운다.**
--
-- 코드 16곳이 `exchange_connections.encrypted_secret`을 읽는다:
--
--   secret = decryptSecret(conn.api_secret_enc ?? conn.encrypted_secret ?? '')
--
-- 그런데 이 칸은 **어느 마이그레이션에도 없다.** 실제 DB에는 있다 —
-- 없었다면 저 select들이 전부 컬럼 오류로 끝나 주문이 한 건도 안 나갔을
-- 것이고, 실제로는 나가고 있다.
--
-- 즉 누군가 손으로 만든 칸이 마이그레이션에 안 적혔다. 그 상태의 문제는
-- 조용하다는 것이다:
--
--   · 새 환경을 세우면 그 칸이 없어서 코드가 통째로 안 돈다
--   · 스키마 검사가 "코드가 없는 칸을 읽는다"고 계속 경고한다
--   · 무엇이 진짜 스키마인지 아무도 확신하지 못한다
--
-- `IF NOT EXISTS`라 이미 있으면 아무 일도 안 일어난다. 없으면 만들어지고,
-- 그때도 코드는 `api_secret_enc`를 먼저 보므로 동작이 바뀌지 않는다.
--
-- **값은 옮기지 않는다.** 이 마이그레이션은 칸의 존재만 맞춘다 —
-- 암호화된 비밀을 복사하는 일은 되돌리기 어렵고, 여기서 할 일이 아니다.

ALTER TABLE exchange_connections
  ADD COLUMN IF NOT EXISTS encrypted_secret TEXT;

COMMENT ON COLUMN exchange_connections.encrypted_secret IS
  '구 버전 비밀 저장 칸. 코드는 api_secret_enc를 먼저 보고, 비어 있을 때만 이 값을 씁니다';
