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
  -- `NUMERIC`에는 `'Infinity'`가 있다. **`> 0`만으로는 걸러지지 않는다.**
  -- `'NaN'`은 모든 수보다 크므로 `< 'Infinity'`에도 걸리지만, 그 순서에
  -- 기대지 않고 따로 적는다 — 나중에 읽는 사람이 알아볼 수 있어야 한다.
  CONSTRAINT ten_slot_campaigns_equity_chk CHECK (
    starting_equity > 0
    AND starting_equity <> 'NaN'::NUMERIC
    AND starting_equity < 'Infinity'::NUMERIC),
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

-- ── 쓸 수 있는 수인가 ──
--
-- `NUMERIC`은 `'NaN'`과 `'Infinity'`를 담을 수 있다. 둘 다 `> 0` 검사를
-- 통과한다 — `'NaN'`은 모든 수보다 크고, `'Infinity'`는 말할 것도 없다.
-- 실행기(`orderExecutor.ts`)는 `isFinite`로 막는데 SQL은 막지 않았다.
--
-- 수량·가격·시작 자본 세 곳에서 같은 판단을 하므로 **한 곳에 둔다.**
-- (표의 CHECK 제약은 같은 식을 직접 적는다 — 함수를 CHECK에 쓰면
--  덤프·복원 순서에 함수가 표보다 먼저 있어야 하는 제약이 생긴다.
--  그 두 곳이 어긋나지 않는 것은 시험이 지킨다.)
CREATE OR REPLACE FUNCTION public.ten_slot_finite_positive(n NUMERIC)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT n IS NOT NULL
     AND n <> 'NaN'::NUMERIC
     AND n > 0
     AND n < 'Infinity'::NUMERIC
$$;

-- `DOUBLE PRECISION`에도 같은 선을 긋는다.
--
-- 091의 두 칸은 `double precision`이다. `NUMERIC`용 판정에 넘기면 암묵
-- 변환이 일어나고, 그 변환은 `'NaN'`을 그대로 넘긴다 — 걸러진 것처럼
-- 보이지만 걸러지지 않는다. **같은 판단을 타입마다 한 줄씩 적는 대신
-- 함수를 하나 더 둔다.** 식이 두 곳에 흩어지지 않게.
--
-- PostgreSQL에서 `'NaN' = 'NaN'`은 참이므로 `<> 'NaN'`이 NaN을 거른다
-- (IEEE와 다르다 — 여기서 IEEE 습관을 쓰면 통과한다).
CREATE OR REPLACE FUNCTION public.ten_slot_finite_positive_f8(n DOUBLE PRECISION)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT n IS NOT NULL
     AND n <> 'NaN'::DOUBLE PRECISION
     AND n > 0
     AND n < 'Infinity'::DOUBLE PRECISION
$$;

