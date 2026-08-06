-- 039_trading_capability.sql
--
-- **무엇을 거래할 수 있는가** — 회원 등급과 다른 축.
--
-- 왜 profiles.role로는 안 되나
-- ────────────────────────────
-- 지금 있는 role은 `user | vip | ... | super_admin`이고 **회원 등급**이다.
-- 관리자 화면에 들어갈 수 있는가를 정한다.
--
-- 그런데 물어야 하는 것은 다른 질문이다: 이 사람이 **실제 돈으로
-- 자동매매를 켤 수 있는가.** 둘을 섞으면 친구에게 화면을 보여 주려고
-- 등급을 올리는 순간 실전 자동매매까지 켜진다.
--
-- 기본값이 가장 좁은 이유
-- ───────────────────────
-- 넓은 쪽을 기본으로 두면 "아직 설정 안 한 사람"이 곧 "전부 할 수 있는
-- 사람"이 된다. 새 계정은 아무것도 못 한다.

CREATE TABLE IF NOT EXISTS trading_capabilities (
  user_id    UUID PRIMARY KEY,

  -- 'VIEW_ONLY' | 'PAPER_ONLY' | 'TESTNET' | 'LIVE_MANUAL' | 'LIVE_AUTO'
  --
  -- **기본값을 넓히지 않는다.** 여기가 곧 "설정 안 한 사람"의 권한이다.
  capability TEXT NOT NULL DEFAULT 'VIEW_ONLY',

  -- 누가 언제 올렸는가. 권한 상승은 반드시 흔적이 남아야 한다 —
  -- 나중에 "내가 안 올렸는데"를 가릴 수 있어야 하기 때문이다.
  granted_by UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note       TEXT NOT NULL DEFAULT '',

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE trading_capabilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trading_capabilities_service ON trading_capabilities;
CREATE POLICY trading_capabilities_service ON trading_capabilities
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- **자기 것을 읽을 수는 있지만 고칠 수는 없다.**
-- 고칠 수 있으면 권한 체계가 아니라 설정값이 된다.
DROP POLICY IF EXISTS trading_capabilities_owner ON trading_capabilities;
CREATE POLICY trading_capabilities_owner ON trading_capabilities
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- 권한 변경 이력. 지우지 않는다 — 사고 조사에 필요하다.
CREATE TABLE IF NOT EXISTS capability_changes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  from_cap   TEXT,
  to_cap     TEXT NOT NULL,
  changed_by UUID,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS capability_changes_user_idx
  ON capability_changes (user_id, created_at DESC);

ALTER TABLE capability_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capability_changes_service ON capability_changes;
CREATE POLICY capability_changes_service ON capability_changes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS capability_changes_owner ON capability_changes;
CREATE POLICY capability_changes_owner ON capability_changes
  FOR SELECT TO authenticated USING (user_id = auth.uid());
