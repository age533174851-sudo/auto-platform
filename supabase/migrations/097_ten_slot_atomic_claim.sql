-- 097: 10슬롯 예약과 주문 의도를 **한 트랜잭션**으로 묶는다
--
-- #531이 가리키는 구멍은 이것이다. `scripts/ten-slot-coupled-offline.mjs`는
-- 예약(슬롯 점유)과 주문 의도(client_order_id)를 **하나의 CAS**로 모델링해
-- 두었다. 그런데 그건 FakeDB 참조 계약일 뿐이고, 실제 DB에는 그 원자성을
-- 보장하는 것이 한 줄도 없었다:
--
--   · `012_live_orders.sql`은 `client_order_id`에 전역 UNIQUE만 걸었다.
--     같은 캠페인의 **두 요청이 서로 다른 client_order_id로 동시에** 들어오면
--     둘 다 통과한다 — 한 포지션만 허용하는 캠페인에 주문이 두 건 나간다.
--   · `013_daily_slots.sql`의 `daily_slot_uses`는 레거시 DAILY_HIGH_LEV용이고
--     10슬롯 캠페인의 정본이 아니다. 거기에 얹으면 하루 1건 규칙이 조용히
--     10슬롯 규칙으로 바뀐다.
--
-- 즉 지금까지 "동시 두 건"을 막는 것은 **응용 코드의 순서**뿐이었다.
-- 프로세스가 둘이면(웹 라우트 + 워커) 그 순서는 공유되지 않는다.
--
-- ■ 무엇을 하는가
--
--   캠페인 줄을 잠그고 → 버전을 보고 → 활성 슬롯을 보고 → 슬롯을 예약하고
--   → `live_orders`에 INTENT를 넣는다. 전부 한 함수 = 한 트랜잭션이다.
--   중간에 무엇이 실패하든 통째로 되돌아간다. **"슬롯은 예약됐는데 의도는
--   없음"도, "의도는 있는데 슬롯은 비어 있음"도 만들어질 수 없다.**
--
-- ■ 거래소 요청은 이 안에 없다
--
--   트랜잭션 안에서 네트워크를 기다리면 잠금을 쥔 채로 수십 초가 지나간다.
--   그리고 응답을 못 받았을 때 롤백하면 **거래소에는 주문이 있는데 장부에는
--   없는** 최악의 상태가 된다. 이 함수는 의도만 **내구적으로** 적고 끝낸다.
--   전송은 커밋이 확인된 뒤 별도 경로의 몫이다(012의 원칙 그대로).
--
-- ■ 금액과 노출을 계산하지 않는다
--
--   074가 적어 둔 원칙과 같다. 증거금 예산은 `startingEquity / 10`이라는
--   한 줄의 정의라서 **아예 저장하지 않는다** — 두 곳에 적으면 언젠가
--   한쪽만 바뀐다. 거래소 노출(positions/openOrders/pendingEntries)도
--   SQL이 조회할 수 없으므로 인자로 받는다. 다만 **확인하지 못한 노출을
--   0으로 적지 않는다**: NULL이나 음수가 오면 EXPOSURE_UNKNOWN으로 막는다.
--
-- ■ 체크리스트가 아니라 제약으로 막는다
--
--   `ten_slot_active_one`은 캠페인당 활성 슬롯이 **둘일 수 없게** 만드는
--   부분 UNIQUE 인덱스다. 미래의 어떤 경로가 FOR UPDATE를 빼먹어도 DB가
--   거절한다. 잠금은 순서를 세우는 수단이고, 불변식은 제약이 지킨다.
--
-- ADDITIVE 전용이다. 기존 표·칸을 만들지도 지우지도 고치지도 않는다.

