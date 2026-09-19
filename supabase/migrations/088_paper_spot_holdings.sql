-- 088_paper_spot_holdings.sql
--
-- **현물 보유분을 나눠서 팔 수 있게 한다.**
--
-- 지금까지 PAPER의 현물은 자산이 아니라 **배율 1짜리 파생 포지션**이었다.
-- 매수대금은 잔고에서 빠지지 않고 `SUM(margin)`으로만 잠기며, 파는 방법은
-- 포지션 한 줄을 통째로 닫는 것뿐이었다. 그래서 사는 화면은 있는데
-- "100주 중 30주만 판다"가 없었다.
--
-- 왜 이 파일이 새 번호인가
-- ────────────────────────
-- `086`의 `paper_settle_close`가 바뀌지만 **`086` 파일은 한 글자도 고치지
-- 않는다.** 이미 production에 적용된 마이그레이션의 과거 기록을 고치면
-- replay와 실제 이력이 갈린다. 바뀌는 함수는 전부 여기서
-- `CREATE OR REPLACE`로 덮는다.
--
-- ══════ 이 파일이 지키는 계약 ══════
--
-- ① 원 체결 증거와 남은 상태를 **다른 칸**에 둔다
--
--      entry_fee                    진입 때 실제로 잔고에서 빠진 금액.
--                                   **과거 사건이다 — 영원히 안 바뀐다.**
--      open_quantity/notional/margin 원 체결 증거 (새 칸)
--      quantity/notional/margin      지금 남은 상태
--      remaining_entry_fee_basis     지금 남은 원가 귀속분 (새 칸)
--
--    진입 수수료를 "남은 값"으로 깎으면 안 된다. 부분매도를 했다고 과거에
--    낸 수수료가 줄어드는 것이 아니다. 그런데 청산 손익을 낼 때는 **이
--    조각에 귀속될 몫**이 필요하다. 두 뜻을 한 칸에 담으면 마지막 조각에서
--    이미 귀속된 몫을 다시 뺀다 — 실측으로 0.13125만큼 어긋났다.
--    그래서 칸을 나눈다.
--
--    불변 칸은 **트리거가 지킨다.** 코드 규율은 운영 수리·수동 UPDATE·
--    앞으로 생길 경로를 지나가지 않는다 (`086`의 원장 시각 동결과 같은 장치).
--
-- ② 매도 사건에 **고유한 신원**을 준다
--
--    챌린지 원장의 멱등키는 `(challenge_id, cashflow_type, source_event_type,
--    source_event_id)`다. 부분매도를 `POSITION_CLOSE`/`position_id`로 적으면
--    **두 번째 매도가 첫 번째와 키가 같아져 `ON CONFLICT DO NOTHING`에 걸린다.**
--    행도 안 생기고 잔고도 안 움직이고 오류도 안 난다 — 실현이익이 조용히
--    사라진다.
--
--    그래서 매도마다 `paper_sell_events` 한 줄을 만들고 그 id로 적는다.
--    `POSITION_SELL`/`sell_id`는 구조적으로 충돌할 수 없다.
--    **기존 `POSITION_CLOSE`/`position_id` 이력은 읽지도 쓰지도 않는다.**
--
-- ③ 재시도와 새 매도를 구별한다
--
--    클라이언트가 `client_sell_id`를 만들고 재시도 때 **그대로** 보낸다.
--      같은 id + 같은 내용 → REPLAYED (저장된 답을 그대로 돌려준다)
--      같은 id + 다른 내용 → CONFLICT (아무것도 안 움직인다)
--    유니크가 `(paper_account_id, client_sell_id)`이고 **계좌는 요청 본문에서
--    오지 않는다** — 서버가 정한다. 남의 계좌에 닿을 문자열이 없다.
--
-- ④ 금액은 **전부 SQL이 만든다**
--
--    `computeClose`(JS)가 계산해 넘기는 구조를 복제하지 않는다. 실측에서
--    double은 25%+25%+100%와 100% 1회가 -7.1e-15만큼 달랐다. NUMERIC은
--    곱셈·뺄셈이 정확하므로, **나눗셈 결과가 총합에 들어가지 않게** 짜면
--    등가가 정확히 성립한다.
--
--      · 마지막 조각은 `percent = 100` → 남은 전부. **나눗셈 0회**
--      · 여러 lot 배분은 비례 FLOOR + 잔여 흡수 → `Σtake = sold` 정확
--
-- ⑤ 원장 모델은 **그대로**다
--
--      REALIZED_PNL = gross (수수료 차감 전)
--      TRADING_FEE  = -exit_fee (음수)
--
--    순액 한 줄로 적으면 수수료가 두 번 빠진다 — `085`가 적어 둔 그대로다.
--    진입 수수료는 `POSITION_OPEN`에서 이미 정확히 한 번 적혔다.
--    불변식 `balance = SUM(cashflows.amount)`는 깨지지 않는다.
--
-- ⑥ 반환 칸 이름에 `out_` 접두사를 붙인다
--
--    `084`가 고친 고장이 "반환 칸 이름이 표의 칸 이름과 겹쳐 **실행 시점에**
--    42702"였다. 이 함수는 `status`·`quantity`·`gross_pnl`·`exit_fee`·
--    `realized_pnl`을 전부 다루므로 그대로 두면 거의 확실히 밟는다.
--    겹칠 수 없는 이름으로 아예 피한다.
--
-- 운영 규칙
-- ─────────
-- 현물만이다. 선물(USDM) 경로는 한 줄도 바뀌지 않는다.
-- `/api/paper/close`의 계약(`paper_settle_close`)도 금액·잠금·멱등이 그대로고,
-- 바뀌는 것은 **승패 판정이 부분매도 이력을 포함하는가** 하나다.

-- ══════════════════ ① 배분 눈금 — 한 곳에 둔다 ══════════════════
--
-- 비례 배분에서 내림할 자리. 두 곳에 적으면 언젠가 갈린다.
CREATE OR REPLACE FUNCTION public.paper_alloc_scale()
RETURNS INT LANGUAGE sql IMMUTABLE AS $$ SELECT 18 $$;

COMMENT ON FUNCTION public.paper_alloc_scale() IS
  '비례 배분에서 내림하는 소수 자리. 이 값이 커지고 작아져도 총합은 잔여 흡수가 맞춘다.';

-- **내림이다. 반올림이 아니다.**
-- 반올림하면 배분 합이 매도 수량을 **넘을 수 있고**, 그러면 마지막 줄이
-- 가진 것보다 많이 팔린다. 내림은 항상 모자라고, 모자란 만큼은 아래의
-- 잔여 흡수가 여유 있는 줄에 채운다 — 넘치는 쪽으로는 절대 안 간다.
CREATE OR REPLACE FUNCTION public.paper_floor_at(p_value NUMERIC, p_scale INT)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_f NUMERIC;
BEGIN
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'paper_floor_at: 값이 없습니다 — 0으로 적지 않습니다';
  END IF;
  IF p_value < 0 THEN
    RAISE EXCEPTION 'paper_floor_at: 음수는 받지 않습니다 (%)', p_value;
  END IF;
  v_f := power(10::NUMERIC, p_scale);
  RETURN FLOOR(p_value * v_f) / v_f;
END $$;

COMMENT ON FUNCTION public.paper_floor_at(NUMERIC, INT) IS
  '비례 배분 전용 내림. 배분 합이 매도 수량을 넘지 않게 하는 것이 유일한 목적이다.';

-- ══════════════════ ② 원 체결 증거 칸 ══════════════════
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS open_quantity NUMERIC;
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS open_notional NUMERIC;
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS open_margin NUMERIC;
-- 남은 원가 귀속분. `entry_fee`(과거 사건)와 **다른 칸**이다.
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS remaining_entry_fee_basis NUMERIC;

COMMENT ON COLUMN public.paper_positions.open_quantity IS
  '원 체결 수량. 불변 — 트리거가 지킨다. 지금 남은 수량은 quantity다.';
