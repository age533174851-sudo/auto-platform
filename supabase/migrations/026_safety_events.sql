-- 026_safety_events.sql
--
-- **안전장치가 실제로 발동한 기록.**
--
-- 왜 필요한가
-- ───────────
-- 지금까지 주문이 막히면 409를 돌려주고 끝이었다. 어디에도 남지 않는다.
-- 그래서 화면은 설정값만 보여줄 수 있었다 — "오늘 손실 한도 5%".
--
-- 설정값만 보이면 사람은 그것이 **돌고 있다고 믿는다.** 오늘 하루에만
-- 켜져 있다고 믿었는데 실제로는 한 번도 안 돈 안전장치를 여섯 개 찾았다
-- (지표 회피·실전 분류·연결 테스트·선물 잔고·백테스트 청산·캘린더 크론).
-- 전부 에러가 안 나고 화면이 멀쩡한 종류였다.
--
-- 한 번도 발동한 적 없는 안전장치는 **작동한다고 말할 수 없다.**
-- 이 표는 그 차이를 화면에 드러내기 위한 것이다.
--
-- 무엇을 적는가
-- ─────────────
-- 막은 항목 하나당 한 줄이다. 한 주문이 세 항목에 걸리면 세 줄이 남는다 —
-- "무엇이 막았나"를 항목별로 세야 하기 때문이다. 합쳐서 한 줄로 적으면
-- 어느 안전장치가 실제로 일하는지 알 수 없다.
--
-- 통과는 적지 않는다. 통과까지 적으면 이 표가 주문 로그가 되고, 그러면
-- 정작 보고 싶은 '발동'이 묻힌다.

CREATE TABLE IF NOT EXISTS safety_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID,

  -- 체크리스트의 항목 id (DAILY_LOSS_LIMIT · AI_VETO · SUBACCOUNT_LIMIT …)
  kind         TEXT NOT NULL,
  label        TEXT,

  -- **왜 막았나.** 'fail'과 'unknown'은 다른 문제고 대응도 다르다:
  -- 앞은 한도에 걸린 것이고, 뒤는 확인을 못 한 것이다. 합치면 안 된다.
  status       TEXT NOT NULL,

  market       TEXT,
  symbol       TEXT,
  reason       TEXT,

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS safety_events_user_kind_idx
  ON safety_events (user_id, kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS safety_events_recent_idx
  ON safety_events (occurred_at DESC);

ALTER TABLE safety_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS safety_events_service ON safety_events;
CREATE POLICY safety_events_service ON safety_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 읽기만 연다. 이건 **자기가 못 고쳐야 하는 기록**이다 —
-- 발동 이력을 지울 수 있으면 "한 번도 안 걸렸다"를 만들 수 있고,
-- 그러면 이 표의 존재 이유가 사라진다.
DROP POLICY IF EXISTS safety_events_owner ON safety_events;
CREATE POLICY safety_events_owner ON safety_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());
