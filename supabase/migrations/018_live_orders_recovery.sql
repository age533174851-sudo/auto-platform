-- 018_live_orders_recovery.sql
-- UNKNOWN 주문을 거래소 조회로 확정하기 위한 근거 컬럼.
--
-- 왜 필요한가
-- ───────────
-- 기존 대조 로직은 "거래소에 주문이 안 보이면 전송되지 않은 것"으로 즉시
-- 확정했다. 그런데 거래소가 아직 반영하지 못했거나 조회가 실패했을 수도
-- 있다. 그 상태에서 FAILED로 찍으면 재시도가 열리고, 그 재시도가 그대로
-- 중복 체결이 된다.
--
-- 확정하려면 두 가지가 더 필요하다:
--   1) 전송 후 얼마나 지났는가        → sent_at (이미 있음)
--   2) 그 사이 포지션이 변했는가      → pos_qty_before (여기서 추가)
-- 주문이 안 보이는데 포지션이 변했다면 모순이므로 자동 확정하면 안 된다.

ALTER TABLE live_orders
  -- 주문 전송 직전에 읽은 해당 심볼의 포지션 수량 (부호 있음).
  -- 조회에 실패하면 NULL — 그 경우 교차 확인 없이 판단한다는 뜻이므로
  -- 확정 사유 문구에도 그 사실이 남는다.
  ADD COLUMN IF NOT EXISTS pos_qty_before  NUMERIC,
  -- 자동 조회를 몇 번 시도했는가. 일정 횟수를 넘으면 사람에게 넘긴다.
  ADD COLUMN IF NOT EXISTS resolve_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_resolve_at  TIMESTAMPTZ,
  -- 자동 확정이 불가능하다고 판단된 주문. 화면에서 눈에 띄게 띄워야 한다.
  ADD COLUMN IF NOT EXISTS needs_attention  BOOLEAN NOT NULL DEFAULT FALSE;

-- 사람 확인이 필요한 주문을 빠르게 찾기 위한 인덱스
CREATE INDEX IF NOT EXISTS live_orders_attention_idx
  ON live_orders (needs_attention, created_at DESC)
  WHERE needs_attention = TRUE;