COMMENT ON COLUMN public.paper_positions.open_notional IS
  '원 체결 명목가치. 불변. 지금 남은 명목은 notional이다.';
COMMENT ON COLUMN public.paper_positions.open_margin IS
  '원 체결 증거금. 불변. 지금 잠겨 있는 증거금은 margin이다.';
COMMENT ON COLUMN public.paper_positions.remaining_entry_fee_basis IS
  '남은 원가에 귀속될 진입 수수료. entry_fee는 실제로 낸 과거 금액이라 '
  '안 줄고, 이 칸이 줄어든다. 둘을 한 칸에 담으면 수수료가 두 번 빠진다.';

-- ══════════════════ ③ 불변 칸은 DB가 지킨다 ══════════════════
--
-- **backfill보다 먼저 세운다.** 아래 채우기가 이 트리거를 지나가기 때문이다.
--
-- `086`의 원장 시각 동결과 같은 장치다. 행 단위 CHECK는 이전 값을 볼 수
-- 없으므로, 이전 값을 볼 수 있는 유일한 자리인 BEFORE UPDATE로 막는다.
CREATE OR REPLACE FUNCTION public.paper_positions_freeze_open_cols()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- ★ **한 번 적힌 뒤로 안 바뀐다** — 아직 안 적힌 것을 적는 것은 막지 않는다.
  --
  --   `IS DISTINCT FROM`만 보면 **backfill이 자기 트리거에 막힌다.**
  --   이 파일을 두 번째로 세울 때가 그렇다: 그 사이에 옛 버전
  --   `paper_open_position`(086 이하)이 만든 줄은 `open_*`가 NULL이고,
  --   위쪽 backfill이 그것을 채우려는 순간 `NULL → 값`이 "증거 변경"으로
  --   읽혀 거부된다. 재생·뮤테이션 하네스가 정확히 그 상태를 만든다.
  --
  --   비어 있던 칸을 처음 채우는 것은 증거를 **고치는** 것이 아니다.
  --   그래서 옛 값이 있을 때만 잠근다. (`entry_fee`·`fill_price`·`leverage`·
  --   `market`·`side`는 스키마가 NOT NULL이라 이 분기를 타지 않는다 — 그래도
  --   같은 규칙으로 적는다. 규칙이 칸마다 다르면 언젠가 갈린다.)
  IF (OLD.entry_fee     IS NOT NULL AND NEW.entry_fee     IS DISTINCT FROM OLD.entry_fee)
  OR (OLD.open_quantity IS NOT NULL AND NEW.open_quantity IS DISTINCT FROM OLD.open_quantity)
  OR (OLD.open_notional IS NOT NULL AND NEW.open_notional IS DISTINCT FROM OLD.open_notional)
  OR (OLD.open_margin   IS NOT NULL AND NEW.open_margin   IS DISTINCT FROM OLD.open_margin)
  OR (OLD.fill_price    IS NOT NULL AND NEW.fill_price    IS DISTINCT FROM OLD.fill_price)
  OR (OLD.leverage      IS NOT NULL AND NEW.leverage      IS DISTINCT FROM OLD.leverage)
  OR (OLD.market        IS NOT NULL AND NEW.market        IS DISTINCT FROM OLD.market)
  OR (OLD.side          IS NOT NULL AND NEW.side          IS DISTINCT FROM OLD.side)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '원 체결 증거는 바꿀 수 없습니다 (포지션 ' || OLD.id::TEXT || ')',
      HINT    = '남은 수량·명목·증거금은 quantity/notional/margin, '
                || '남은 수수료 귀속은 remaining_entry_fee_basis입니다';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.paper_positions_freeze_open_cols() IS
  '원 체결 증거 칸을 처음 적힌 값으로 고정한다. 회계를 하지 않는다.';

DROP TRIGGER IF EXISTS paper_positions_freeze_open_trg ON public.paper_positions;
CREATE TRIGGER paper_positions_freeze_open_trg
  BEFORE UPDATE ON public.paper_positions
  FOR EACH ROW
  EXECUTE FUNCTION public.paper_positions_freeze_open_cols();

-- 기존 줄 backfill.
--
-- **트리거를 먼저 세우고 여기서 채운다.** 순서를 반대로 두면 이 파일을 두 번째
-- 세울 때 **옛 트리거 함수가 살아 있는 채로** backfill이 돌고, `NULL → 값`이
-- 증거 변경으로 읽혀 거부된다. 위의 고친 함수가 먼저 깔려 있어야 한다.
--
-- 부분매도된 적 없는 줄이므로 원본과 남은 값이 같다 — 값을 지어내지 않는다.
UPDATE public.paper_positions
   SET open_quantity = quantity
 WHERE open_quantity IS NULL;
UPDATE public.paper_positions
   SET open_notional = notional
 WHERE open_notional IS NULL;
UPDATE public.paper_positions
   SET open_margin = margin
 WHERE open_margin IS NULL;
UPDATE public.paper_positions
   SET remaining_entry_fee_basis = entry_fee
 WHERE remaining_entry_fee_basis IS NULL;

-- ══════════════════ ④ 매도 사건 ══════════════════
CREATE TABLE IF NOT EXISTS public.paper_sell_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_account_id    UUID NOT NULL,
  user_id             UUID NOT NULL,

  -- 클라이언트가 만들고 재시도 때 그대로 보낸다.
  client_sell_id      TEXT NOT NULL,
  -- 같은 id로 **다른 것**을 팔려는 시도를 잡는다. 조용한 재생 금지.
  request_fingerprint TEXT NOT NULL,

  market              TEXT NOT NULL,
  symbol              TEXT NOT NULL,
  exit_price          NUMERIC NOT NULL,
  fee_rate            NUMERIC NOT NULL,

  sold_quantity       NUMERIC NOT NULL,
  gross_pnl           NUMERIC NOT NULL,
  exit_fee            NUMERIC NOT NULL,
  realized_pnl        NUMERIC NOT NULL,
  remaining_quantity  NUMERIC NOT NULL,
  lots_touched        INT     NOT NULL,

  -- ★ **DEFAULT 없음.** 부르는 쪽이 반드시 넣는다 (`083` 머리말과 같은 규칙).
  event_effective_at  TIMESTAMPTZ NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.paper_sell_event_lots (
  sell_id             UUID NOT NULL,
  position_id         UUID NOT NULL,
  taken_quantity      NUMERIC NOT NULL,
  taken_notional      NUMERIC NOT NULL,
  taken_margin        NUMERIC NOT NULL,
  -- 이 매도에 귀속된 진입 수수료 몫. 합이 원래 entry_fee가 된다.
  allocated_entry_fee_basis NUMERIC NOT NULL,
  lot_gross_pnl       NUMERIC NOT NULL,
  lot_exit_fee        NUMERIC NOT NULL,
  lot_realized_pnl    NUMERIC NOT NULL,
  PRIMARY KEY (sell_id, position_id)
);

