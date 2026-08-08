-- 044_runtime_jobs.sql
--
-- **기능마다 Worker를 하나씩 만들면 같은 실수를 매번 다시 한다.**
--
-- 지금 브라우저 타이머로 도는 것이 넷이다:
--
--   MockAutoTrade         MOCK 자동매매 10초
--   AutoTradeEngine       전략빌더 전략 60초
--   DemoRunner            데모
--   ScheduledExitPanel    예약 청산 30초
--
-- 여기에 앞으로 DCA·Trailing·TWAP·Scaled가 더 붙는다. 각각 따로 만들면
-- 심장박동·임대·중복방지·복구를 여덟 번 짜게 되고, 여덟 번 중 몇 번은
-- 틀린다. **공통 구조 하나에 등록만 하는 방식**이 맞다.
--
-- 표 셋
-- ─────
--   runtime_jobs    무엇을 돌리고 있는가 (원하는 상태 + 관측된 상태)
--   runtime_leases  누가 지금 그것을 잡고 있는가 (+ 번호표)
--   runtime_ticks   실제로 언제 무엇을 했는가 (중복 방지 + 빈 구간 기록)
--
-- 왜 원하는 상태와 관측된 상태를 나누는가
-- ────────────────────────────────────────
-- 지금까지는 `enabled` 하나였다. 그래서 Worker가 죽으면 화면이 둘 중
-- 하나로 거짓말했다 — '실행 중'이라고 하거나(안 도는데) '정지'라고
-- 하거나(끈 적 없는데).
--
--   desired_state   사용자가 원하는 것.      RUNNING / PAUSED / STOPPED
--   observed_state  실제로 관측된 것.        RUNNING / DEGRADED / STALE …
--
-- 둘이 다르면 그 자체가 화면에 뜰 정보다:
--
--   원하는 상태  실행
--   실제 상태    Worker 응답 없음 · 42초
--
-- "나는 분명 켰는데 왜 정지야?"가 사라진다.
--
-- 빈 구간을 지어내지 않는다
-- ─────────────────────────
-- runtime_ticks에 `gap_from`/`gap_to`를 둔다. Worker가 3분 죽어 있었다면
-- **그 구간의 tick을 만들지 않고** 빈 구간 한 줄을 남긴다. 10초짜리
-- tick 18개를 지어내면 일어나지 않은 거래 18건을 만드는 것이다.

CREATE TABLE IF NOT EXISTS runtime_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  -- MOCK_AUTO / PAPER / TESTNET_AUTO / LIVE_AUTO / DCA / TRAILING / TWAP …
  runtime_type   TEXT NOT NULL,
  -- 같은 종류를 여러 개 돌릴 수 있다 (심볼별 DCA 등)
  scope_key      TEXT NOT NULL DEFAULT '',

  -- ── 원하는 상태 ──
  desired_state  TEXT NOT NULL DEFAULT 'STOPPED',
  interval_sec   INTEGER NOT NULL DEFAULT 60,
  config         JSONB NOT NULL DEFAULT '{}'::JSONB,
  config_version INTEGER NOT NULL DEFAULT 1,

  -- ── 관측된 상태 ──
  --
  -- **Worker만 쓴다.** 화면이 여기 쓰면 '관측'이 아니라 '희망'이 된다.
  observed_state       TEXT,
  last_tick_at         TIMESTAMPTZ,
  worker_heartbeat_at  TIMESTAMPTZ,
  last_error           TEXT,
  blocked_reason       TEXT,

  started_at     TIMESTAMPTZ,
  stopped_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 같은 사용자·종류·범위는 하나뿐이다. 둘이면 둘 다 돌아 주문이 겹친다.
  UNIQUE (user_id, runtime_type, scope_key)
);

CREATE INDEX IF NOT EXISTS runtime_jobs_due_idx
  ON runtime_jobs (desired_state, last_tick_at)
  WHERE desired_state = 'RUNNING';

COMMENT ON COLUMN runtime_jobs.desired_state IS
  '사용자가 원하는 상태. 이것만 보고 화면에 "실행 중"이라고 쓰면 안 된다';
COMMENT ON COLUMN runtime_jobs.observed_state IS
  'Worker가 관측해 적은 실제 상태. 비어 있으면 아직 확인 못 한 것이고, 정지가 아니다';

-- ── 누가 잡고 있는가 ──────────────────────────────────────
--
-- 두 Worker가 같은 job을 돌리면 같은 주문이 두 번 나간다.
--
-- fencing_token이 임대 만료만으로 못 막는 것을 막는다: 만료된 Worker가
-- 늦게 깨어나 주문을 내려 할 때, 자기 번호가 지금 번호보다 낮으면
-- 아무것도 못 한다. **임대를 새로 잡을 때마다 번호가 오른다.**
CREATE TABLE IF NOT EXISTS runtime_leases (
  job_id         UUID PRIMARY KEY REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  owner_worker_id TEXT NOT NULL,
  fencing_token  BIGINT NOT NULL DEFAULT 1,
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN runtime_leases.fencing_token IS
  '임대를 새로 잡을 때마다 오르는 번호. 주문 직전에 다시 확인해 늦게 깨어난 Worker를 막는다';

-- ── 실제로 언제 무엇을 했는가 ─────────────────────────────
--
-- tick_key가 중복 실행을 막는다. 예정 시각을 주기 격자로 잘라 만들므로
-- **같은 주기의 재시도는 같은 열쇠**가 되고, UNIQUE가 두 번째를 거절한다.
--
-- 주문 중복은 별개다. tick은 한 번 돌았는데 네트워크 타임아웃으로 제출이
-- 두 번 나갈 수 있다 — 그건 orderKey(clientOrderId)가 막는다.
CREATE TABLE IF NOT EXISTS runtime_ticks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         UUID NOT NULL REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  -- '<job_id>:<슬롯번호>'. 빈 구간 줄은 NULL이다
  tick_key       TEXT,
  scheduled_at   TIMESTAMPTZ,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  -- OK / FAILED / SKIPPED / GAP
  result         TEXT NOT NULL DEFAULT 'OK',
  detail         TEXT,
  -- 이 tick을 돈 Worker와 그때의 번호표
  worker_id      TEXT,
  fencing_token  BIGINT,

  -- ── 빈 구간 ──
  --
  -- Worker가 죽어 있던 동안이다. **그 사이의 tick을 지어내지 않는다** —
  -- 시장이 어떻게 움직였는지 모르므로, 모른다고 한 줄 남기고 다음 실제
  -- tick부터 재개한다.
  gap_from       TIMESTAMPTZ,
  gap_to         TIMESTAMPTZ,
  missed_ticks   INTEGER,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- **같은 tick을 두 번 돌 수 없다.** 빈 구간 줄(tick_key IS NULL)은 제외한다.
CREATE UNIQUE INDEX IF NOT EXISTS runtime_ticks_key_uidx
  ON runtime_ticks (tick_key) WHERE tick_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runtime_ticks_job_idx
  ON runtime_ticks (job_id, started_at DESC);

COMMENT ON COLUMN runtime_ticks.tick_key IS
  '예정 시각을 주기 격자로 자른 열쇠. UNIQUE라 같은 주기의 재시도가 두 번 돌지 않는다';
COMMENT ON COLUMN runtime_ticks.gap_from IS
  'Worker가 죽어 있던 구간. 이 구간의 tick은 만들지 않는다 — 지어낸 체결은 없던 거래를 만든다';
