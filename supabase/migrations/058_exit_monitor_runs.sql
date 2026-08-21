-- 058_exit_monitor_runs.sql
--
-- **청산 감시가 돌았는지를 사람이 확인하지 않아도 되게 한다.**
--
-- 2026-08-03부터 30번 연속 401이었다. 그동안 트레일링·본전 이동·시간
-- 청산은 한 번도 돌지 않았는데, **그 사실이 어디에도 남지 않았다.**
-- GitHub Actions의 빨간불 하나가 전부였고, 그건 아무도 안 본다.
--
-- 여기에 회차마다 남긴다. 언제 시작했고 언제 끝났고, 어느 커밋이 돌렸고,
-- 몇 건을 봤고 몇 건을 처리했고, 남은 보호주문을 몇 개 치웠고,
-- **다음엔 언제 돌아야 하는가.** 마지막 칸이 중요하다 — 그게 있어야
-- "안 돌고 있다"를 시스템이 스스로 말할 수 있다.

CREATE TABLE IF NOT EXISTS exit_monitor_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  -- 누가 깨웠는가: worker · cron · github-backup · manual
  source        TEXT NOT NULL DEFAULT 'unknown',
  -- 실행한 워커와 그 커밋. **비어 있으면 '같음'이 아니라 '모름'이다**
  worker_id     TEXT,
  worker_sha    TEXT,
  status        TEXT NOT NULL DEFAULT 'RUNNING',   -- RUNNING · OK · FAILED
  positions_scanned INTEGER,
  actions       INTEGER,
  orphan_cleanups   INTEGER,
  -- #142 증거. 어떤 주문을 정확히 어떤 번호로 취소했는지 그대로 담는다.
  -- **거래소 번호는 문자열이다** — Gate의 int64는 숫자로 담으면 끝자리가 뭉개진다.
  cleanup_detail    JSONB,
  errors        TEXT,
  -- 다음엔 언제 돌아야 하는가. 이 시각을 넘기면 시스템이 스스로 '밀렸다'고 말한다.
  next_expected_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS exit_monitor_runs_started_idx ON exit_monitor_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS exit_monitor_runs_status_idx ON exit_monitor_runs (status, started_at DESC);

COMMENT ON TABLE exit_monitor_runs IS '청산 감시 회차 기록 — 돌았는지를 사람이 확인하지 않아도 되게 합니다';
COMMENT ON COLUMN exit_monitor_runs.next_expected_at IS '이 시각을 넘기면 밀린 것으로 봅니다 (시스템이 스스로 판단)';

-- ── 두 번 돌지 않게 ──
--
-- 워커가 재시작하거나 두 대가 동시에 뜨면 같은 포지션에 손절 이동이 두 번
-- 나갈 수 있다. **한 번 옮긴 손절을 또 옮기는 것은 되돌릴 수 없다.**
--
-- 한 줄짜리 임차(lease)로 막는다. `fence`는 단조 증가하는 번호다 —
-- 느린 실행이 뒤늦게 깨어나 자기가 아직 주인인 줄 알고 주문을 내는 것을
-- 막기 위해, 쓰기 전에 자기 fence가 아직 최신인지 확인한다.
CREATE TABLE IF NOT EXISTS exit_monitor_lease (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder      TEXT NOT NULL,
  fence       BIGINT NOT NULL DEFAULT 1,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE exit_monitor_lease IS '청산 감시 동시 실행 방지 — fence는 단조 증가하는 울타리 번호입니다';

-- 서비스 롤만 읽고 쓴다. 정책을 만들지 않으므로 anon 키로는 한 줄도 안 보인다.
ALTER TABLE exit_monitor_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE exit_monitor_lease ENABLE ROW LEVEL SECURITY;
