-- 040_audit_events.sql
--
-- **감사 로그를 실제로 남긴다.**
--
-- 지금 무엇이 문제인가
-- ────────────────────
-- logAudit은 메모리 배열(auditLog)에 쌓는다. Vercel 서버리스에서는
-- 인스턴스마다 따로고, 콜드 스타트마다 사라진다.
--
-- 즉 **사고가 나서 원인을 찾을 때쯤이면 그 기록은 이미 없다.**
-- 그리고 화면의 "감사 로그"는 지금 이 인스턴스가 처리한 몇 건만 보여
-- 주므로, 비어 있으면 "아무 일도 없었다"로 읽힌다 — 확인한 적 없는 사실이다.
--
-- 무엇을 남기는가
-- ───────────────
-- 배율 변경, 위험 한도 변경, 자동매매 ON/OFF, API 키 변경, 전략 활성화,
-- 주문 실행, 수동 청산, KILL 사용, 권한 변경.
--
-- 공통점은 **나중에 "누가 언제 왜"를 물어보게 되는 것들**이다.
--
-- 시크릿은 남기지 않는다
-- ──────────────────────
-- detail에 요청 본문을 통째로 넣으면 API 키와 웹훅 시크릿이 평문으로
-- 들어간다. 그리고 이 표는 요청보다 오래 남는다.

CREATE TABLE IF NOT EXISTS audit_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID,

  -- 'LEVERAGE_CHANGE' | 'AUTOTRADE_TOGGLE' | 'KILL_SWITCH' | ...
  action     TEXT NOT NULL,
  -- 무엇에 대한 동작인가 (심볼·연결 id·전략 이름)
  resource   TEXT NOT NULL DEFAULT '',
  -- 'success' | 'blocked' | 'failed'
  result     TEXT NOT NULL DEFAULT 'success',

  -- **시크릿이 들어가면 안 된다.** 쓰는 쪽에서 걸러 넣는다.
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,

  connection_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_user_time_idx
  ON audit_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_idx
  ON audit_events (action, created_at DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_events_service ON audit_events;
CREATE POLICY audit_events_service ON audit_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- **읽기만.** 자기 기록을 지울 수 있으면 감사 로그의 존재 이유가 사라진다.
DROP POLICY IF EXISTS audit_events_owner ON audit_events;
CREATE POLICY audit_events_owner ON audit_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());
