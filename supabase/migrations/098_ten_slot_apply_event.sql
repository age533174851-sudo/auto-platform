-- 098_ten_slot_apply_event.sql
--
-- **슬롯의 상태를 증거로만 움직인다.**
--
-- 097이 만든 것과 남긴 것
-- ───────────────────────
-- 097은 예약(`FREE → RESERVED`)과 주문 의도를 한 트랜잭션에 묶었다. 그런데
-- 그 뒤의 전이 — `RESERVED → OPEN → CLOSING → SPENT`와 모호한 응답에서의
-- `UNKNOWN` — 을 움직이는 코드는 **DB에 한 줄도 없다.**
--
-- `scripts/ten-slot-coupled-offline.mjs`가 그 수명주기를 모델로 갖고 있지만
-- 그것은 FakeDB 정본이다. 실제 DB에서는 응용 코드가 `UPDATE`를 직접 쳐야
-- 하고, 그러면 전이 규칙이 **치는 자리마다 하나씩** 생긴다. 웹 라우트와
-- 워커가 각자 쳤다면 언젠가 갈린다 — 이 저장소의 상습 고장 ②다.
--
-- 그래서 전이를 **한 함수에 넣고 그 함수만 쓴다.**
--
-- ★ 증거가 없으면 상태를 올리지 않는다
-- ────────────────────────────────────
-- `CLAUDE.md`: *실제 거래소 증거 없이 `ENTERED`·`CLOSED`·`PROTECTED`·`PASS`를
-- 적지 않는다.* 그 규칙을 타입으로 만든다 — 모든 이벤트는 **무엇을 보고
-- 하는 말인지**(`evidence`)를 함께 내야 한다:
--
--   VENUE_ORDER     거래소 주문 조회로 확인했다
--   VENUE_POSITION  거래소 포지션 조회로 확인했다
--   NONE            확인하지 못했다
--
-- `NONE`으로는 `OPEN`도 `SPENT`도 될 수 없다. 될 수 있는 것은 `UNKNOWN`
-- (모른다고 적는 것)과 `CLOSING`(우리 쪽 의도를 적는 것)뿐이다.
--
-- ★ UNKNOWN은 FREE로 돌아가지 않는다
-- ──────────────────────────────────
-- 모르는 슬롯을 비우면 그 자리에 새 주문이 들어간다. 거래소에 포지션이
-- 남아 있었다면 **같은 캠페인에 두 포지션**이 생긴다. `UNKNOWN`에서 나가는
-- 길은 증거를 다시 구하는 것뿐이다 (`VENUE_ORDER` → `OPEN`,
-- `VENUE_POSITION` → `SPENT`).
--
-- 097의 `ten_slot_slots_status_chk`가 `FREE`로의 복귀를 이미 막고 있고,
-- 이 함수의 전이표도 그 길을 만들지 않는다. 두 곳이 같은 말을 한다.
--
-- ★ 중지(kill)가 이벤트를 막지 않는다
-- ───────────────────────────────────
-- `ten_slot_claim`은 `KILL_SWITCH`로 **새 진입**을 막는다. 이 함수는 막지
-- 않는다 — 막으면 이미 열린 포지션을 **닫을 수 없게 된다.** 중지는
-- "더 열지 말라"이지 "열린 것을 방치하라"가 아니다.
--
-- ★ `ten_slot_claims.phase`는 건드리지 않는다
-- ──────────────────────────────────────────
-- 097이 그 칸을 만들고 `'INTENT_PENDING'`으로 두었지만 아무도 바꾸지
-- 않는다. 여기서 슬롯 상태를 그 칸에 복사하면 **같은 판단이 두 칸에**
-- 생긴다. 정본은 `ten_slot_slots.status` 하나다. `phase`를 어떻게 할지는
-- 별도 판단 사항으로 남긴다.
--
-- 위험 분류
-- ─────────
-- 표와 함수를 **추가만** 한다. 기존 표·칸·제약을 바꾸지 않는다.

