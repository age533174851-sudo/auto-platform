-- 064_equity_snapshot_bucket.sql
--
-- **자산 기록이 사람이 화면을 여는 시간에만 남고 있었다.**
--
-- 048은 `UNIQUE (user_id, env, account_key, taken_at)`을 걸어 두고
-- "같은 순간을 두 번 찍지 않는다"고 적었다. 그런데 `taken_at`은
-- 밀리초까지 들어간 실제 시각이라 **같은 값이 두 번 나올 수 없다.**
-- 그 제약은 지금까지 한 번도 아무것도 막지 못했다.
--
-- 실제로 중복을 막고 있던 것은 애플리케이션의 "마지막 기록에서 15분"
-- 판정 하나였고, 그건 탭을 두 개 열면 진다. 두 요청이 같은 마지막
-- 시각을 읽고 둘 다 "15분 지났다"로 판정한다. 표가 부풀면 그날 손익이
-- 두 배로 보인다.
--
-- 무엇을 바꾸나
-- ─────────────
-- **시각이 아니라 칸에 찍는다.** 15분을 한 칸으로 보고 칸의 시작 시각을
-- 키로 쓴다. 같은 칸의 두 번째 쓰기는 **DB가** 막는다 — 경쟁 조건에서
-- 애플리케이션 판정은 언제나 지고, 제약은 지지 않는다.
--
-- 옛 행은 그대로 둔다
-- ───────────────────
-- 이미 쌓인 행의 `bucket_start`는 NULL로 남긴다. **되돌아가서 채우지
-- 않는다** — GET이 찍던 시절의 간격은 칸에 맞춰져 있지 않아서, 채우면
-- 한 칸에 두 행이 생기고 인덱스 생성이 실패한다. 그리고 옛 행을
-- 지우거나 합치는 것은 기록을 고치는 일이라 자동으로 할 일이 아니다.
--
-- Postgres는 키에 NULL이 하나라도 있으면 그 행을 서로 다른 것으로 본다.
-- 그래서 옛 행은 새 제약과 충돌하지 않고, 곡선에도 그대로 남는다.

ALTER TABLE account_equity_snapshots
  ADD COLUMN IF NOT EXISTS bucket_start TIMESTAMPTZ;

-- **부분 인덱스로 만들지 않는다.** `WHERE bucket_start IS NOT NULL`을
-- 붙이면 upsert의 충돌 대상으로 쓸 수 없다(중재 인덱스를 찾을 때
-- 같은 WHERE 절이 필요하다). NULL 행은 어차피 서로 충돌하지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS aes_bucket_uniq
  ON account_equity_snapshots (user_id, env, account_key, bucket_start);

COMMENT ON COLUMN account_equity_snapshots.bucket_start IS
  '이 기록이 속한 15분 칸의 시작 시각. taken_at에 걸린 유일 제약은 밀리초가 매번 달라 아무것도 막지 못했다 — 중복은 판정이 아니라 이 칸 키로 막는다. NULL은 GET이 찍던 시절의 옛 행이다';