CREATE TABLE IF NOT EXISTS ten_slot_campaigns (
  campaign_id     TEXT PRIMARY KEY,
  user_id         UUID NOT NULL,
  connection_id   UUID,
  -- MOCK / TESTNET / LIVE의 장부는 절대 합산하지 않는다. 캠페인마다 하나다.
  environment     TEXT NOT NULL,
  starting_equity NUMERIC NOT NULL,
  -- CAS 버전. 모든 내구적 전이가 정확히 1 올린다.
  version         BIGINT NOT NULL DEFAULT 0,
  killed          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ten_slot_campaigns_env_chk
    CHECK (environment IN ('MOCK', 'TESTNET', 'LIVE')),
  CONSTRAINT ten_slot_campaigns_equity_chk CHECK (starting_equity > 0),
  CONSTRAINT ten_slot_campaigns_version_chk CHECK (version >= 0)
);

CREATE TABLE IF NOT EXISTS ten_slot_slots (
  campaign_id TEXT NOT NULL REFERENCES ten_slot_campaigns (campaign_id),
  slot_index  INT  NOT NULL,
  status      TEXT NOT NULL DEFAULT 'FREE',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, slot_index),
  CONSTRAINT ten_slot_slots_index_chk CHECK (slot_index >= 0 AND slot_index < 10),
  -- 'FREE'로 되돌아가는 전이는 없다 — 소비된 버킷을 조용히 재활용하지 않는다.
  CONSTRAINT ten_slot_slots_status_chk
    CHECK (status IN ('FREE', 'RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN', 'SPENT'))
);

-- **캠페인당 활성 슬롯은 하나뿐이다.** 응용 코드가 아니라 DB가 지킨다.
CREATE UNIQUE INDEX IF NOT EXISTS ten_slot_active_one
  ON ten_slot_slots (campaign_id)
  WHERE status IN ('RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN');

CREATE TABLE IF NOT EXISTS ten_slot_claims (
  campaign_id      TEXT NOT NULL,
  slot_index       INT  NOT NULL,
  client_order_id  TEXT NOT NULL,
  -- 같은 트랜잭션에서 만든 live_orders 줄. 끊어지면 의도를 못 찾는다.
  live_order_id    UUID NOT NULL,
  requested_lots   INT  NOT NULL,
  phase            TEXT NOT NULL DEFAULT 'INTENT_PENDING',
  -- 이 예약을 만든 CAS 버전. 사후에 어느 전이였는지 추적한다.
  campaign_version BIGINT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, slot_index),
  FOREIGN KEY (campaign_id, slot_index)
    REFERENCES ten_slot_slots (campaign_id, slot_index),
  -- 의도 줄이 사라지면 이 예약이 무엇을 예약한 것인지 알 수 없게 된다.
  -- 지금 `live_orders`를 지우는 경로는 저장소에 없지만(전수 확인),
  -- 생기더라도 예약만 남은 상태가 만들어지지 않게 DB가 거절한다.
  FOREIGN KEY (live_order_id) REFERENCES live_orders (id),
  CONSTRAINT ten_slot_claims_lots_chk CHECK (requested_lots > 0),
  CONSTRAINT ten_slot_claims_coid_chk
    CHECK (length(client_order_id) > 0 AND length(client_order_id) <= 128)
);

-- client_order_id는 캠페인 안에서도, 캠페인 사이에서도 한 번만 쓰인다.
CREATE UNIQUE INDEX IF NOT EXISTS ten_slot_claims_coid_uniq
  ON ten_slot_claims (client_order_id);
CREATE INDEX IF NOT EXISTS ten_slot_claims_order_idx
  ON ten_slot_claims (live_order_id);