-- ── 전이표. **판정은 여기 한 곳에만 있다** ──
--
--   `NULL`은 "그 전이는 없다"는 뜻이다. 호출부가 아니라 이 표가 거절한다.
CREATE OR REPLACE FUNCTION public.ten_slot_next_status(
  p_from     TEXT,
  p_kind     TEXT,
  p_evidence TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- 주문이 거래소에 접수된 것을 **주문 조회로 확인**했다.
    WHEN p_kind = 'ACK' AND p_evidence = 'VENUE_ORDER'
         AND p_from IN ('RESERVED', 'UNKNOWN')                        THEN 'OPEN'
    -- 부분 체결은 상태를 바꾸지 않는다. 기록만 남는다.
    WHEN p_kind = 'PARTIAL_FILL' AND p_evidence = 'VENUE_ORDER'
         AND p_from = 'OPEN'                                          THEN 'OPEN'
    -- 닫겠다는 **우리 쪽 의도**다. 거래소 증거가 필요하지 않다.
    WHEN p_kind = 'CLOSE_REQUEST'
         AND p_from IN ('OPEN', 'UNKNOWN')                            THEN 'CLOSING'
    -- 닫혔다는 것은 **포지션 조회로** 확인해야 한다. 주문이 접수된 것과
    -- 포지션이 사라진 것은 다른 사실이다.
    WHEN p_kind = 'CLOSED' AND p_evidence = 'VENUE_POSITION'
         AND p_from IN ('CLOSING', 'UNKNOWN')                         THEN 'SPENT'
    -- 모른다고 적는 것은 **언제나 할 수 있다.** 증거가 없다는 것이
    -- 이 이벤트의 내용이다.
    WHEN p_kind = 'UNKNOWN_RESPONSE'
         AND p_from IN ('RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN')     THEN 'UNKNOWN'
    ELSE NULL
  END
$$;

COMMENT ON FUNCTION public.ten_slot_next_status(TEXT, TEXT, TEXT) IS
  '슬롯 전이표의 정본. NULL은 그 전이가 없다는 뜻이다. 증거 없이 OPEN·SPENT로 가지 않고, UNKNOWN에서 FREE로 돌아가는 길은 없다.';

-- ── 증거 로그. **덮어쓰지 않고 쌓는다** ──
--
--   같은 `event_id`가 다시 와도 지우거나 바꾸지 않는다. 그래서 응답이
--   유실된 뒤의 재시도가 **멱등**해질 수 있다.
CREATE TABLE IF NOT EXISTS ten_slot_events (
  -- 호출부가 만드는 멱등 키. 같은 사건은 같은 키로 온다.
  event_id          TEXT NOT NULL PRIMARY KEY,
  campaign_id       TEXT NOT NULL,
  slot_index        INT  NOT NULL,
  kind              TEXT NOT NULL,
  evidence          TEXT NOT NULL,
  exchange_order_id TEXT,
  filled_qty        NUMERIC,
  avg_price         NUMERIC,
  -- 전이의 양쪽을 적는다. 사후에 "그때 무엇에서 무엇으로 갔는지"를
  -- 상태 한 칸만 보고 되짚을 수는 없다.
  from_status       TEXT NOT NULL,
  to_status         TEXT NOT NULL,
  campaign_version  BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (campaign_id, slot_index)
    REFERENCES ten_slot_slots (campaign_id, slot_index),
  CONSTRAINT ten_slot_events_kind_chk CHECK (
    kind IN ('ACK', 'PARTIAL_FILL', 'CLOSE_REQUEST', 'CLOSED', 'UNKNOWN_RESPONSE')),
  CONSTRAINT ten_slot_events_evidence_chk CHECK (
    evidence IN ('VENUE_ORDER', 'VENUE_POSITION', 'NONE')),
  -- 체결 수량은 0일 수 있다(아직 안 채워짐). 음수·NaN·Infinity는 수가 아니다.
  CONSTRAINT ten_slot_events_qty_chk CHECK (
    filled_qty IS NULL
    OR (filled_qty <> 'NaN'::NUMERIC AND filled_qty >= 0
        AND filled_qty < 'Infinity'::NUMERIC)),
  -- 가격은 0일 수 없다.
  CONSTRAINT ten_slot_events_price_chk CHECK (
    avg_price IS NULL
    OR (avg_price <> 'NaN'::NUMERIC AND avg_price > 0
        AND avg_price < 'Infinity'::NUMERIC)),
  CONSTRAINT ten_slot_events_coid_chk CHECK (
    exchange_order_id IS NULL
    OR (length(btrim(exchange_order_id)) > 0 AND length(exchange_order_id) <= 128)),
  CONSTRAINT ten_slot_events_id_chk CHECK (
    length(btrim(event_id)) >= 4 AND length(event_id) <= 128)
);

CREATE INDEX IF NOT EXISTS ten_slot_events_slot_idx
  ON ten_slot_events (campaign_id, slot_index, created_at);

ALTER TABLE ten_slot_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ten_slot_events_service ON ten_slot_events;
CREATE POLICY ten_slot_events_service ON ten_slot_events
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

COMMENT ON TABLE ten_slot_events IS
  '슬롯 전이의 증거 로그. 추가만 하고 덮어쓰지 않는다 — 같은 event_id의 재시도가 멱등해지는 근거다. evidence는 그 말을 무엇을 보고 하는지다(VENUE_ORDER·VENUE_POSITION·NONE).';

-- ── 이벤트를 적용한다 ──
--
--   코드:
--     EVENT_APPLIED           전이가 커밋됐다
--     EVENT_ALREADY_APPLIED   같은 event_id의 같은 사건이다 (멱등 · 버전 불변)
--     EVENT_CONFLICT          같은 event_id로 **다른 사건**이 왔다 (fail closed)
--     EVIDENCE_MISSING        그 전이에 필요한 거래소 증거가 없다
--     EVENT_OUT_OF_ORDER      그 상태에서 그 사건은 일어날 수 없다
--     SLOT_MISSING            그 슬롯이 없다
--     CAMPAIGN_MISSING        그 캠페인이 없다
--     CALLER_UNKNOWN          호출자 정체성을 넘기지 않았다
--     CALLER_NOT_OWNER        이 캠페인의 주인이 아니다
--     STALE_VERSION           CAS 실패
CREATE OR REPLACE FUNCTION public.ten_slot_apply_event(
  p_campaign_id          TEXT,
  p_expected_version     BIGINT,
  p_slot_index           INT,
  p_event_id             TEXT,
  p_kind                 TEXT,
  p_evidence             TEXT,
  p_exchange_order_id    TEXT             DEFAULT NULL,
  p_filled_qty           NUMERIC          DEFAULT NULL,
  p_avg_price            NUMERIC          DEFAULT NULL,
  -- 097의 `ten_slot_claim`과 **같은 요구**다. `service_role`은 모든 줄을
  -- 보므로 캠페인 id만 알면 남의 슬롯을 움직일 수 있다. 인증된 정체성을
  -- 여기까지 들고 와야 한다.
  p_caller_user_id       UUID             DEFAULT NULL,
  p_caller_connection_id UUID             DEFAULT NULL
)
RETURNS TABLE (code TEXT, slot_status TEXT, campaign_version BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_campaign public.ten_slot_campaigns;
  v_from     TEXT;
  v_to       TEXT;
  v_prev     public.ten_slot_events;
  v_next     BIGINT;
  v_rows     INT;
BEGIN
  -- ① 캠페인 줄을 잠근다. 전이와 버전 증가가 같은 잠금 안에 있어야
  --    동시 두 이벤트가 섞이지 않는다.
  SELECT * INTO v_campaign
    FROM public.ten_slot_campaigns AS c
   WHERE c.campaign_id = p_campaign_id
     FOR UPDATE;

  IF v_campaign.campaign_id IS NULL THEN
    RETURN QUERY SELECT 'CAMPAIGN_MISSING'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  -- ② 소유권. **거부 응답에 캠페인 값을 담지 않는다** — 담으면 남의
  --    캠페인 id만 알고도 버전을 세어 볼 수 있다(097에서 같은 것을 고쳤다).
  IF p_caller_user_id IS NULL THEN
    RETURN QUERY SELECT 'CALLER_UNKNOWN'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  IF v_campaign.user_id IS DISTINCT FROM p_caller_user_id
     OR v_campaign.connection_id IS DISTINCT FROM p_caller_connection_id THEN
    RETURN QUERY SELECT 'CALLER_NOT_OWNER'::TEXT, NULL::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  -- ③ **멱등 먼저.** 응답을 못 받고 재시도한 호출자가 가장 먼저 만나야
  --    하는 답이다. 여기서 버전을 올리지 않는다.
  SELECT * INTO v_prev
    FROM public.ten_slot_events AS e
   WHERE e.event_id = p_event_id;

  IF v_prev.event_id IS NOT NULL THEN
    -- 같은 키로 **다른 사건**이 오면 둘 중 하나가 틀린 것이고 어느 쪽인지
    -- 알 수 없다. 조용히 한쪽을 고르지 않는다.
    IF v_prev.campaign_id IS DISTINCT FROM p_campaign_id
       OR v_prev.slot_index IS DISTINCT FROM p_slot_index
       OR v_prev.kind IS DISTINCT FROM p_kind
       OR v_prev.evidence IS DISTINCT FROM p_evidence
       OR v_prev.exchange_order_id IS DISTINCT FROM p_exchange_order_id
       OR v_prev.filled_qty IS DISTINCT FROM p_filled_qty
       OR v_prev.avg_price IS DISTINCT FROM p_avg_price THEN
      RETURN QUERY SELECT 'EVENT_CONFLICT'::TEXT, NULL::TEXT, v_campaign.version;
      RETURN;
    END IF;

    RETURN QUERY SELECT 'EVENT_ALREADY_APPLIED'::TEXT, v_prev.to_status,
                        v_campaign.version;
    RETURN;
  END IF;

  -- ④ CAS. 멱등 뒤에 본다 — 재시도는 버전이 이미 올라간 뒤에 오므로,
  --    CAS를 먼저 보면 **멱등 재시도가 STALE_VERSION으로 깨진다.**
  IF p_expected_version IS DISTINCT FROM v_campaign.version THEN
    RETURN QUERY SELECT 'STALE_VERSION'::TEXT, NULL::TEXT, v_campaign.version;
    RETURN;
  END IF;

  -- ⑤ 그 슬롯의 현재 상태.
  SELECT s.status INTO v_from
    FROM public.ten_slot_slots AS s
   WHERE s.campaign_id = p_campaign_id AND s.slot_index = p_slot_index
     FOR UPDATE;

  IF v_from IS NULL THEN
    RETURN QUERY SELECT 'SLOT_MISSING'::TEXT, NULL::TEXT, v_campaign.version;
    RETURN;
  END IF;

  -- ⑥ 전이표에 묻는다. **판정은 한 곳에만 있다.**
  v_to := public.ten_slot_next_status(v_from, p_kind, p_evidence);

  IF v_to IS NULL THEN
    -- 왜 없는 전이인지 구분해서 말한다. "증거가 없어서"와 "그 상태에서는
    -- 일어날 수 없어서"는 호출부가 해야 할 일이 다르다 — 앞은 거래소를
    -- 다시 조회하면 되고, 뒤는 장부를 다시 읽어야 한다.
    IF p_evidence = 'NONE'
       AND (public.ten_slot_next_status(v_from, p_kind, 'VENUE_ORDER') IS NOT NULL
            OR public.ten_slot_next_status(v_from, p_kind, 'VENUE_POSITION') IS NOT NULL)
    THEN
      RETURN QUERY SELECT 'EVIDENCE_MISSING'::TEXT, v_from, v_campaign.version;
    ELSE
      RETURN QUERY SELECT 'EVENT_OUT_OF_ORDER'::TEXT, v_from, v_campaign.version;
    END IF;
    RETURN;
  END IF;

  -- ⑦ 증거 줄과 슬롯과 버전이 **같은 트랜잭션**에서 움직인다.
  INSERT INTO public.ten_slot_events (
    event_id, campaign_id, slot_index, kind, evidence,
    exchange_order_id, filled_qty, avg_price,
    from_status, to_status, campaign_version
  ) VALUES (
    p_event_id, p_campaign_id, p_slot_index, p_kind, p_evidence,
    p_exchange_order_id, p_filled_qty, p_avg_price,
    v_from, v_to, v_campaign.version + 1
  );

  -- 상태가 그대로인 전이(PARTIAL_FILL)도 UPDATE는 한다 — `updated_at`이
  -- 움직여야 "최근에 무언가 있었다"를 읽을 수 있다.
  UPDATE public.ten_slot_slots AS s
     SET status = v_to, updated_at = NOW()
   WHERE s.campaign_id = p_campaign_id AND s.slot_index = p_slot_index
     AND s.status = v_from;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- ①·⑤에서 잠근 줄이 그 사이에 바뀌었다는 뜻이다. 증거만 남기지 않는다.
    RAISE EXCEPTION
      'ten_slot_apply_event: 슬롯 %번을 %에서 %로 옮기지 못했습니다 (갱신 %행)',
      p_slot_index, v_from, v_to, v_rows;
  END IF;

  UPDATE public.ten_slot_campaigns AS c
     SET version = c.version + 1, updated_at = NOW()
   WHERE c.campaign_id = p_campaign_id AND c.version = v_campaign.version
  RETURNING c.version INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION
      'ten_slot_apply_event: 캠페인 % 버전을 올리지 못했습니다', p_campaign_id;
  END IF;

  RETURN QUERY SELECT 'EVENT_APPLIED'::TEXT, v_to, v_next;

EXCEPTION
  -- 동시 두 호출이 같은 `event_id`로 들어오면 늦은 쪽이 PK 충돌로 깨진다.
  -- 그건 "이미 적용됐다"와 같은 사실이다 — 다시 읽어 그렇게 답한다.
  -- (097의 캠페인 동시 개설과 같은 모양이다.)
  WHEN unique_violation THEN
    SELECT * INTO v_prev
      FROM public.ten_slot_events AS e
     WHERE e.event_id = p_event_id;
    IF v_prev.event_id IS NULL THEN
      RAISE;
    END IF;
    RETURN QUERY SELECT 'EVENT_ALREADY_APPLIED'::TEXT, v_prev.to_status,
                        (SELECT c.version FROM public.ten_slot_campaigns AS c
                          WHERE c.campaign_id = p_campaign_id);
END;
$$;

REVOKE ALL ON FUNCTION public.ten_slot_next_status(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_next_status(TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_apply_event(
  TEXT, BIGINT, INT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, UUID
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_apply_event(
  TEXT, BIGINT, INT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, UUID
) TO service_role;

COMMENT ON FUNCTION public.ten_slot_apply_event(
  TEXT, BIGINT, INT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, UUID
) IS
  '슬롯 전이를 증거 로그·슬롯 상태·캠페인 버전과 한 트랜잭션으로 적는다. '
  '같은 event_id의 재시도는 멱등이고 버전을 올리지 않는다. 같은 키의 다른 '
  '사건은 EVENT_CONFLICT로 막는다. 증거 없이 OPEN·SPENT로 올리지 않고 '
  'UNKNOWN에서 FREE로 돌아가지 않는다. 중지(kill)는 이 함수를 막지 않는다 — '
  '막으면 열린 포지션을 닫을 수 없다.';
