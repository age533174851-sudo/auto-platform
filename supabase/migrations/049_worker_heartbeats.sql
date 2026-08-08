-- 049_worker_heartbeats.sql
--
-- **켜짐과 돌고 있음은 다른 사실이다.**
--
-- 지금까지 화면은 `enabled = true`를 보고 "실행 중"이라고 적었다. 그런데
-- 실행기가 죽어 있으면 그 문장은 거짓이다 — 사용자는 그걸 보고 앱을 닫고,
-- 아무것도 돌지 않는다.
--
-- 이 표가 그 차이를 만든다. Worker가 살아 있으면 여기에 심장박동을 찍고,
-- 화면은 **이 값을 보고서만** RUNNING이라고 적는다.
--
-- 왜 별도 표인가
-- ──────────────
-- runtime_jobs에 심장박동 칸을 두면, job이 없을 때는 Worker가 살아 있어도
-- 그 사실을 적을 곳이 없다. 그러면 "실행기는 정상인데 시킬 일이 없다"와
-- "실행기가 죽었다"를 구분할 수 없다 — 둘은 대응이 전혀 다르다.

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  -- 호스트가 준 id를 그대로 쓴다. 여기서 만들어 내면 재시작할 때마다
  -- 달라져서 같은 Machine이 이어받는 것인지 새 것인지 알 수 없다.
  worker_id   TEXT PRIMARY KEY,
  -- 'fly:nrt' 같은 값. 옮겼는지 한눈에 보인다.
  host        TEXT NOT NULL DEFAULT '',
  beat_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 지금 무엇을 하고 있는가. 아무것도 안 하고 있으면 그렇다고 적는다 —
  -- 살아 있다는 것과 일하고 있다는 것도 다른 사실이다.
  status      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_heartbeats_beat_idx
  ON worker_heartbeats (beat_at DESC);

COMMENT ON TABLE worker_heartbeats IS
  '화면은 이 값을 보고서만 RUNNING이라고 적는다. enabled=true만으로 실행 중이라고 쓰면 실행기가 죽었을 때 거짓이 된다';
COMMENT ON COLUMN worker_heartbeats.worker_id IS
  '호스트가 준 id(FLY_MACHINE_ID 등). 지어내면 재시작마다 달라져 임대 주인이 계속 바뀐다';
COMMENT ON COLUMN worker_heartbeats.status IS
  '살아 있음과 일하고 있음은 다르다. 시킬 일이 없으면 그렇다고 적는다';

-- ── 읽기만 허용 ───────────────────────────────────────────
--
-- Worker는 service_role로 쓴다(RLS 우회). 화면은 읽기만 하면 된다 —
-- 화면이 심장박동을 쓸 수 있으면 그건 '관측'이 아니라 '희망'이 된다.
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY worker_heartbeats_read ON worker_heartbeats
    FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