-- ── 이미 있는 캠페인이 **내가 열려던 그 캠페인인가** ──
--
-- 판정을 한 곳에만 둔다. 개설 경로에는 "먼저 읽어 보는 자리"와 "동시
-- 삽입에서 진 뒤 다시 읽는 자리"가 둘 있고, 두 곳에 같은 비교를 적으면
-- 언젠가 한쪽만 바뀐다 — 이 저장소의 상습 고장이다.
--
-- `IS DISTINCT FROM`을 쓴다. `connection_id`는 NULL일 수 있고 `=`는
-- NULL을 만나면 NULL을 돌려줘서 **다른 것을 같다고 읽는다.**
CREATE OR REPLACE FUNCTION public.ten_slot_identity_verdict(
  p_row             public.ten_slot_campaigns,
  p_user_id         UUID,
  p_connection_id   UUID,
  p_environment     TEXT,
  p_starting_equity NUMERIC
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_row.user_id         IS DISTINCT FROM p_user_id
      OR p_row.connection_id   IS DISTINCT FROM p_connection_id
      OR p_row.environment     IS DISTINCT FROM p_environment
      OR p_row.starting_equity IS DISTINCT FROM p_starting_equity
    THEN 'CAMPAIGN_IDENTITY_MISMATCH'
    ELSE 'ALREADY_OPEN'
  END
$$;

-- ── 캠페인 개설 ──
--
-- 캠페인 줄과 슬롯 10줄은 **함께 생기거나 함께 안 생긴다.** 쪼개서 넣으면
-- 슬롯이 7개인 캠페인이 만들어지고, 그 뒤의 모든 판단이 그 위에서 돈다.
--
-- **이미 있다는 것만으로 ALREADY_OPEN을 돌려주지 않는다.** 예전에는
-- `campaign_id`로 줄이 있으면 무조건 성공처럼 끝냈다. 그러면 다른 주인이,
-- 다른 환경으로, 같은 ID를 열었을 때도 `ALREADY_OPEN`이 나온다. 그 뒤의
-- `ten_slot_claim`은 **저장된** 캠페인의 user/connection을 `live_orders`에
-- 적으므로, 호출자는 남의 캠페인을 자기 것으로 믿은 채 주문 의도를 적게
-- 된다. 그래서 정체성을 대조하고 어긋나면 fail-closed로 돌려준다.
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
  v_row        public.ten_slot_campaigns;
  v_constraint TEXT;
BEGIN
  -- 쓸 수 없는 시작 자본으로는 캠페인을 만들지 않는다. 표의 CHECK가
  -- 마지막 방어선이지만, 그건 예외로 터진다 — 호출부가 읽을 수 있는
  -- 코드로 먼저 돌려준다.
  IF NOT public.ten_slot_finite_positive(p_starting_equity) THEN
    RETURN QUERY SELECT 'CAMPAIGN_INVALID'::TEXT, NULL::BIGINT;
    RETURN;
  END IF;

  SELECT * INTO v_row
    FROM public.ten_slot_campaigns AS c
   WHERE c.campaign_id = p_campaign_id
     FOR UPDATE;

  IF v_row.campaign_id IS NOT NULL THEN
    RETURN QUERY SELECT public.ten_slot_identity_verdict(
      v_row, p_user_id, p_connection_id, p_environment, p_starting_equity), v_row.version;
    RETURN;
  END IF;

  INSERT INTO public.ten_slot_campaigns
    (campaign_id, user_id, connection_id, environment, starting_equity)
  VALUES
    (p_campaign_id, p_user_id, p_connection_id, p_environment, p_starting_equity);

  INSERT INTO public.ten_slot_slots (campaign_id, slot_index)
  SELECT p_campaign_id, i FROM generate_series(0, 9) AS g(i);

  RETURN QUERY SELECT 'OPENED'::TEXT, 0::BIGINT;

EXCEPTION
  WHEN unique_violation THEN
    -- **없는 줄의 `FOR UPDATE`는 삽입 경쟁을 직렬화하지 못한다.** 둘 다
    -- "없다"를 보고 INSERT로 가고, 늦은 쪽이 PK 충돌로 깨진다. 그걸 그대로
    -- 던지면 호출부는 "동시 개설"과 "DB 고장"을 구분할 수 없다. 다시 읽어
    -- 위와 **같은 판정**을 돌려준다.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'ten_slot_campaigns_pkey' THEN
      -- 모르는 유니크 위반을 '이미 열림'으로 삼키지 않는다.
      RAISE;
    END IF;
    SELECT * INTO v_row
      FROM public.ten_slot_campaigns AS c
     WHERE c.campaign_id = p_campaign_id;
    RETURN QUERY SELECT public.ten_slot_identity_verdict(
      v_row, p_user_id, p_connection_id, p_environment, p_starting_equity), v_row.version;
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
--   INTENT_INVALID    주문 의도의 모양이 성립하지 않는다 (주문 ID · 로트 ·
--                     수량 · 종목 · 방향 · 거래소 · 주문유형 · 배율 · 지정가)
--   MOCK_NOT_TRADABLE 모의 캠페인이다 — 실거래 장부에 의도를 적지 않는다
--   (ten_slot_open_campaign은 CAMPAIGN_INVALID도 돌려준다 — 쓸 수 없는
--    시작 자본)
--   ENVIRONMENT_MISMATCH 캠페인 환경과 호출자가 말한 주문 모드가 다르다
--   ORDER_ID_REUSED   그 주문 ID는 이미 쓰였다 (예약 또는 live_orders에)
--   STALE_VERSION     읽은 버전이 지금 버전이 아니다 (= 경합에서 졌다)
--   KILL_SWITCH       캠페인이 중지됐다
--   EXPOSURE_UNKNOWN  노출을 확인하지 못했다 — 0으로 적지 않는다
--   EXPOSURE_BUSY     거래소에 이미 포지션·주문이 있다
--   SLOT_BUSY         활성 슬롯이 이미 있다
--   EXHAUSTED         FREE 슬롯이 없다
--   RESERVATION_AND_INTENT_DURABLE  둘 다 커밋됐다 (전송은 아직 아니다)
-- **옛 서명을 먼저 지운다.**
--
-- `CREATE OR REPLACE FUNCTION`은 인자 목록이 다르면 **덮어쓰지 않고
-- 과적재(overload)한다.** 그러면 같은 이름의 함수가 두 개 남고, 둘 중
-- 어느 쪽이 불릴지는 호출부가 넘긴 인자 수에 달린다 — "경로가 둘인데
-- 한쪽만 고침"이 생기는 자리다. 이 마이그레이션을 이미 적용한 DB가
-- 있다면 그 17인자 함수를 지우고 하나만 남긴다.
DROP FUNCTION IF EXISTS public.ten_slot_claim(
  TEXT, BIGINT, TEXT, INT, INT, INT, INT,
  TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT, BOOLEAN, TEXT
);

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
  p_signal_id                TEXT,
  -- ── 의도에 함께 적는 정책·계약·좌표 ──
  --
  --   **기본값은 NULL이다.** 078·090·091이 모두 같은 말을 적어 뒀다:
  --   NULL은 "그런 일이 없었다"가 아니라 **"기록이 없다"**다. 그래서 안
  --   넘기면 0이나 거짓 기본값으로 채우지 않고 비워 둔다.
  --
  --   이 칸을 받지 않던 동안 이 함수가 적는 의도 줄은 `stop_policy`가
  --   비어 있었다. 그 줄을 전송 단계가 이어받으면 복구 경로는 그것을
  --   **고정 손절 주문으로 읽는다**(078 주석의 고장). 계약 세 칸이 없으면
  --   "배율 100이고 손절이 없으니 Exact100X겠지"로 되돌아간다(090이 끝낸
  --   추론). 적을 수 있어야 그 두 고장이 닫힌다.
  p_stop_loss                NUMERIC          DEFAULT NULL,
  p_take_profit              NUMERIC          DEFAULT NULL,
  p_stop_policy              TEXT             DEFAULT NULL,
  p_execution_profile_id     TEXT             DEFAULT NULL,
  p_execution_preset_id      TEXT             DEFAULT NULL,
  p_execution_contract_version INT            DEFAULT NULL,
  p_entry_adverse_distance_pct DOUBLE PRECISION DEFAULT NULL,
  p_entry_liquidation_distance_pct_raw DOUBLE PRECISION DEFAULT NULL
)
RETURNS TABLE (code TEXT, slot_index INT, campaign_version BIGINT, live_order_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_campaign   public.ten_slot_campaigns;
  v_slots      INT;
  v_active     INT;
  v_ordered    BOOLEAN;
  v_index      INT;
  v_mode       TEXT;
  v_type       TEXT;
  v_reduce     BOOLEAN;
  v_policy     TEXT;
  v_profile    TEXT;
  v_preset     TEXT;
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
  --
  --    유효한 배열은 **SPENT* → 활성 하나? → FREE*** 하나뿐이다
  --    (`scripts/ten-slot-offline.mjs`의 `validSlotOrder`). 그 배열이 깨진
  --    스냅샷은 어느 쪽을 믿어도 틀리므로 고치지 않고 거절한다.
  --
  --    예전에는 "최초 FREE 인덱스 == 비FREE 개수"만 봤다. 그건 **비FREE가
  --    앞쪽에 몰려 있는가**만 보는 것이고, 그 앞쪽 **안에서** SPENT가
  --    먼저인지는 보지 않는다. 그래서 `[RESERVED, SPENT, FREE×8]`처럼
  --    활성 뒤에 SPENT가 오는 손상된 장부가 통과해 `SLOT_BUSY`로 적혔다 —
  --    **장부가 깨진 것을 "지금 바쁘다"로 분류**하면 원인을 못 찾는다.
  --
  --    그래서 단계를 숫자로 매겨(SPENT 0 · 활성 1 · FREE 2) 인덱스 순으로
  --    **줄어들지 않는지** 본다. 그것이 `validSlotOrder`와 같은 말이다.
  --    표에 별명을 붙이는 이유: RETURNS TABLE의 `slot_index`와 칸 이름이
  --    같아서, 별명을 빼면 plpgsql이 어느 쪽인지 모른다고 거절한다.
  WITH ranked AS (
    SELECT s.slot_index,
           CASE s.status WHEN 'SPENT' THEN 0 WHEN 'FREE' THEN 2 ELSE 1 END AS phase
      FROM public.ten_slot_slots AS s
     WHERE s.campaign_id = p_campaign_id
  ), stepped AS (
    SELECT r.slot_index, r.phase,
           r.phase >= COALESCE(lag(r.phase) OVER (ORDER BY r.slot_index), 0) AS ok
      FROM ranked AS r
  )
  SELECT count(*),
         count(*) FILTER (WHERE t.phase = 1),
         min(t.slot_index) FILTER (WHERE t.phase = 2),
         bool_and(t.ok)
    INTO v_slots, v_active, v_index, v_ordered
    FROM stepped AS t;

  IF v_slots <> 10 OR v_active > 1 OR NOT COALESCE(v_ordered, FALSE) THEN
    RETURN QUERY SELECT 'COUPLING_CORRUPT'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  -- ③ 의도 자체가 성립하는가
  --
  --   **모양부터 본다.** 예전에는 `client_order_id`와 `requested_lots`만
  --   봤고, 수량·배율·종목·방향·거래소·주문유형은 아무 검사 없이
  --   `live_orders`에 들어갔다. `012`에도 그 칸들의 CHECK가 없다. 그래서
  --   수량 -0.001, 배율 -1, 빈 종목, `side='HOLD'` 같은 입력이 **내구적으로
  --   예약**될 수 있었다 — 전송은 반드시 실패하는데 슬롯은 RESERVED로
  --   잡힌 채 남는다. 되돌릴 사람이 없으면 그 캠페인은 거기서 멈춘다.
  --
  --   여기서 보는 것은 **도메인**이다: 어디서도 유효할 수 없는 값.
  --   거래소별 LOT_SIZE·틱·최소 명목가·배율 한도는 **여기에 적지 않는다** —
  --   그 정본은 주문 실행기(`src/lib/engine/orderExecutor.ts`)이고, SQL에
  --   복제하면 같은 판단이 두 곳에 생겨 언젠가 한쪽만 바뀐다(074의 원칙).
  --   이 함수가 보장하는 것은 "거래소가 받아 줄 주문"이 아니라
  --   **"말이 되는 의도만 내구화한다"**이다.
  v_type   := COALESCE(p_order_type, 'MARKET');
  v_reduce := COALESCE(p_reduce_only, FALSE);

  IF p_client_order_id IS NULL OR length(btrim(p_client_order_id)) = 0
     -- **최소 길이를 실행기와 맞춘다.** `orderExecutor.ts`는 4자 미만을
     -- 거절한다. 여기서 1자를 받아 주면 예약은 되고 전송은 안 되는
     -- 조합이 만들어진다 — 슬롯만 잡힌 채 남는다.
     OR length(p_client_order_id) < 4
     OR length(p_client_order_id) > 128
     OR p_requested_lots IS NULL OR p_requested_lots <= 0
     -- NaN도 Infinity도 쓸 수 없는 수다. 판정은 한 곳에 있다.
     OR NOT public.ten_slot_finite_positive(p_quantity)
     OR p_symbol IS NULL OR length(btrim(p_symbol)) = 0 OR length(p_symbol) > 32
     OR p_side IS NULL OR p_side NOT IN ('BUY', 'SELL')
     OR p_exchange IS NULL OR p_exchange NOT IN ('binance', 'gate')
     OR v_type NOT IN ('MARKET', 'LIMIT')
     -- 배율은 진입에만 필요하다. 청산은 없을 수 있지만, **있는데 1 미만**은
     -- 어느 쪽이든 말이 안 된다 (실행기도 진입에서 `leverage >= 1`을 요구한다).
     OR (NOT v_reduce AND (p_leverage IS NULL OR p_leverage < 1))
     OR (p_leverage IS NOT NULL AND p_leverage < 1)
     -- 지정가인데 가격이 없으면 보내지 않는다. 여기서 시장가로 바꾸지 않는다 —
     -- 사용자가 지정가를 쓴 이유가 사라진다(실행기와 같은 판단).
     OR (v_type = 'LIMIT' AND NOT public.ten_slot_finite_positive(p_price))
     -- 시장가에 가격은 없어도 된다. **있는데 쓸 수 없는 수**면 거절한다.
     OR (p_price IS NOT NULL AND NOT public.ten_slot_finite_positive(p_price)) THEN
    RETURN QUERY SELECT 'INTENT_INVALID'::TEXT, NULL::INT, v_campaign.version, NULL::UUID;
    RETURN;
  END IF;

  -- ③-b **함께 적을 정책·계약·좌표가 말이 되는가.**
  --
  --   ③이 "거래소에 보낼 수 있는 모양"을 봤다면 여기서 보는 것은
  --   **"나중에 읽을 수 있는 기록인가"**다. 반쪽 기록은 읽는 쪽을 추측하게
  --   만들고, 추측하는 자리가 곧 틀리는 자리다.
  --
  --   공백만 있는 값은 **값이 아니다.** `''`나 `'   '`를 그대로 적으면
  --   090의 CHECK는 "있다"로 읽고 읽는 쪽은 "빈 계약"을 보게 된다.
  --   비울 것은 NULL로 비운다.
  v_policy  := NULLIF(btrim(COALESCE(p_stop_policy, '')), '');
  v_profile := NULLIF(btrim(COALESCE(p_execution_profile_id, '')), '');
  v_preset  := NULLIF(btrim(COALESCE(p_execution_preset_id, '')), '');

  IF
     -- 넘겼는데 공백뿐이면 조용히 NULL로 바꾸지 않는다. 호출부가 무엇을
     -- 의도했는지 알 수 없으므로 거절한다.
     (p_stop_policy IS NOT NULL AND v_policy IS NULL)
     -- 078의 CHECK와 같은 집합이다. 제약에 걸리면 **예외**가 나므로 호출부는
     -- 이유를 코드로 받지 못한다. 그래서 여기서 코드로 거절하고, 제약은
     -- 마지막 그물로 남긴다.
     OR (v_policy IS NOT NULL AND v_policy NOT IN ('FIXED_SL', 'NO_FIXED_SL'))
     -- **모순은 조용히 정리하지 않는다.** 고정 손절을 쓰지 않는 정책인데
     -- 손절가가 함께 왔다면 둘 중 하나가 틀린 것이고 어느 쪽인지 여기서는
     -- 알 수 없다. 손절을 버리면 화면에는 손절이 있고 거래소에는 없다.
     -- (`orderExecutor.ts`가 전송 경계에서 내리는 것과 같은 판단이다.)
     OR (v_policy = 'NO_FIXED_SL' AND p_stop_loss IS NOT NULL)
     -- 가격은 가격이다. 0·음수·NaN·Infinity는 어느 거래소에서도 손절가가
     -- 될 수 없다. 판정은 ③과 같은 함수 한 곳에 있다.
     OR (p_stop_loss IS NOT NULL AND NOT public.ten_slot_finite_positive(p_stop_loss))
     OR (p_take_profit IS NOT NULL AND NOT public.ten_slot_finite_positive(p_take_profit))
     -- ── 실행 계약 세 칸은 전부 있거나 전부 없다 ──
     --
     --   `resolveExecutionProfile`의 `INCOMPLETE_SELECTION`, 090의
     --   `live_orders_execution_identity_complete`, 그리고 실행기의
     --   "반쪽은 받지 않는다"와 같은 선이다.
     --
     --   짝 규칙(`MAX_LEV_100X`는 `EXACT_100X`와만)은 **여기에 적지 않는다.**
     --   그 표의 정본은 `src/lib/execution/profile.ts`이고, SQL에 베끼면
     --   같은 판단이 두 곳에 생겨 언젠가 한쪽만 바뀐다(074·CLAUDE.md).
     OR (v_profile IS NULL) <> (v_preset IS NULL)
     OR (v_profile IS NULL) <> (p_execution_contract_version IS NULL)
     OR (p_execution_profile_id IS NOT NULL AND v_profile IS NULL)
     OR (p_execution_preset_id IS NOT NULL AND v_preset IS NULL)
     -- 버전 0·음수는 계약 버전이 될 수 없다. 077·090이 숫자 범위를 제약으로
     -- 걸지 않았으므로 **여기서 막지 않으면 그대로 쌓인다.**
     OR (p_execution_contract_version IS NOT NULL AND p_execution_contract_version < 1)
     -- ── 진입 위험 좌표 (091) ──
     --
     --   091은 일부러 CHECK를 걸지 않았다 — 두 값은 서로 독립이고 한쪽만
     --   구해지는 상황이 실제로 있다. 그래서 **반쪽을 받는다.** 다만 있는
     --   값이 쓸 수 없는 수면 거절한다. 특히 0을 받으면 안 된다: 위험 거리
     --   0은 "어떤 청산여유든 통과"로 읽힌다(091 주석의 그 숫자다).
     OR (p_entry_adverse_distance_pct IS NOT NULL
         AND NOT public.ten_slot_finite_positive_f8(p_entry_adverse_distance_pct))
     OR (p_entry_liquidation_distance_pct_raw IS NOT NULL
         AND NOT public.ten_slot_finite_positive_f8(p_entry_liquidation_distance_pct_raw))
  THEN
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
    quantity, price, leverage, reduce_only, status,
    -- **검사한 것을 그대로 적는다.** ③-b가 본 값과 다른 값을 적으면
    -- 그 검사는 아무것도 보장하지 않는다.
    stop_loss, take_profit, stop_policy,
    execution_profile_id, execution_preset_id, execution_contract_version,
    entry_adverse_distance_pct, entry_liquidation_distance_pct_raw
  ) VALUES (
    p_client_order_id, p_signal_id, v_campaign.user_id, v_campaign.connection_id,
    -- **캠페인에서 끌어낸 값을 적는다.** 호출자가 넘긴 p_mode가 아니다.
    -- 주문유형·청산여부는 ③에서 **검사한 그 값**을 쓴다 — 검사한 것과
    -- 적는 것이 다르면 검사는 아무것도 보장하지 않는다.
    p_exchange, v_mode, p_symbol, p_side, v_type,
    p_quantity, p_price, p_leverage, v_reduce, 'INTENT',
    p_stop_loss, p_take_profit, v_policy,
    v_profile, v_preset, p_execution_contract_version,
    p_entry_adverse_distance_pct, p_entry_liquidation_distance_pct_raw
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
REVOKE ALL ON FUNCTION public.ten_slot_finite_positive(NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_finite_positive(NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_finite_positive_f8(DOUBLE PRECISION) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_finite_positive_f8(DOUBLE PRECISION) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_identity_verdict(
  public.ten_slot_campaigns, UUID, UUID, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_identity_verdict(
  public.ten_slot_campaigns, UUID, UUID, TEXT, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_open_campaign(TEXT, UUID, UUID, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_open_campaign(TEXT, UUID, UUID, TEXT, NUMERIC) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_claim(
  TEXT, BIGINT, TEXT, INT, INT, INT, INT,
  TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT, BOOLEAN, TEXT,
  NUMERIC, NUMERIC, TEXT, TEXT, TEXT, INT, DOUBLE PRECISION, DOUBLE PRECISION
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_claim(
  TEXT, BIGINT, TEXT, INT, INT, INT, INT,
  TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT, BOOLEAN, TEXT,
  NUMERIC, NUMERIC, TEXT, TEXT, TEXT, INT, DOUBLE PRECISION, DOUBLE PRECISION
) TO service_role;

REVOKE ALL ON FUNCTION public.ten_slot_kill(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ten_slot_kill(TEXT) TO service_role;

COMMENT ON FUNCTION public.ten_slot_claim(
  TEXT, BIGINT, TEXT, INT, INT, INT, INT,
  TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, INT, BOOLEAN, TEXT,
  NUMERIC, NUMERIC, TEXT, TEXT, TEXT, INT, DOUBLE PRECISION, DOUBLE PRECISION
) IS
  '10슬롯 예약과 live_orders INTENT를 한 트랜잭션으로 적는다. 거래소 요청은 '
  '이 안에 없다. 확인하지 못한 노출은 0으로 적지 않고 EXPOSURE_UNKNOWN으로 막는다. '
  '장부에 적는 mode는 캠페인 환경에서 끌어낸다 — 호출자가 넘긴 값이 아니다. '
  '손절 정책·실행 계약 세 칸·진입 위험 좌표 두 칸도 같은 줄에 적는다 — '
  '계약 세 칸은 반쪽을 받지 않고(INTENT_INVALID), NO_FIXED_SL과 손절가가 '
  '함께 오면 모순으로 거절한다. NULL은 기록 없음이며 0이 아니다.';
COMMENT ON FUNCTION public.ten_slot_open_campaign(TEXT, UUID, UUID, TEXT, NUMERIC) IS
  '캠페인 줄과 슬롯 10줄을 한 트랜잭션으로 만든다. 이미 있으면 정체성'
  '(주인·연결·환경·시작 자본)을 대조해 같을 때만 ALREADY_OPEN이다 — '
  '다르면 CAMPAIGN_IDENTITY_MISMATCH로 막는다. 동시 개설도 예외가 아니라 '
  '같은 판정으로 끝난다.';
COMMENT ON INDEX ten_slot_active_one IS
  '캠페인당 활성 슬롯은 하나뿐이다 — 응용 코드가 FOR UPDATE를 빼먹어도 DB가 거절한다.';