DO $$
BEGIN
  -- ★ **멱등의 정본.** 계좌가 키에 들어 있어서 남의 계좌와 충돌할 수 없다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_sell_events_idem_key') THEN
    ALTER TABLE public.paper_sell_events
      ADD CONSTRAINT paper_sell_events_idem_key
      UNIQUE (paper_account_id, client_sell_id);
  END IF;

  -- 소유권은 DB가 본다 (`083`이 원장에 한 것과 같다).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_sell_events_account_owner_fk') THEN
    ALTER TABLE public.paper_sell_events
      ADD CONSTRAINT paper_sell_events_account_owner_fk
      FOREIGN KEY (paper_account_id, user_id)
      REFERENCES public.paper_accounts (id, user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_sell_event_lots_sell_fk') THEN
    ALTER TABLE public.paper_sell_event_lots
      ADD CONSTRAINT paper_sell_event_lots_sell_fk
      FOREIGN KEY (sell_id) REFERENCES public.paper_sell_events (id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_sell_event_lots_position_fk') THEN
    ALTER TABLE public.paper_sell_event_lots
      ADD CONSTRAINT paper_sell_event_lots_position_fk
      FOREIGN KEY (position_id) REFERENCES public.paper_positions (id);
  END IF;

  -- 판 수량은 0보다 크다. 0을 판 사건은 사건이 아니다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_sell_events_qty_positive') THEN
    ALTER TABLE public.paper_sell_events
      ADD CONSTRAINT paper_sell_events_qty_positive CHECK (sold_quantity > 0);
  END IF;

  -- 청산 수수료는 음수가 될 수 없다 (원장에는 음수로 들어간다).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_sell_events_fee_sign') THEN
    ALTER TABLE public.paper_sell_events
      ADD CONSTRAINT paper_sell_events_fee_sign CHECK (exit_fee >= 0);
  END IF;

  -- ★ 원장의 사건 종류에 `POSITION_SELL`을 더한다.
  --
  --   `083`의 목록은 닫힌 집합이고 **그게 맞다** — 모르는 종류가 원장에
  --   들어오면 그 줄이 무엇인지 아무도 모른다. 새 종류가 생겼으니 목록을
  --   넓힌다. 제약을 지우고 **바로 다시 만든다**: 지운 채로 두면 그 사이에
  --   무엇이든 들어올 수 있고, 그건 목록이 없는 것과 같다.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_source_chk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      DROP CONSTRAINT paper_challenge_cashflows_source_chk;
  END IF;
  ALTER TABLE public.paper_challenge_cashflows
    ADD CONSTRAINT paper_challenge_cashflows_source_chk
    CHECK (source_event_type IN
           ('CHALLENGE_CREATE', 'POSITION_OPEN', 'POSITION_CLOSE',
            'FUNDING_ACCRUAL', 'POSITION_SELL'));
END $$;

CREATE INDEX IF NOT EXISTS paper_sell_events_account_idx
  ON public.paper_sell_events (paper_account_id, event_effective_at DESC);
CREATE INDEX IF NOT EXISTS paper_sell_event_lots_position_idx
  ON public.paper_sell_event_lots (position_id);
-- 보유 집계가 보는 축.
CREATE INDEX IF NOT EXISTS paper_pos_holdings_idx
  ON public.paper_positions (paper_account_id, market, symbol, status);

ALTER TABLE public.paper_sell_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_sell_event_lots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_sell_events_service ON public.paper_sell_events;
CREATE POLICY paper_sell_events_service ON public.paper_sell_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS paper_sell_events_owner ON public.paper_sell_events;
CREATE POLICY paper_sell_events_owner ON public.paper_sell_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS paper_sell_event_lots_service ON public.paper_sell_event_lots;
CREATE POLICY paper_sell_event_lots_service ON public.paper_sell_event_lots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.paper_sell_events IS
  '현물 보유분 매도 한 건. 이 줄의 id가 챌린지 원장의 source_event_id가 된다 — '
  'position_id를 재사용하면 같은 포지션의 두 번째 매도가 멱등키에 걸려 사라진다.';
COMMENT ON TABLE public.paper_sell_event_lots IS
  '한 매도가 어느 lot에서 얼마를 뺐는가. lot의 누적 실현손익이 여기서 나온다 — '
  '누적을 칸으로 또 들고 있으면 돈의 정본이 둘이 된다.';

-- ══════════════════ ⑤ 진입 — 원 체결 증거를 함께 적는다 ══════════════════
--
-- `086`의 정의를 그대로 가져와 INSERT 칸만 늘렸다. **시그니처·잠금·멱등·
-- 판정은 한 글자도 바꾸지 않았다.** `086` 파일 자체는 손대지 않는다.
CREATE OR REPLACE FUNCTION public.paper_open_position(
  p_user_id            UUID,
  p_signal_id          TEXT,
  p_strategy_id        TEXT,
  p_bucket             TEXT,
  p_symbol             TEXT,
  p_market             TEXT,
  p_side               TEXT,
  p_entry_price        NUMERIC,
  p_fill_price         NUMERIC,
  p_quantity           NUMERIC,
  p_notional           NUMERIC,
  p_leverage           INT,
  p_margin             NUMERIC,
  p_stop_loss          NUMERIC,
  p_take_profit        NUMERIC,
  p_liquidation_price  NUMERIC,
  p_entry_fee          NUMERIC,
  p_margin_mode        TEXT,
  p_event_effective_at TIMESTAMPTZ,
  p_paper_account_id   UUID DEFAULT NULL
)
RETURNS TABLE (
  status      TEXT,      -- OPENED | DUPLICATE | NO_ACCOUNT | INSUFFICIENT_MARGIN
                         -- | CHALLENGE_NOT_RUNNING
  position_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account    UUID;
  v_balance    NUMERIC;
  v_used       NUMERIC;
  v_existing   UUID;
  v_id         UUID;
  v_challenge  UUID;
  v_ch_status  TEXT;
  v_constraint TEXT;
BEGIN
  -- **돈에 닿기 전에 거부한다.**
  IF p_event_effective_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22004',
      MESSAGE = 'paper_open_position: 사건 시각이 없습니다 — 아무것도 만들지 않습니다';
  END IF;
  IF p_entry_fee IS NULL OR p_entry_fee < 0 THEN
    RAISE EXCEPTION 'paper_open_position: 진입 수수료가 음수이거나 없습니다 (%)', p_entry_fee;
  END IF;
  IF p_margin IS NULL OR p_margin < 0 THEN
    RAISE EXCEPTION 'paper_open_position: 필요 증거금이 음수이거나 없습니다 (%)', p_margin;
  END IF;

  -- ① 계좌를 잠근다. 없으면 여기서 끝 — 만들지 않는다.
  --    **소유자까지 함께 본다.** 남의 계좌 id를 넣어도 여기서 안 잡힌다.
  SELECT a.id, a.balance INTO v_account, v_balance
    FROM public.paper_accounts a
   WHERE a.user_id = p_user_id
     AND (CASE WHEN p_paper_account_id IS NULL THEN a.is_default
               ELSE a.id = p_paper_account_id END)
     FOR UPDATE;

  IF v_account IS NULL THEN
    RETURN QUERY SELECT 'NO_ACCOUNT'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- ② 챌린지를 같은 방향으로 잠근다 (계좌 → 챌린지). 상태도 같이 읽는다.
  SELECT c.id, c.status INTO v_challenge, v_ch_status
    FROM public.paper_challenges c
   WHERE c.paper_account_id = v_account
     FOR UPDATE;

  -- ②-a **챌린지 계좌는 RUNNING에서만 주문을 받는다.**
  --
  --    CLOSING/CLOSED만 막으면 부족하다. READY는 아직 시작 시각 전이고,
  --    그때 열린 포지션은 아무도 고르지 않은 기간에 생긴 것이다. 그래서
  --    **RUNNING이 아니면 전부 거부한다**(fail-closed). 상태가 하나 늘어도
  --    기본이 거부이므로 조용히 열리지 않는다.
  --
  --    챌린지 계좌가 아니면(v_challenge IS NULL) 지금까지의 동작 그대로다.
  IF v_challenge IS NOT NULL AND v_ch_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN QUERY SELECT 'CHALLENGE_NOT_RUNNING'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- ②-b **사건 시각 신선도 — 잠금을 전부 잡은 뒤에 본다.**
  --
  --    잠금 전에 보면 잠금을 기다리는 동안 시각이 낡고, 그 낡은 사건이
  --    만료 뒤에 들어와 판정을 뒤집는다. 잠금을 다 잡은 뒤 실제 현재시각과
  --    비교해야 만료와 같은 직렬화 안에서 비교된다.
  IF v_challenge IS NOT NULL THEN
    PERFORM public.paper_event_time_guard(p_event_effective_at);
  END IF;

  -- ③ 같은 신호는 한 번만. 잠금을 쥔 채로 보므로 동시 호출도 한쪽만 넣는다.
  --    **용량 검사보다 앞이다** — 이미 성공한 신호의 재시도는 그 사이 잔고가
  --    줄었더라도 DUPLICATE여야 한다.
  IF p_signal_id IS NOT NULL THEN
    SELECT pp.id INTO v_existing
      FROM public.paper_positions pp
     WHERE pp.signal_id = p_signal_id
     LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY SELECT 'DUPLICATE'::TEXT, v_existing;
      RETURN;
    END IF;
  END IF;

  -- ④ 가용 증거금 — **잠근 상태에서 보는 이 값이 최종이다.**
  --    그 계좌의 포지션만 센다. 사용자 전체로 세면 챌린지 계좌의 증거금이
  --    기본 계좌 용량을 깎는다 — 계좌를 나눈 이유가 사라진다.
  --    **칸을 표 이름으로 한정한다.** 이 함수의 반환 칸 이름이 `status`라서
  --    한정하지 않으면 plpgsql이 어느 쪽인지 모른다고 거부한다(42702) —
  --    `075`부터 이 자리가 그랬고, 계획 시점이 아니라 **실행 시점**에 터져서
  --    아무 검사기도 잡지 못했다.
  SELECT COALESCE(SUM(pp.margin), 0) INTO v_used
    FROM public.paper_positions pp
   WHERE pp.user_id = p_user_id
     AND pp.paper_account_id = v_account
     AND pp.status = 'open';

  IF v_used + p_margin + p_entry_fee > v_balance THEN
    RETURN QUERY SELECT 'INSUFFICIENT_MARGIN'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- ⑤ 포지션. **자기 계좌를 들고 태어난다.**
  INSERT INTO public.paper_positions (
    user_id, paper_account_id, signal_id, strategy_id, bucket, symbol, market,
    side, status, entry_price, fill_price, quantity, notional, leverage, margin,
    stop_loss, take_profit, liquidation_price, entry_fee, margin_mode,
    -- ★ 088: 원 체결 증거와 남은 원가 귀속을 태어날 때 함께 적는다.
    --    나중에 채우면 그 사이에 열린 줄이 증거 없이 남는다.
    open_quantity, open_notional, open_margin, remaining_entry_fee_basis
  ) VALUES (
    p_user_id, v_account, p_signal_id, p_strategy_id, p_bucket, p_symbol,
    COALESCE(p_market, 'USDM'), p_side, 'open',
    p_entry_price, p_fill_price, p_quantity, p_notional, p_leverage, p_margin,
    p_stop_loss, p_take_profit, p_liquidation_price, p_entry_fee,
    COALESCE(p_margin_mode, 'ISOLATED'),
    p_quantity, p_notional, p_margin, p_entry_fee
  )
  RETURNING id INTO v_id;

  -- ⑥ 수수료. **음수로 적는다** — 원장 합계가 곧 잔고다.
  IF NOT public.paper_money_apply(
      v_account, p_user_id, 'TRADING_FEE', -p_entry_fee,
      'POSITION_OPEN', v_id::TEXT, p_event_effective_at) THEN
    RAISE EXCEPTION
      'paper_open_position: 이 포지션의 진입 수수료가 이미 적혀 있습니다 (%) — 되돌립니다', v_id;
  END IF;

  -- ⑦ 통계. 돈이 아니라 집계다 — 원장에 적지 않는다.
  UPDATE public.paper_accounts
     SET total_fees = total_fees + p_entry_fee
   WHERE id = v_account;

  -- ⑧ 판정. **진입 수수료도 실현 잔고를 움직인다.**
  --
  --    청산에만 판정을 두면 수수료가 실패선을 넘긴 계좌는 다음 청산까지
  --    실패선 아래에서 계속 달린다. 청산과 **같은 함수**를 부른다.
  --    (진입에서 잔고는 줄기만 하므로 여기서 달성이 나올 일은 없다. 그래도
  --    경로를 나누지 않는다 — 나누면 언젠가 한쪽만 고친다.)
  PERFORM public.paper_challenge_judge(
    v_challenge, v_account, p_user_id, p_event_effective_at);

  RETURN QUERY SELECT 'OPENED'::TEXT, v_id;

EXCEPTION
  WHEN unique_violation THEN
    -- **signal_id 충돌만 멱등 중복이다.** 다른 유니크 위반은 삼키지 않는다.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

    IF p_signal_id IS NOT NULL AND v_constraint = 'paper_pos_signal_uniq' THEN
      SELECT pp.id INTO v_existing
        FROM public.paper_positions pp
       WHERE pp.signal_id = p_signal_id
       LIMIT 1;
      RETURN QUERY SELECT 'DUPLICATE'::TEXT, v_existing;
      RETURN;
    END IF;
    RAISE;
END;
$$;

-- ══════════════════ ⑥ 청산 — 승패만 lot 일생으로 본다 ══════════════════
--
-- 이것도 `086`의 정의 그대로다. 바뀐 것은 `win_count` 한 줄뿐이고
-- 잔고·원장·멱등·잠금·trade_count는 그대로다.
CREATE OR REPLACE FUNCTION public.paper_settle_close(
  p_position_id        UUID,
  p_exit_price         NUMERIC,
  p_exit_reason        TEXT,
  p_exit_fee           NUMERIC,
  p_gross_pnl          NUMERIC,
  p_realized_pnl       NUMERIC,
  p_pnl_pct            NUMERIC,
  p_event_effective_at TIMESTAMPTZ
)
RETURNS TABLE (
  settled          BOOLEAN,
  owner_id         UUID,
  settled_pnl      NUMERIC,
  settled_pnl_pct  NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner     UUID;
  v_account   UUID;
  v_locked    UUID;
  v_challenge UUID;
  v_hit       UUID;
  v_prior     NUMERIC;
BEGIN
  -- **돈에 닿기 전에 거부한다.**
  IF p_event_effective_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22004',
      MESSAGE = 'paper_settle_close: 사건 시각이 없습니다 — 포지션도 닫지 않습니다';
  END IF;

  -- ① 잠그지 않고 읽는다 — 어느 계좌를 잠글지 알기 위해서만.
  SELECT pp.user_id, pp.paper_account_id INTO v_owner, v_account
    FROM public.paper_positions pp
   WHERE pp.id = p_position_id AND pp.status = 'open';

  IF v_owner IS NULL THEN
    -- 없거나 이미 닫혔다. **아무것도 잠그지 않았고 아무것도 안 바뀌었다.**
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- 계좌를 안 들고 있는 옛 줄은 그 사용자의 기본 계좌로 간다 (`081` 이전).
  IF v_account IS NULL THEN
    v_account := public.paper_default_account_id(v_owner);
  END IF;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'paper_settle_close: 정산할 계좌를 정하지 못했습니다 (포지션 %)', p_position_id;
  END IF;

  -- ② 계좌를 잠근다. 이 계좌의 모든 돈 경로가 만나는 한 점이다.
  SELECT a.id INTO v_locked
    FROM public.paper_accounts a WHERE a.id = v_account FOR UPDATE;
  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'paper_settle_close: 계좌가 없습니다 (%) — 포지션을 닫지 않습니다', v_account;
  END IF;

  -- ③ 챌린지를 같은 방향으로 잠근다 (계좌 → 챌린지).
  SELECT c.id INTO v_challenge
    FROM public.paper_challenges c WHERE c.paper_account_id = v_account FOR UPDATE;

  -- ③-a **사건 시각 신선도 — 잠금을 전부 잡은 뒤에 본다.**
  --
  --    이 검사가 만료 유예와 같은 상수를 쓰기 때문에, 기간 안의 사건이
  --    만료 뒤에 도착해 달성을 잃는 일이 생기지 않는다(086 머리말 참고).
  --    청산 자체는 CLOSING에서도 열려 있다 — 막는 것은 진입뿐이다.
  IF v_challenge IS NOT NULL THEN
    PERFORM public.paper_event_time_guard(p_event_effective_at);
  END IF;

  -- ④ 선점. **사전 확보한 계좌가 여전히 이 포지션의 계좌인가**까지 건다.
  --
  --    읽는 칸은 전부 표 이름으로 한정한다(`SET`의 왼쪽은 대상 표가 정해져
  --    있으므로 한정하지 않는다 — 한정하면 Postgres가 거부한다).
  --    `084`가 고친 고장이 이 부류였다: 반환 칸이나 선언 변수와 이름이 겹치는
  --    순간 **실행할 때** 42702가 된다. 지금 이 함수는 `status`를 반환하지 않아
  --    우연히 돌아가고 있을 뿐이고, 반환 칸 하나만 늘어나면 조용히 깨진다.
  UPDATE public.paper_positions pp
     SET status       = 'closed',
         exit_price   = p_exit_price,
         exit_reason  = p_exit_reason,
         exit_fee     = p_exit_fee,
         gross_pnl    = p_gross_pnl,
         realized_pnl = p_realized_pnl,
         pnl_pct      = p_pnl_pct,
         closed_at    = NOW()
   WHERE pp.id = p_position_id
     AND pp.status = 'open'
     AND COALESCE(pp.paper_account_id, v_account) = v_account
  RETURNING pp.id INTO v_hit;

  IF v_hit IS NULL THEN
    -- 남이 먼저 닫았거나, 그 사이 계좌가 바뀌었다.
    -- **원장·잔고 변경 0.**
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- ⑤⑥ 원장과 잔고. **같은 체결이 두 줄이다.**
  --
  --     REALIZED_PNL은 수수료 차감 전 gross, TRADING_FEE는 음수.
  --     순액을 한 줄로 적으면 수수료가 두 번 빠진다.
  PERFORM public.paper_money_apply(
    v_account, v_owner, 'REALIZED_PNL', p_gross_pnl,
    'POSITION_CLOSE', p_position_id::TEXT, p_event_effective_at);

  PERFORM public.paper_money_apply(
    v_account, v_owner, 'TRADING_FEE', -p_exit_fee,
    'POSITION_CLOSE', p_position_id::TEXT, p_event_effective_at);

  -- ⑦ 통계. 돈이 아니라 집계다.
  --
  --    ★ **088 — 승패는 이 lot의 일생으로 판정한다.**
  --
  --    부분매도를 거친 줄이 여기로 오면 `p_realized_pnl`은 **마지막 조각**의
  --    손익이다. 앞에서 크게 잃고 마지막 조각만 +면 승으로 잡힌다. 그래서
  --    이 줄에 귀속된 처분 손익을 전부 더해서 본다.
  --
  --    부분매도된 적 없는 줄은 합이 0이라 **예전과 완전히 같은 값**이다.
  --    `trade_count`·`total_pnl`·`total_fees`·원장·잔고는 건드리지 않는다 —
  --    바뀌는 것은 승패 판정 하나다.
  SELECT COALESCE(SUM(l.lot_realized_pnl), 0) INTO v_prior
    FROM public.paper_sell_event_lots l
   WHERE l.position_id = p_position_id;

  UPDATE public.paper_accounts
     SET total_pnl   = total_pnl   + p_realized_pnl,
         total_fees  = total_fees  + p_exit_fee,
         trade_count = trade_count + 1,
         win_count   = win_count
                     + CASE WHEN (v_prior + p_realized_pnl) > 0 THEN 1 ELSE 0 END
   WHERE id = v_account;

  -- ⑦-b **닫힌 줄의 realized_pnl은 그 lot의 일생이다.**
  --
  --     승패를 누적으로 판정하면서 칸에는 마지막 조각만 남기면 두 숫자가
  --     서로 다른 것을 말한다. 무엇보다 하루 손실 합산이 "닫힌 줄의
  --     realized_pnl"을 읽으므로, 칸과 판정이 갈리면 한도가 틀린 값을 본다.
  --     `total_pnl`은 증가분 누계라 그대로 `p_realized_pnl`을 더한다.
  --
  --     부분매도된 적 없는 줄은 v_prior가 0이라 **예전 값과 똑같다.**
  IF v_prior <> 0 THEN
    UPDATE public.paper_positions pp
       SET realized_pnl = v_prior + p_realized_pnl
     WHERE pp.id = p_position_id;
  END IF;

  -- ⑧ 판정. **진입 경로와 같은 함수를 부른다** — 판정이 두 곳에 있으면 갈린다.
  PERFORM public.paper_challenge_judge(
    v_challenge, v_account, v_owner, p_event_effective_at);

  RETURN QUERY SELECT TRUE, v_owner, p_realized_pnl, p_pnl_pct;
END $$;

-- ══════════════════ ⑦ 현물 보유분 매도 ══════════════════
--
-- 잠금 순서는 기존과 같다: **계좌 → 챌린지 → 포지션.**
-- `084`·`085`·`086`·`087`이 전부 계좌를 먼저 잡는다. 포지션 행잠금을 셋째
-- 자리에 두면 전순서가 유지되고 순환이 생기지 않는다. 계좌 잠금이 이 계좌의
-- 모든 돈 경로가 만나는 한 점이므로, lot 변경은 그 아래에서 이미 직렬화된다.
--
-- 반환 칸은 전부 `out_`으로 시작한다 — ⑥번 계약 참고.
CREATE OR REPLACE FUNCTION public.paper_sell_holding(
  p_user               UUID,
  p_paper_account_id   UUID,
  p_market             TEXT,
  p_symbol             TEXT,
  p_percent            NUMERIC,
  p_quantity           NUMERIC,
  p_exit_price         NUMERIC,
  p_fee_rate           NUMERIC,
  p_client_sell_id     TEXT,
  p_event_effective_at TIMESTAMPTZ
)
RETURNS TABLE (
  out_status     TEXT,     -- SOLD | REPLAYED | CONFLICT | NO_ACCOUNT | NO_HOLDING
                           -- | INSUFFICIENT_HOLDING | NOT_SPOT | UNREADABLE_LOT
  out_sell_id    UUID,
  out_sold_qty   NUMERIC,
  out_gross      NUMERIC,
  out_exit_fee   NUMERIC,
  out_realized   NUMERIC,
  out_remaining  NUMERIC,
  out_lots       INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account   UUID;
  v_challenge UUID;
  v_sym       TEXT;
  v_fp        TEXT;
  v_prev      RECORD;
  v_held      NUMERIC := 0;
  v_odd       INT := 0;
  v_null      INT := 0;
  v_sold      NUMERIC;
  v_scale     INT := public.paper_alloc_scale();
  v_all       BOOLEAN;
  r           RECORD;
  v_ids       UUID[]    := ARRAY[]::UUID[];
  v_q         NUMERIC[] := ARRAY[]::NUMERIC[];
  v_n         NUMERIC[] := ARRAY[]::NUMERIC[];
  v_m         NUMERIC[] := ARRAY[]::NUMERIC[];
  v_b         NUMERIC[] := ARRAY[]::NUMERIC[];
  v_fp_price  NUMERIC[] := ARRAY[]::NUMERIC[];
  v_take      NUMERIC[] := ARRAY[]::NUMERIC[];
  v_residue   NUMERIC;
  v_room      NUMERIC;
  v_put       NUMERIC;
  i           INT;
  v_ns        NUMERIC; v_ms NUMERIC; v_es NUMERIC;
  v_lg        NUMERIC; v_lf NUMERIC; v_lr NUMERIC;
  v_gross     NUMERIC := 0;
  v_fee       NUMERIC := 0;
  v_real      NUMERIC := 0;
  v_lots      INT := 0;
  v_sell      UUID;
  v_cum       NUMERIC;
  v_avg       NUMERIC;
  v_hit       UUID;
  v_closed    INT := 0;
  v_wins      INT := 0;
  v_rem       NUMERIC;
BEGIN
  -- **돈에 닿기 전에 거부한다.**
  IF p_event_effective_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22004',
      MESSAGE = 'paper_sell_holding: 사건 시각이 없습니다 — 아무것도 팔지 않습니다';
  END IF;
  IF p_client_sell_id IS NULL OR btrim(p_client_sell_id) = '' THEN
    RAISE EXCEPTION 'paper_sell_holding: 매도 식별자가 없습니다 — 재시도를 구별할 수 없습니다';
  END IF;
  IF p_exit_price IS NULL OR p_exit_price <= 0 THEN
    RAISE EXCEPTION 'paper_sell_holding: 청산가가 없거나 0 이하입니다 (%)', p_exit_price;
  END IF;
  IF p_fee_rate IS NULL OR p_fee_rate < 0 THEN
    RAISE EXCEPTION 'paper_sell_holding: 수수료율이 없거나 음수입니다 (%)', p_fee_rate;
  END IF;
  -- 둘 다 오거나 둘 다 없으면 **무엇을 팔라는지 모른다.** 추측하지 않는다.
  IF (p_percent IS NULL) = (p_quantity IS NULL) THEN
    RAISE EXCEPTION 'paper_sell_holding: 비율과 수량 중 정확히 하나만 주세요';
  END IF;
  IF p_percent IS NOT NULL AND (p_percent <= 0 OR p_percent > 100) THEN
    RAISE EXCEPTION 'paper_sell_holding: 비율이 1~100 밖입니다 (%)', p_percent;
  END IF;
  IF p_quantity IS NOT NULL AND p_quantity <= 0 THEN
    RAISE EXCEPTION 'paper_sell_holding: 수량이 0 이하입니다 (%)', p_quantity;
  END IF;
  -- **현물만이다.** 선물을 여기로 흘려보내면 배율·청산 규칙이 사라진다.
  IF upper(COALESCE(p_market, '')) <> 'SPOT' THEN
    RETURN QUERY SELECT 'NOT_SPOT'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC,
                        NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::INT;
    RETURN;
  END IF;
  v_sym := upper(COALESCE(p_symbol, ''));
  IF v_sym = '' THEN
    RAISE EXCEPTION 'paper_sell_holding: 종목이 없습니다';
  END IF;

  -- ① 계좌를 잠근다. **소유자까지 함께 본다** — 남의 계좌 id를 넣어도 안 잡힌다.
  SELECT a.id INTO v_account
    FROM public.paper_accounts a
   WHERE a.id = p_paper_account_id AND a.user_id = p_user
     FOR UPDATE;
  IF v_account IS NULL THEN
    RETURN QUERY SELECT 'NO_ACCOUNT'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC,
                        NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::INT;
    RETURN;
  END IF;

  -- ② 챌린지를 같은 방향으로 잠근다 (계좌 → 챌린지).
  SELECT c.id INTO v_challenge
    FROM public.paper_challenges c WHERE c.paper_account_id = v_account FOR UPDATE;

  -- ②-a 사건 시각 신선도 — **잠금을 전부 잡은 뒤에 본다** (`086`과 같은 자리).
  --      매도는 CLOSING에서도 열려 있다. 막는 것은 진입뿐이다.
  IF v_challenge IS NOT NULL THEN
    PERFORM public.paper_event_time_guard(p_event_effective_at);
  END IF;

  -- ③ 멱등. **계좌 잠금 아래에서 보므로 같은 계좌의 재시도는 줄을 선다.**
  v_fp := v_sym || '|' || upper(p_market) || '|'
          || COALESCE(p_percent::TEXT, '-') || '|'
          || COALESCE(p_quantity::TEXT, '-');

  SELECT e.id, e.request_fingerprint, e.sold_quantity, e.gross_pnl, e.exit_fee,
         e.realized_pnl, e.remaining_quantity, e.lots_touched
    INTO v_prev
    FROM public.paper_sell_events e
   WHERE e.paper_account_id = v_account AND e.client_sell_id = p_client_sell_id;

  IF v_prev.id IS NOT NULL THEN
    IF v_prev.request_fingerprint IS DISTINCT FROM v_fp THEN
      -- 같은 식별자로 **다른 것**을 팔려 한다. 조용히 재생하지 않는다.
      RETURN QUERY SELECT 'CONFLICT'::TEXT, v_prev.id, NULL::NUMERIC, NULL::NUMERIC,
                          NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::INT;
      RETURN;
    END IF;
    -- 재시도다. **다시 팔지 않고 적어 둔 답을 그대로 준다.**
    RETURN QUERY SELECT 'REPLAYED'::TEXT, v_prev.id, v_prev.sold_quantity,
                        v_prev.gross_pnl, v_prev.exit_fee, v_prev.realized_pnl,
                        v_prev.remaining_quantity, v_prev.lots_touched;
    RETURN;
  END IF;

  -- ④ 보유 집계 — **잠금을 잡은 뒤에 읽은 이 값이 최종이다.**
  --
  --    계약이 성립하는 줄만 센다(SPOT · LONG · 배율 1). 성립하지 않는 줄이
  --    섞여 있으면 **조용히 건너뛰지 않고 멈춘다** — 건너뛰면 사용자가 보는
  --    보유수량과 파는 수량이 갈린다.
  SELECT COUNT(*) INTO v_odd
    FROM public.paper_positions pp
   WHERE pp.user_id = p_user AND pp.paper_account_id = v_account
     AND pp.market = 'SPOT' AND pp.symbol = v_sym AND pp.status = 'open'
     AND (pp.side <> 'LONG' OR pp.leverage <> 1);
  IF v_odd > 0 THEN
    RETURN QUERY SELECT 'NOT_SPOT'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC,
                        NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::INT;
    RETURN;
  END IF;

  -- 남은 원가 귀속을 모르는 줄은 **팔지 않는다.** 0으로 읽으면 수수료가
  -- 귀속되지 않은 채 손익이 부풀어 나온다.
  SELECT COUNT(*) INTO v_null
    FROM public.paper_positions pp
   WHERE pp.user_id = p_user AND pp.paper_account_id = v_account
     AND pp.market = 'SPOT' AND pp.symbol = v_sym AND pp.status = 'open'
     AND (pp.remaining_entry_fee_basis IS NULL OR pp.open_quantity IS NULL);
  IF v_null > 0 THEN
    RETURN QUERY SELECT 'UNREADABLE_LOT'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC,
                        NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::INT;
    RETURN;
  END IF;

  -- ⑤ lot을 잠그면서 읽는다. 순서는 오래된 것부터 — 같은 입력에 같은 결과.
  FOR r IN
    SELECT pp.id, pp.quantity, pp.notional, pp.margin,
           pp.remaining_entry_fee_basis AS basis, pp.fill_price
      FROM public.paper_positions pp
     WHERE pp.user_id = p_user AND pp.paper_account_id = v_account
       AND pp.market = 'SPOT' AND pp.symbol = v_sym AND pp.status = 'open'
       AND pp.side = 'LONG' AND pp.leverage = 1
     ORDER BY pp.opened_at, pp.id
       FOR UPDATE
  LOOP
    v_ids := array_append(v_ids, r.id);
    v_q   := array_append(v_q, r.quantity);
    v_n   := array_append(v_n, r.notional);
    v_m   := array_append(v_m, r.margin);
    v_b   := array_append(v_b, r.basis);
    v_fp_price := array_append(v_fp_price, r.fill_price);
    v_held := v_held + r.quantity;
  END LOOP;

  IF v_held <= 0 THEN
    RETURN QUERY SELECT 'NO_HOLDING'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC,
                        NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC, NULL::INT;
    RETURN;
  END IF;

  -- ⑥ 팔 수량. **100%는 나눗셈을 하지 않는다** — 이것이 등가의 핵심이다.
  IF p_percent IS NOT NULL THEN
    IF p_percent = 100 THEN
      v_sold := v_held;
    ELSE
      v_sold := public.paper_floor_at(v_held * p_percent / 100, v_scale);
    END IF;
  ELSE
    v_sold := p_quantity;
  END IF;

  IF v_sold <= 0 THEN
    RAISE EXCEPTION 'paper_sell_holding: 팔 수량이 0이 되었습니다 (보유 %, 비율 %)',
      v_held, p_percent;
  END IF;
  IF v_sold > v_held THEN
    -- **fail closed.** 가진 것보다 많이 팔지 않는다.
    RETURN QUERY SELECT 'INSUFFICIENT_HOLDING'::TEXT, NULL::UUID, v_sold, NULL::NUMERIC,
                        NULL::NUMERIC, NULL::NUMERIC, v_held, NULL::INT;
    RETURN;
  END IF;

  v_all := (v_sold = v_held);

  -- ⑦ 배분 1단계 — 비례 **내림**. 합은 항상 v_sold 이하다.
  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    IF v_all THEN
      v_take := array_append(v_take, v_q[i]);
    ELSE
      v_take := array_append(v_take, public.paper_floor_at(v_q[i] * v_sold / v_held, v_scale));
    END IF;
  END LOOP;

  -- ⑧ 배분 2단계 — 잔여 흡수. 여유의 합이 잔여 이상이므로 **항상 소진된다**.
  --    이 단계가 없으면 내림 오차가 lot에 dust로 남아 영원히 안 풀린다.
  v_residue := v_sold;
  FOR i IN 1 .. array_length(v_take, 1) LOOP
    v_residue := v_residue - v_take[i];
  END LOOP;
  IF v_residue < 0 THEN
    RAISE EXCEPTION 'paper_sell_holding: 배분이 매도 수량을 넘었습니다 (%) — 되돌립니다', v_residue;
  END IF;
  i := 1;
  WHILE v_residue > 0 AND i <= array_length(v_ids, 1) LOOP
    v_room := v_q[i] - v_take[i];
    IF v_room > 0 THEN
      v_put := LEAST(v_room, v_residue);
      v_take[i] := v_take[i] + v_put;
      v_residue := v_residue - v_put;
    END IF;
    i := i + 1;
  END LOOP;
  IF v_residue <> 0 THEN
    RAISE EXCEPTION 'paper_sell_holding: 배분 잔여가 남았습니다 (%) — 되돌립니다', v_residue;
  END IF;

  -- ⑨ lot별 금액. **곱셈·뺄셈만** — 나눗셈 결과가 총합에 들어가지 않는다.
  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    CONTINUE WHEN v_take[i] = 0;
    v_lg := (p_exit_price - v_fp_price[i]) * v_take[i];
    v_lf := p_exit_price * v_take[i] * p_fee_rate;
    IF v_take[i] = v_q[i] THEN
      -- 이 lot을 다 판다. **남은 것을 통째로** 가져간다 (나눗셈 0회).
      v_es := v_b[i];
    ELSE
      v_es := public.paper_floor_at(v_b[i] * v_take[i] / v_q[i], v_scale);
    END IF;
    v_lr := v_lg - v_es - v_lf;
    v_gross := v_gross + v_lg;
    v_fee   := v_fee + v_lf;
    v_real  := v_real + v_lr;
    v_lots  := v_lots + 1;
  END LOOP;

  -- ⑩ 사건을 적는다. 여기서 만들어진 id가 원장의 source_event_id다.
  INSERT INTO public.paper_sell_events (
    paper_account_id, user_id, client_sell_id, request_fingerprint,
    market, symbol, exit_price, fee_rate,
    sold_quantity, gross_pnl, exit_fee, realized_pnl,
    remaining_quantity, lots_touched, event_effective_at
  ) VALUES (
    v_account, p_user, p_client_sell_id, v_fp,
    'SPOT', v_sym, p_exit_price, p_fee_rate,
    v_sold, v_gross, v_fee, v_real,
    v_held - v_sold, v_lots, p_event_effective_at
  )
  ON CONFLICT ON CONSTRAINT paper_sell_events_idem_key DO NOTHING
  RETURNING id INTO v_sell;

  IF v_sell IS NULL THEN
    -- ③에서 없다고 보고 왔는데 여기서 충돌했다. 계좌를 잠근 채였으므로
    -- **일어날 수 없다.** 조용히 넘기지 않는다.
    RAISE EXCEPTION 'paper_sell_holding: 매도 사건이 이미 있습니다 — 되돌립니다';
  END IF;

  -- ⑪ lot별 기록과 갱신. 기록을 먼저 넣어야 ⑫의 누적이 이번 매도를 포함한다.
  FOR i IN 1 .. array_length(v_ids, 1) LOOP
    CONTINUE WHEN v_take[i] = 0;
    v_lg := (p_exit_price - v_fp_price[i]) * v_take[i];
    v_lf := p_exit_price * v_take[i] * p_fee_rate;
    IF v_take[i] = v_q[i] THEN
      v_es := v_b[i];  v_ns := v_n[i];  v_ms := v_m[i];
    ELSE
      v_es := public.paper_floor_at(v_b[i] * v_take[i] / v_q[i], v_scale);
      v_ns := public.paper_floor_at(v_n[i] * v_take[i] / v_q[i], v_scale);
      v_ms := public.paper_floor_at(v_m[i] * v_take[i] / v_q[i], v_scale);
    END IF;
    v_lr := v_lg - v_es - v_lf;

    INSERT INTO public.paper_sell_event_lots (
      sell_id, position_id, taken_quantity, taken_notional, taken_margin,
      allocated_entry_fee_basis, lot_gross_pnl, lot_exit_fee, lot_realized_pnl
    ) VALUES (
      v_sell, v_ids[i], v_take[i], v_ns, v_ms, v_es, v_lg, v_lf, v_lr
    );

    IF v_take[i] = v_q[i] THEN
      -- ⑫ 이 lot의 일생이 끝났다. **누적은 기록에서 읽는다** — 칸으로 또
      --    들고 있으면 돈의 정본이 둘이 된다.
      SELECT COALESCE(SUM(l.lot_realized_pnl), 0) INTO v_cum
        FROM public.paper_sell_event_lots l WHERE l.position_id = v_ids[i];
      -- 여러 가격에 나눠 팔렸으면 단일 청산가가 없다. 수량가중평균을 적는다
      -- (표시용 파생값이다 — 매도별 실제 가격은 paper_sell_events에 있다).
      SELECT SUM(l.taken_quantity * e.exit_price) / NULLIF(SUM(l.taken_quantity), 0)
        INTO v_avg
        FROM public.paper_sell_event_lots l
        JOIN public.paper_sell_events e ON e.id = l.sell_id
       WHERE l.position_id = v_ids[i];

      UPDATE public.paper_positions pp
         SET quantity     = 0,
             notional     = 0,
             margin       = 0,
             remaining_entry_fee_basis = 0,
             status       = 'closed',
             exit_price   = v_avg,
             exit_reason  = 'MANUAL',
             exit_fee     = (SELECT COALESCE(SUM(l.lot_exit_fee), 0)
                               FROM public.paper_sell_event_lots l
                              WHERE l.position_id = pp.id),
             gross_pnl    = (SELECT COALESCE(SUM(l.lot_gross_pnl), 0)
                               FROM public.paper_sell_event_lots l
                              WHERE l.position_id = pp.id),
             realized_pnl = v_cum,
             pnl_pct      = CASE WHEN pp.open_margin > 0
                                 THEN v_cum / pp.open_margin * 100 ELSE NULL END,
             closed_at    = NOW()
       WHERE pp.id = v_ids[i] AND pp.status = 'open' AND pp.quantity = v_q[i]
      RETURNING pp.id INTO v_hit;
      IF v_hit IS NULL THEN
        RAISE EXCEPTION 'paper_sell_holding: lot %가 그 사이 바뀌었습니다 — 되돌립니다', v_ids[i];
      END IF;
      v_closed := v_closed + 1;
      IF v_cum > 0 THEN v_wins := v_wins + 1; END IF;
    ELSE
      UPDATE public.paper_positions pp
         SET quantity = pp.quantity - v_take[i],
             notional = pp.notional - v_ns,
             margin   = pp.margin   - v_ms,
             remaining_entry_fee_basis = pp.remaining_entry_fee_basis - v_es
       WHERE pp.id = v_ids[i] AND pp.status = 'open' AND pp.quantity = v_q[i]
      RETURNING pp.id INTO v_hit;
      IF v_hit IS NULL THEN
        RAISE EXCEPTION 'paper_sell_holding: lot %가 그 사이 바뀌었습니다 — 되돌립니다', v_ids[i];
      END IF;
    END IF;
  END LOOP;

  -- ⑬ 돈. **같은 매도가 두 줄이다** — gross와 수수료를 따로 적는다.
  --     순액 한 줄로 적으면 수수료가 두 번 빠진다 (`085`가 적어 둔 그대로).
  IF NOT public.paper_money_apply(
      v_account, p_user, 'REALIZED_PNL', v_gross,
      'POSITION_SELL', v_sell::TEXT, p_event_effective_at) THEN
    RAISE EXCEPTION 'paper_sell_holding: 이 매도의 실현손익이 이미 적혀 있습니다 — 되돌립니다';
  END IF;
  IF NOT public.paper_money_apply(
      v_account, p_user, 'TRADING_FEE', -v_fee,
      'POSITION_SELL', v_sell::TEXT, p_event_effective_at) THEN
    RAISE EXCEPTION 'paper_sell_holding: 이 매도의 수수료가 이미 적혀 있습니다 — 되돌립니다';
  END IF;

  -- ⑭ 통계. 돈이 아니라 집계다.
  --     **부분매도는 거래로 세지 않는다.** lot이 0이 될 때만 한 번 센다 —
  --     25+25+50과 100 한 번의 승률이 달라지면 안 된다.
  UPDATE public.paper_accounts
     SET total_pnl    = total_pnl   + v_real,
         total_fees   = total_fees  + v_fee,
         trade_count  = trade_count + v_closed,
         win_count    = win_count   + v_wins
   WHERE id = v_account;

  -- ⑮ 판정. **진입·청산과 같은 함수를 부른다** — 판정이 세 곳이면 갈린다.
  PERFORM public.paper_challenge_judge(
    v_challenge, v_account, p_user, p_event_effective_at);

  v_rem := v_held - v_sold;
  RETURN QUERY SELECT 'SOLD'::TEXT, v_sell, v_sold, v_gross, v_fee, v_real, v_rem, v_lots;
END $$;

COMMENT ON FUNCTION public.paper_sell_holding(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ) IS
  '현물 보유분을 나눠 파는 단 하나의 자리. 금액을 밖에서 받지 않는다 — '
  '수량·비율·청산가·수수료율만 받고 손익과 수수료는 여기서 만든다. '
  '마지막 조각이 남은 전부를 가져가므로 분할매도와 전량매도의 회계가 같다.';

-- ══════════════════ ⑧ 보유 읽기 ══════════════════
--
-- 집계가 두 곳에 있으면 화면이 보는 수량과 파는 수량이 갈린다. 한 곳이다.
-- **평균가는 수수료를 넣지 않은 체결평균가다.** 취득원가(수수료 포함)와
-- 같은 이름으로 섞으면 사용자가 수수료 포함분을 체결가로 읽는다.
CREATE OR REPLACE FUNCTION public.paper_holdings(
  p_user             UUID,
  p_paper_account_id UUID
)
RETURNS TABLE (
  h_symbol     TEXT,
  h_market     TEXT,
  h_quantity   NUMERIC,
  h_notional   NUMERIC,
  h_fee_basis  NUMERIC,
  h_avg_price  NUMERIC,
  h_lots       INT
)
LANGUAGE sql STABLE
AS $$
  SELECT pp.symbol, pp.market,
         SUM(pp.quantity),
         SUM(pp.notional),
         SUM(pp.remaining_entry_fee_basis),
         CASE WHEN SUM(pp.quantity) > 0
              THEN SUM(pp.notional) / SUM(pp.quantity) END,
         COUNT(*)::INT
    FROM public.paper_positions pp
   WHERE pp.user_id = p_user
     AND pp.paper_account_id = p_paper_account_id
     AND pp.market = 'SPOT'
     AND pp.status = 'open'
     AND pp.side = 'LONG'
     AND pp.leverage = 1
   GROUP BY pp.symbol, pp.market
   ORDER BY pp.symbol
$$;

COMMENT ON FUNCTION public.paper_holdings(UUID, UUID) IS
  '한 계좌의 현물 보유 집계. h_avg_price는 수수료를 넣지 않은 체결평균가다. '
  '평가손익·수익률은 넣지 않는다 — 열린 포지션의 미실현 손익 정본이 없다.';

-- ══════════════════ ⑨ 기간 실현손익 — 날짜가 이동하지 않게 ══════════════════
--
-- 하루 손실 한도는 "오늘 실현한 손익"을 봐야 한다. 예전에는 **닫힌 포지션의
-- `realized_pnl`을 `closed_at` 기준으로** 합산했는데, 부분매도가 생기면 둘 다
-- 틀린다.
--
--   · 부분매도는 줄을 닫지 않는다 → 하루 종일 손절해도 한도에 안 잡힌다
--   · 어제 부분매도한 줄이 오늘 닫히면 → **어제 손실이 오늘로 옮겨 온다**
--
-- 그래서 처분을 **사건 시각**으로 센다.
--
--   ① 그 기간의 매도 사건에 귀속된 손익 (paper_sell_event_lots)
--   ② 그 기간에 닫힌 줄의 **legacy 몫** = realized_pnl - 그 줄의 매도 사건 합
--
-- ②가 겹치지 않는 이유: `paper_sell_holding`이 닫은 줄은 `realized_pnl`이
-- 곧 매도 사건 합이라 차가 0이다. legacy 청산이 닫은 줄만 남는다.
CREATE OR REPLACE FUNCTION public.paper_realized_between(
  p_user             UUID,
  p_paper_account_id UUID,
  p_from             TIMESTAMPTZ,
  p_to               TIMESTAMPTZ
)
RETURNS TABLE (
  r_realized NUMERIC,
  r_events   INT
)
LANGUAGE sql STABLE
AS $$
  WITH sells AS (
    SELECT COALESCE(SUM(l.lot_realized_pnl), 0) AS amt, COUNT(*)::INT AS n
      FROM public.paper_sell_events e
      JOIN public.paper_sell_event_lots l ON l.sell_id = e.id
     WHERE e.user_id = p_user
       AND e.paper_account_id = p_paper_account_id
       AND e.event_effective_at >= p_from
       AND e.event_effective_at <  p_to
  ),
  closes AS (
    SELECT COALESCE(SUM(
             pp.realized_pnl
             - COALESCE((SELECT SUM(l.lot_realized_pnl)
                           FROM public.paper_sell_event_lots l
                          WHERE l.position_id = pp.id), 0)
           ), 0) AS amt,
           COUNT(*)::INT AS n
      FROM public.paper_positions pp
     WHERE pp.user_id = p_user
       AND pp.paper_account_id = p_paper_account_id
       AND pp.status = 'closed'
       AND pp.closed_at >= p_from
       AND pp.closed_at <  p_to
  )
  SELECT sells.amt + closes.amt, sells.n + closes.n FROM sells, closes
$$;

COMMENT ON FUNCTION public.paper_realized_between(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) IS
  '한 계좌가 그 기간에 실현한 손익. 부분매도는 사건 시각으로, legacy 전량청산은 '
  '닫힌 시각으로 센다 — 둘이 겹치지 않는다. 하루 손실 한도가 읽는 단 하나의 자리.';

-- ══════════════════ ⑩ 권한 ══════════════════
--
-- 돈을 움직이는 함수는 service_role만 부른다. 기본 PUBLIC 실행을 거둔다.
REVOKE ALL ON FUNCTION public.paper_alloc_scale() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_floor_at(NUMERIC, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_positions_freeze_open_cols() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_holdings(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_realized_between(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_sell_holding(
  UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.paper_alloc_scale() TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_floor_at(NUMERIC, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_holdings(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_realized_between(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_sell_holding(
  UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ) TO service_role;