ALTER TABLE ten_slot_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ten_slot_slots     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ten_slot_claims    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ten_slot_campaigns_service ON ten_slot_campaigns;
CREATE POLICY ten_slot_campaigns_service ON ten_slot_campaigns
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ten_slot_campaigns_owner ON ten_slot_campaigns;
CREATE POLICY ten_slot_campaigns_owner ON ten_slot_campaigns
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS ten_slot_slots_service ON ten_slot_slots;
CREATE POLICY ten_slot_slots_service ON ten_slot_slots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ten_slot_claims_service ON ten_slot_claims;
CREATE POLICY ten_slot_claims_service ON ten_slot_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── 캠페인 개설 ──
--
-- 캠페인 줄과 슬롯 10줄은 **함께 생기거나 함께 안 생긴다.** 쪼개서 넣으면
-- 슬롯이 7개인 캠페인이 만들어지고, 그 뒤의 모든 판단이 그 위에서 돈다.
-- 이미 있으면 ALREADY_OPEN을 돌려주고 아무것도 바꾸지 않는다 — 재호출이
-- 버전을 올리거나 슬롯을 되돌리지 않는다.
CREATE OR REPLACE FUNCTION public.ten_slot_open_campaign(
  p_campaign_id     TEXT,
  p_user_id         UUID,
  p_connection_id   UUID,
  p_environment     TEXT,
  p_starting_equity NUMERIC
)
RETURNS TABLE (code TEXT, campaign_version BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_version BIGINT;
BEGIN
  SELECT c.version INTO v_version
    FROM public.ten_slot_campaigns AS c
   WHERE c.campaign_id = p_campaign_id
     FOR UPDATE;

  IF v_version IS NOT NULL THEN
    RETURN QUERY SELECT 'ALREADY_OPEN'::TEXT, v_version;
    RETURN;
  END IF;

  INSERT INTO public.ten_slot_campaigns
    (campaign_id, user_id, connection_id, environment, starting_equity)
  VALUES
    (p_campaign_id, p_user_id, p_connection_id, p_environment, p_starting_equity);

  INSERT INTO public.ten_slot_slots (campaign_id, slot_index)
  SELECT p_campaign_id, i FROM generate_series(0, 9) AS g(i);

  RETURN QUERY SELECT 'OPENED'::TEXT, 0::BIGINT;
END;
$$;

-- ── 예약 + 주문 의도 (원자적) ──
--
-- 반환 코드는 `scripts/ten-slot-offline.mjs`의 판정 코드와 **같은 이름,
-- 같은 순서**다. 두 곳에 같은 판단이 있다는 뜻이므로, 어긋나면 알 수
-- 있도록 `scripts/ten-slot-pg.test.mjs`가 두 경로의 코드를 전수 비교한다.
--
--   CAMPAIGN_MISSING  캠페인이 없다 (만들지 않는다)
--   COUPLING_CORRUPT  슬롯 10줄이 아니거나 FREE/비FREE 배열이 불가능하다
--   INTENT_INVALID    client_order_id나 수량이 유효하지 않다
--   MOCK_NOT_TRADABLE 모의 캠페인이다 — 실거래 장부에 의도를 적지 않는다
--   ENVIRONMENT_MISMATCH 캠페인 환경과 호출자가 말한 주문 모드가 다르다
--   ORDER_ID_REUSED   그 주문 ID는 이미 쓰였다 (예약 또는 live_orders에)
--   STALE_VERSION     읽은 버전이 지금 버전이 아니다 (= 경합에서 졌다)
--   KILL_SWITCH       캠페인이 중지됐다
--   EXPOSURE_UNKNOWN  노출을 확인하지 못했다 — 0으로 적지 않는다
--   EXPOSURE_BUSY     거래소에 이미 포지션·주문이 있다
--   SLOT_BUSY         활성 슬롯이 이미 있다
--   EXHAUSTED         FREE 슬롯이 없다
--   RESERVATION_AND_INTENT_DURABLE  둘 다 커밋됐다 (전송은 아직 아니다)
CREATE OR REPLACE FUNCTION public.ten_slot_claim(
  p_campaign_id              TEXT,
  p_expected_version         BIGINT,
  p_client_order_id          TEXT,
  p_requested_lots           INT,
  p_exposure_positions       INT,
  p_exposure_open_orders     INT,
  p_exposure_pending_entries INT,
  p_exchange                 TEXT,
  p_mode                     TEXT,
  p_symbol                   TEXT,
  p_side                     TEXT,
  p_order_type               TEXT,
  p_quantity                 NUMERIC,
  p_price                    NUMERIC,
  p_leverage                 INT,
  p_reduce_only              BOOLEAN,
  p_signal_id                TEXT
)
RETURNS TABLE (code TEXT, slot_index INT, campaign_version BIGINT, live_order_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_campaign   public.ten_slot_campaigns;
  v_slots      INT;
  v_non_free   INT;
  v_active     INT;
  v_index      INT;
  v_mode       TEXT;
  v_order_id   UUID;
  v_next       BIGINT;
  v_rows       INT;
  v_constraint TEXT;
BEGIN
  -- ① 캠페인 줄을 잠근다. 없으면 여기서 끝 — 만들지 않는다(071·074의 규칙).
  SELECT * INTO v_campaign
    FROM public.ten_slot_campaigns AS c
   WHERE c.campaign_id = p_campaign_id
     FOR UPDATE;

  IF v_campaign.campaign_id IS NULL THEN
    RETURN QUERY SELECT 'CAMPAIGN_MISSING'::TEXT, NULL::INT, NULL::BIGINT, NULL::UUID;
    RETURN;
  END IF;

  -- ② 장부가 읽을 수 있는 모양인가. **못 읽은 것을 통과로 적지 않는다.**
  --    슬롯 10줄이 있어야 하고, 비FREE는 0..k-1에 연속으로 있어야 한다
  --    (SPENT 앞머리 → 활성 하나 → FREE 꼬리). 그 배열이 깨진 스냅샷은
  --    어느 쪽을 믿어도 틀리므로 고치지 않고 거절한다.
  -- 표에 별명을 붙여 칸을 가리킨다. RETURNS TABLE의 `slot_index`와 칸 이름이
  -- 같아서, 별명을 빼면 plpgsql이 어느 쪽인지 알 수 없다고 거절한다.
  SELECT count(*),
         count(*) FILTER (WHERE s.status <> 'FREE'),
         count(*) FILTER (WHERE s.status IN ('RESERVED', 'OPEN', 'CLOSING', 'UNKNOWN')),
         min(s.slot_index) FILTER (WHERE s.status = 'FREE')
    INTO v_slots, v_non_free, v_active, v_index
    FROM public.ten_slot_slots AS s
   WHERE s.campaign_id = p_campaign_id;

  IF v_slots <> 10 OR v_active > 1
     OR COALESCE(v_index, v_non_free) <> v_non_free THEN
    RETURN QUERY SELECT 'COUPLING_CORRUPT'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  -- ③ 의도 자체가 성립하는가
  IF p_client_order_id IS NULL OR length(btrim(p_client_order_id)) = 0
     OR length(p_client_order_id) > 128
     OR p_requested_lots IS NULL OR p_requested_lots <= 0 THEN
    RETURN QUERY SELECT 'INTENT_INVALID'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  -- ③-2 **환경 경계. MOCK / TESTNET / LIVE의 장부는 절대 섞이지 않는다.**
  --
  --   예전에는 `live_orders.mode`에 **호출자가 넘긴 `p_mode`를 그대로**
  --   적었다. 캠페인의 `environment`와 비교하는 코드가 한 줄도 없어서
  --   TESTNET 캠페인이 `mode='LIVE'`인 의도를 커밋할 수 있었다. 라우트가
  --   붙는 순간 그건 실계좌 주문이 된다.
  --
  --   그래서 **적을 값을 호출자에게서 받지 않는다** — 캠페인 환경에서
  --   끌어낸다. `p_mode`는 호출자가 믿고 있는 환경을 **선언**하는 값으로만
  --   쓰고, 둘이 다르면 거절한다. 조용히 한쪽을 따르면 호출부와 장부가
  --   서로 다른 환경을 믿은 채로 진행한다.
  v_mode := CASE v_campaign.environment
    WHEN 'TESTNET' THEN 'TESTNET'
    WHEN 'LIVE'    THEN 'LIVE'
    ELSE NULL
  END;

  IF v_mode IS NULL THEN
    -- 모의 캠페인을 실거래 장부로 조용히 바꾸지 않는다. 막고 말한다.
    RETURN QUERY SELECT 'MOCK_NOT_TRADABLE'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  IF p_mode IS DISTINCT FROM v_mode THEN
    RETURN QUERY SELECT 'ENVIRONMENT_MISMATCH'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  -- ④ 그 주문 ID가 이미 쓰였는가. 잠금을 쥔 채로 보므로 동시 호출도
  --    한쪽만 통과한다. live_orders까지 보는 이유: 이 캠페인 밖의 경로가
  --    같은 ID로 이미 의도를 적었을 수 있고, 그걸 모르고 또 적으면
  --    아래 INSERT가 깨지면서 전체가 롤백된다 — 그 전에 분명히 말한다.
  IF EXISTS (SELECT 1 FROM public.ten_slot_claims WHERE client_order_id = p_client_order_id)
     OR EXISTS (SELECT 1 FROM public.live_orders WHERE client_order_id = p_client_order_id) THEN
    RETURN QUERY SELECT 'ORDER_ID_REUSED'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  -- ⑤ CAS. 읽은 버전이 지금 버전이 아니면 **경합에서 진 것**이다.
  IF p_expected_version IS NULL OR p_expected_version <> v_campaign.version THEN
    RETURN QUERY SELECT 'STALE_VERSION'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  IF v_campaign.killed THEN
    RETURN QUERY SELECT 'KILL_SWITCH'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  -- ⑥ 거래소 노출. **확인하지 못한 것은 0이 아니다.**
  IF p_exposure_positions IS NULL OR p_exposure_open_orders IS NULL
     OR p_exposure_pending_entries IS NULL
     OR p_exposure_positions < 0 OR p_exposure_open_orders < 0
     OR p_exposure_pending_entries < 0 THEN
    RETURN QUERY SELECT 'EXPOSURE_UNKNOWN'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  IF p_exposure_positions <> 0 OR p_exposure_open_orders <> 0
     OR p_exposure_pending_entries <> 0 THEN
    RETURN QUERY SELECT 'EXPOSURE_BUSY'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  IF v_active > 0 THEN
    RETURN QUERY SELECT 'SLOT_BUSY'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  IF v_index IS NULL THEN
    RETURN QUERY SELECT 'EXHAUSTED'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  v_next := v_campaign.version + 1;

  -- ⑦ 의도를 먼저 적는다(012의 원칙). 거래소 요청은 이 트랜잭션 밖이다.
  INSERT INTO public.live_orders (
    client_order_id, signal_id, user_id, connection_id,
    exchange, mode, symbol, side, order_type,
    quantity, price, leverage, reduce_only, status
  ) VALUES (
    p_client_order_id, p_signal_id, v_campaign.user_id, v_campaign.connection_id,
    -- **캠페인에서 끌어낸 값을 적는다.** 호출자가 넘긴 p_mode가 아니다.
    p_exchange, v_mode, p_symbol, p_side, COALESCE(p_order_type, 'MARKET'),
    p_quantity, p_price, p_leverage, COALESCE(p_reduce_only, FALSE), 'INTENT'
  )
  RETURNING id INTO v_order_id;

  -- ⑧ 예약. 슬롯 상태와 예약 줄과 버전이 **같은 트랜잭션**에서 움직인다.
  UPDATE public.ten_slot_slots AS s
     SET status = 'RESERVED', updated_at = NOW()
   WHERE s.campaign_id = p_campaign_id AND s.slot_index = v_index AND s.status = 'FREE';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- ①에서 잠근 캠페인의 슬롯이 그 사이에 바뀌었다는 뜻이다.
    -- 의도만 남기지 않는다 — 통째로 되돌린다.
    RAISE EXCEPTION
      'ten_slot_claim: 슬롯 %번을 예약하지 못했습니다 (갱신 %행) — 의도를 되돌립니다',
      v_index, v_rows;
  END IF;

  INSERT INTO public.ten_slot_claims (
    campaign_id, slot_index, client_order_id, live_order_id,
    requested_lots, campaign_version
  ) VALUES (
    p_campaign_id, v_index, p_client_order_id, v_order_id,
    p_requested_lots, v_next
  );

  UPDATE public.ten_slot_campaigns AS c
     SET version = c.version + 1, updated_at = NOW()
   WHERE c.campaign_id = p_campaign_id AND c.version = v_campaign.version;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      'ten_slot_claim: 버전 %을 올리지 못했습니다 (갱신 %행) — 예약을 되돌립니다',
      v_campaign.version, v_rows;
  END IF;

  RETURN QUERY SELECT 'RESERVATION_AND_INTENT_DURABLE'::TEXT, v_index, v_next, v_order_id;

EXCEPTION
  WHEN unique_violation THEN
    -- 어느 제약이 깨졌는지는 **문구를 읽어 판단하지 않는다**(074와 같은 이유).
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IN ('ten_slot_claims_coid_uniq', 'live_orders_coid_uniq') THEN
      RETURN QUERY SELECT 'ORDER_ID_REUSED'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
      RETURN;
    END IF;
    IF v_constraint IN ('ten_slot_active_one', 'ten_slot_claims_pkey') THEN
      RETURN QUERY SELECT 'SLOT_BUSY'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
      RETURN;
    END IF;
    -- 모르는 유니크 위반을 '중복'으로 삼키지 않는다 — 진짜 고장이 사라진다.
    RAISE;
END;
$$;

-- ── 캠페인 중지 ──
--
-- 이미 중지돼 있으면 버전을 올리지 않는다. 애매한 커밋 뒤의 재시도가
-- 전이를 하나 더 만들면, 그 뒤의 모든 CAS가 어긋난다.
CREATE OR REPLACE FUNCTION public.ten_slot_kill(
  p_campaign_id TEXT
)
RETURNS TABLE (code TEXT, campaign_version BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_version BIGINT;
  v_killed  BOOLEAN;
BEGIN
  SELECT c.version, c.killed INTO v_version, v_killed
    FROM public.ten_slot_campaigns AS c
   WHERE c.campaign_id = p_campaign_id
     FOR UPDATE;

  IF v_version IS NULL THEN
    RETURN QUERY SELECT 'CAMPAIGN_MISSING'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  IF v_killed THEN
    RETURN QUERY SELECT 'KILL_ALREADY_PERSISTED'::TEXT, v_version;
    RETURN;
  END IF;

  UPDATE public.ten_slot_campaigns AS c
     SET killed = TRUE, version = c.version + 1, updated_at = NOW()
   WHERE c.campaign_id = p_campaign_id;

  RETURN QUERY SELECT 'KILL_PERSISTED'::TEXT, v_version + 1;
END;
$$;

-- 이 표들은 service_role만 쓴다(위 정책). 함수도 **호출자의 권한으로 돈다** —
-- SECURITY DEFINER로 만들지 않는다. 만들면 authenticated가 남의 캠페인에
-- 주문 의도를 적을 통로가 생긴다(074와 같은 판단).
REVOKE ALL ON FUNCTION public.ten_slot_open_campaign(TEXT, UUID, UUID, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_open_campaign(TEXT, UUID, UUID, TEXT, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_claim(
  TEXT, BIGINT, TEXT, INT, INT, INT, INT,
  TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT, BOOLEAN, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_claim(
  TEXT, BIGINT, TEXT, INT, INT, INT, INT,
  TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT, BOOLEAN, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_kill(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_kill(TEXT) TO service_role;

COMMENT ON FUNCTION public.ten_slot_claim(
  TEXT, BIGINT, TEXT, INT, INT, INT, INT,
  TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT, BOOLEAN, TEXT
) IS
  '10슬롯 예약과 live_orders INTENT를 한 트랜잭션으로 적는다. 거래소 요청은 '
  '이 안에 없다. 확인하지 못한 노출은 0으로 적지 않고 EXPOSURE_UNKNOWN으로 막는다. '
  '장부에 적는 mode는 캠페인 환경에서 끌어낸다 — 호출자가 넘긴 값이 아니다.';
COMMENT ON INDEX ten_slot_active_one IS
  '캠페인당 활성 슬롯은 하나뿐이다 — 응용 코드가 FOR UPDATE를 빼먹어도 DB가 거절한다.';
