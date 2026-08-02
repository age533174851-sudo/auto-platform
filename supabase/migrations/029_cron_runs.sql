-- 029_cron_runs.sql
--
-- **크론이 실제로 돌았는가.**
--
-- 왜 필요한가
-- ───────────
-- vercel.json에 크론 셋이 적혀 있다. 그런데 그게 **돌고 있는지 확인할
-- 방법이 지금까지 없었다.** 어디에도 안 남기 때문이다.
--
-- 실제로 이 저장소에서 캘린더 동기화 크론이 vercel.json에 등록조차 안 된
-- 채로 몇 달을 보냈다. 화면에는 "실제 일정 받기" 버튼이 있었고 에러도
-- 안 났다. 등록을 빠뜨린 것을 아무도 몰랐다.
--
-- 크론은 조용히 죽는다:
--   · 배포 설정에서 빠짐 (프리 플랜은 하루 1회만 허용)
--   · CRON_SECRET이 안 맞아 401 — 응답을 아무도 안 본다
--   · 함수가 타임아웃 — 로그에만 남고 화면에는 안 뜬다
--
-- 셋 다 "설정은 있는데 안 돈다"로 끝난다. 이 표는 그 차이를 드러낸다.
--
-- 실패도 남긴다
-- ─────────────
-- 성공만 적으면 "마지막 성공이 3일 전"과 "3일 동안 매번 실패"가 똑같이
-- 보인다. 뒤쪽이 훨씬 급한데 더 조용하다.

CREATE TABLE IF NOT EXISTS cron_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'exit-monitor' · 'daily-ladder' · 'calendar-sync'
  job          TEXT NOT NULL,

  -- 'ok' | 'failed' | 'skipped'
  --
  -- skipped를 따로 두는 이유: 할 일이 없어서 안 한 것과 못 한 것은
  -- 다르다. 둘을 합치면 "아무것도 안 했다"가 정상인지 사고인지 모른다.
  status       TEXT NOT NULL,

  -- 무엇을 했는가. 화면에 그대로 띄운다
  detail       TEXT,

  -- 걸린 시간(ms). 점점 느려지는 것을 볼 수 있다
  duration_ms  INTEGER,

  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cron_runs_job_time_idx
  ON cron_runs (job, started_at DESC);

ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cron_runs_service ON cron_runs;
CREATE POLICY cron_runs_service ON cron_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 로그인한 사용자는 읽기만. 크론은 계정별이 아니라 시스템 전체라
-- user_id로 나누지 않는다.
--
-- 지우지는 못하게 한다. 실행 이력을 지울 수 있으면 "한 번도 안 돌았다"와
-- "지웠다"를 구분할 수 없고, 그러면 이 표의 존재 이유가 사라진다.
DROP POLICY IF EXISTS cron_runs_read ON cron_runs;
CREATE POLICY cron_runs_read ON cron_runs
  FOR SELECT TO authenticated USING (true);
