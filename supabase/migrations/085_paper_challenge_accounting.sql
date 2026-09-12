-- 085_paper_challenge_accounting.sql
--
-- **챌린지의 돈이 지나가는 길을 하나로 만든다.**
--
-- `083`은 자리(표·제약·불변 트리거)만 만들었다. 여기서 실제로 돈이 움직이는
-- 경로를 만들고, **그 경로 하나만 남긴다.**
--
-- 왜 경로를 하나로 모으는가
-- ─────────────────────────
-- 불변식은 `SUM(cashflows.amount) = paper_accounts.balance`다. 잔고를 바꾸는
-- 자리가 여러 곳이면, 그중 하나만 원장을 안 적어도 불변식이 깨진다. 그리고
-- 깨진 것은 한참 뒤 "수익률이 이상하다"로 나타난다.
--
-- 그래서 `paper_money_apply` 하나가 **원장 기록과 잔고 변경을 같이** 한다.
-- 둘을 따로 부를 수 있으면 언젠가 한쪽만 불린다.
--
-- legacy 함수는 챌린지 계좌에서 **거부한다**
-- ──────────────────────────────────────────
-- `paper_deposit`·`paper_apply_entry_fee`에 원장 쓰기를 덧붙이지 않는다.
-- 덧붙이면 돈의 정본 경로가 다시 여러 개가 된다. 챌린지 계좌를 지목하면
-- 그냥 거부하고, 챌린지 돈은 이 파일의 경로로만 움직인다.
-- (호출처가 0곳인 `paper_apply_entry_fee`도 지우지 않는다 — 지우는 것과
-- 막는 것은 다른 결정이고, 여기서는 막기만 한다.)
--
-- 잠금 순서
-- ─────────
-- **paper_accounts → paper_challenges → paper_positions.** 모든 경로가 계좌
-- 에서 시작한다. 챌린지는 계좌와 1:1(`UNIQUE (paper_account_id)`)이므로
-- 계좌를 잠그면 그 챌린지의 모든 돈 경로가 직렬화된다.
--
-- `082`의 `paper_settle_close`는 포지션을 먼저 잠갔다(포지션 → 계좌). 진입은
-- 반대(계좌 → 포지션)였다. 여기서 청산을 계좌부터 잠그게 바꿔 **두 경로의
-- 방향을 맞춘다.** 이건 회계를 끼워 넣기 위한 부수 변경이 아니라, 끼워 넣기
-- 전에 반드시 해야 하는 것이다.
--
-- 사건 시각은 반드시 받는다
-- ─────────────────────────
-- 칸의 NOT NULL만 믿지 않는다. 그러면 원장 INSERT까지 가서야 실패하고, 그
-- 사이에 이미 잠금을 잡고 판단을 했다. **함수에 들어오자마자 거부한다** —
-- 계약은 "명시 시각이 없으면 돈을 건드리지 않는다"다.

-- ══════════════════ ① 이 계좌가 챌린지 것인가 ══════════════════
--
-- **끝난 챌린지의 계좌도 챌린지 계좌다.** 마감된 원장에 legacy 입금이 들어오면
-- 그 기록은 영원히 설명되지 않는다.
CREATE OR REPLACE FUNCTION public.paper_is_challenge_account(p_account UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.paper_challenges c WHERE c.paper_account_id = p_account
  )
$$;

COMMENT ON FUNCTION public.paper_is_challenge_account(UUID) IS
  '이 모의 계좌가 어떤 챌린지의 전용 계좌인가. 끝난 챌린지도 포함한다 — '
  '마감된 원장에 legacy 경로로 돈이 들어오면 설명되지 않는 잔고가 된다.';

-- ══════════════════ ② 돈이 움직이는 단 하나의 자리 ══════════════════
--
-- 챌린지 계좌면 **원장 한 줄과 잔고 변경을 같은 트랜잭션에서 함께** 한다.
-- 그냥 계좌면 잔고만 바꾼다(원장이 없으므로).
--
-- 멱등
-- ────
-- 같은 `(challenge_id, cashflow_type, source_event_type, source_event_id)`가
-- 다시 오면 `083`의 유니크가 막고, **잔고도 다시 밀지 않는다.** 원장이 새로
-- 생겼을 때만 잔고를 민다 — 둘이 갈릴 수 없다.
--
-- 그냥 계좌에는 원장이 없어서 이 멱등이 없다. 그쪽은 포지션 CAS가 같은 일을
-- 두 번 하지 않도록 막는다(지금까지의 동작 그대로).
CREATE OR REPLACE FUNCTION public.paper_money_apply(
  p_account     UUID,
  p_user        UUID,
  p_type        TEXT,
  p_amount      NUMERIC,
  p_source_type TEXT,
  p_source_id   TEXT,
  p_event_at    TIMESTAMPTZ
)
RETURNS BOOLEAN          -- 실제로 적용했는가 (이미 적힌 사건이면 FALSE)
LANGUAGE plpgsql
AS $$
DECLARE
  v_challenge UUID;
  v_row       UUID;
BEGIN
  -- **들어오자마자 본다.** 칸의 NOT NULL에 맡기면 잠금을 잡은 뒤에야 터진다.
  IF p_event_at IS NULL THEN
    RAISE EXCEPTION 'paper_money_apply: 사건 시각이 없습니다 — 돈을 움직이지 않습니다';
  END IF;
  IF p_amount IS NULL THEN
    RAISE EXCEPTION 'paper_money_apply: 금액이 없습니다 — 0으로 적지 않습니다';
  END IF;

  SELECT c.id INTO v_challenge
    FROM public.paper_challenges c
   WHERE c.paper_account_id = p_account;

  IF v_challenge IS NOT NULL THEN
    INSERT INTO public.paper_challenge_cashflows
      (challenge_id, user_id, paper_account_id, cashflow_type, amount,
       source_event_type, source_event_id, event_effective_at)
    VALUES
      (v_challenge, p_user, p_account, p_type, p_amount,
       p_source_type, p_source_id, p_event_at)
    ON CONFLICT ON CONSTRAINT paper_challenge_cashflows_idem_key DO NOTHING
    RETURNING id INTO v_row;

    -- 이미 적힌 사건이다. **잔고도 건드리지 않는다** — 여기서 밀면 두 번 들어간다.
    IF v_row IS NULL THEN
      RETURN FALSE;
    END IF;
  END IF;

  UPDATE public.paper_accounts
     SET balance    = balance + p_amount,
         updated_at = NOW()
   WHERE id = p_account;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'paper_money_apply: 계좌를 찾지 못했습니다 (%) — 되돌립니다', p_account;
  END IF;

  RETURN TRUE;
END $$;

COMMENT ON FUNCTION public.paper_money_apply(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, TIMESTAMPTZ) IS
  '챌린지 잔고가 움직이는 단 하나의 자리. 원장 한 줄과 잔고 변경을 같은 '
  '트랜잭션에서 함께 한다 — 따로 부를 수 있으면 언젠가 한쪽만 불린다. '
  '같은 사건이 다시 오면 원장도 잔고도 다시 쓰지 않는다(FALSE 반환).';

-- ══════════════════ ③ 챌린지 생성 ══════════════════
--
-- 전용 계좌를 **0에서 시작**해서 만들고, `INITIAL_DEPOSIT` 한 줄로 시작금을
-- 넣는다. 계좌를 시작금으로 바로 만들면 그 돈은 원장에 없는 돈이 되고,
-- 첫 순간부터 불변식이 깨진 상태로 출발한다.
--
-- 동시에 두 번 눌러도 하나다
-- ──────────────────────────
-- 사용자 단위 advisory 잠금을 트랜잭션 안에서 잡는다. `083`의 부분 유니크
-- 인덱스가 최종 방어선이지만, 그것만 믿으면 진 쪽이 계좌를 하나 만들어 놓고
-- 터진다 — 주인 없는 계좌가 남는다.
--
-- 이미 활성 챌린지가 있으면 **그것을 그대로 돌려준다**(`created=false`).
-- 예외를 던지지 않는 이유는, 두 번 누른 것이 오류가 아니기 때문이다.
CREATE OR REPLACE FUNCTION public.paper_challenge_create(
  p_user_id            UUID,
  p_initial_equity     NUMERIC,
  p_target_equity      NUMERIC,
  p_failure_equity     NUMERIC,
  p_starts_at          TIMESTAMPTZ,
  p_ends_at            TIMESTAMPTZ,
  p_event_effective_at TIMESTAMPTZ
)
RETURNS TABLE (
  challenge_id     UUID,
  paper_account_id UUID,
  balance          NUMERIC,
  status           TEXT,
  created          BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing  UUID;
  v_account   UUID;
  v_challenge UUID;
  v_status    TEXT;
  v_balance   NUMERIC;
  v_ledger    NUMERIC;
BEGIN
  IF p_event_effective_at IS NULL THEN
    RAISE EXCEPTION 'paper_challenge_create: 사건 시각이 없습니다 — 계좌도 만들지 않습니다';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'paper_challenge_create: 사용자가 없습니다';
  END IF;
  IF p_initial_equity IS NULL OR p_initial_equity <= 0 THEN
    RAISE EXCEPTION 'paper_challenge_create: 시작금이 0 이하입니다 (%)', p_initial_equity;
  END IF;

  -- 같은 사용자의 생성 요청을 줄 세운다. 트랜잭션이 끝나면 저절로 풀린다.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 0));

  -- 이미 활성 챌린지가 있으면 그것이 답이다.
  SELECT c.id, c.paper_account_id, c.status
    INTO v_existing, v_account, v_status
    FROM public.paper_challenges c
   WHERE c.user_id = p_user_id
     AND c.status IN ('READY', 'RUNNING', 'CLOSING')
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    SELECT a.balance INTO v_balance FROM public.paper_accounts a WHERE a.id = v_account;
    RETURN QUERY SELECT v_existing, v_account, v_balance, v_status, FALSE;
    RETURN;
  END IF;

  -- ① 전용 계좌. **잔고 0에서 시작한다.**
  --
  --    `initial_balance`는 돈이 아니라 수익률의 분모다. 여기서 채워 두지
  --    않으면 기존 읽기 경로가 0으로 나눈다. 잔고는 그대로 0이다.
  INSERT INTO public.paper_accounts (user_id, is_default, balance, initial_balance)
  VALUES (p_user_id, FALSE, 0, p_initial_equity)
  RETURNING id INTO v_account;

  -- ② 챌린지. 기간이 이미 시작됐으면 RUNNING이다 — 첫 주문 여부와 무관하다.
  v_status := CASE WHEN p_starts_at > p_event_effective_at THEN 'READY' ELSE 'RUNNING' END;

  INSERT INTO public.paper_challenges
    (user_id, paper_account_id, status, initial_equity, target_equity, failure_equity,
     starts_at, ends_at)
  VALUES
    (p_user_id, v_account, v_status, p_initial_equity, p_target_equity, p_failure_equity,
     p_starts_at, p_ends_at)
  RETURNING id INTO v_challenge;

  -- ③ 시작금. **원장 한 줄과 잔고가 함께 움직인다.**
  --
  --    source_event_id를 챌린지 id로 두면, 이 챌린지의 INITIAL_DEPOSIT은
  --    구조적으로 한 줄뿐이다(083의 유니크).
  IF NOT public.paper_money_apply(
      v_account, p_user_id, 'INITIAL_DEPOSIT', p_initial_equity,
      'CHALLENGE_CREATE', v_challenge::TEXT, p_event_effective_at) THEN
    RAISE EXCEPTION 'paper_challenge_create: 시작금이 이미 적혀 있습니다 — 되돌립니다';
  END IF;

  -- ④ 상태 전이 기록 (감사용).
  INSERT INTO public.paper_challenge_transitions
    (challenge_id, user_id, from_status, to_status, reason, transition_key, event_effective_at)
  VALUES
    (v_challenge, p_user_id, NULL, v_status, '생성', 'CREATE:' || v_challenge::TEXT,
     p_event_effective_at);

  -- ⑤ 불변식을 여기서 한 번 확인한다. 출발점이 어긋나면 뒤는 전부 그 위에 쌓인다.
  SELECT a.balance INTO v_balance FROM public.paper_accounts a WHERE a.id = v_account;
  SELECT COALESCE(SUM(f.amount), 0) INTO v_ledger
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_challenge;

  IF v_balance IS DISTINCT FROM v_ledger THEN
    RAISE EXCEPTION
      'paper_challenge_create: 원장(%)과 잔고(%)가 다릅니다 — 되돌립니다', v_ledger, v_balance;
  END IF;

  RETURN QUERY SELECT v_challenge, v_account, v_balance, v_status, TRUE;
END $$;

COMMENT ON FUNCTION public.paper_challenge_create(UUID, NUMERIC, NUMERIC, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) IS
  '챌린지와 전용 계좌를 한 트랜잭션에서 만든다. 계좌는 잔고 0에서 시작하고 '
  '시작금은 INITIAL_DEPOSIT 원장 한 줄로 들어간다. 사용자 단위 advisory 잠금이 '
  '동시 생성을 줄 세우고, 이미 활성 챌린지가 있으면 created=false로 그것을 돌려준다.';

-- ══════════════════ ④ 진입 (계좌 → 챌린지 → 포지션) ══════════════════
--
-- `082`와 같은 일을 하되 두 가지가 다르다:
--   · 진입 수수료가 `paper_money_apply`를 지난다 (챌린지면 원장에 남는다)
--   · 사건 시각을 반드시 받는다
DROP FUNCTION IF EXISTS public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID);

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
  v_constraint TEXT;
BEGIN
  -- **돈에 닿기 전에 거부한다.**
  IF p_event_effective_at IS NULL THEN
    RAISE EXCEPTION 'paper_open_position: 사건 시각이 없습니다 — 아무것도 만들지 않습니다';
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

  -- ② 챌린지를 같은 방향으로 잠근다 (계좌 → 챌린지).
  SELECT c.id INTO v_challenge
    FROM public.paper_challenges c
   WHERE c.paper_account_id = v_account
     FOR UPDATE;

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
    stop_loss, take_profit, liquidation_price, entry_fee, margin_mode
  ) VALUES (
    p_user_id, v_account, p_signal_id, p_strategy_id, p_bucket, p_symbol,
    COALESCE(p_market, 'USDM'), p_side, 'open',
    p_entry_price, p_fill_price, p_quantity, p_notional, p_leverage, p_margin,
    p_stop_loss, p_take_profit, p_liquidation_price, p_entry_fee,
    COALESCE(p_margin_mode, 'ISOLATED')
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

-- ══════════════════ ⑤ 청산 정산 (account-first) ══════════════════
--
-- `082`는 포지션을 먼저 잠갔다. 여기서는 **계좌부터** 잠근다.
--
--   ① 잠그지 않고 포지션을 읽어 어느 계좌인지 안다
--   ② 그 계좌를 FOR UPDATE
--   ③ 챌린지가 있으면 FOR UPDATE
--   ④ 실제 선점 CAS — **사전 확보한 계좌가 여전히 그 포지션의 계좌인가**까지 건다
--   ⑤ 원장(실현손익 gross + 수수료 음수)  ⑥ 잔고  ⑦ 판정  ⑧ 챌린지 갱신
--
-- ④에 계좌 조건을 넣는 이유는 ①이 잠그지 않고 읽기 때문이다. 그 사이 포지션의
-- 계좌가 바뀌면 우리는 엉뚱한 계좌를 잠근 것이고, 조건이 깨져 0행이 된다 —
-- **원장도 잔고도 건드리지 않고 끝난다.**
DROP FUNCTION IF EXISTS public.paper_settle_close(
  UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC);

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
  v_balance   NUMERIC;
  v_ch        RECORD;
  v_intent    TEXT;
BEGIN
  -- **돈에 닿기 전에 거부한다.**
  IF p_event_effective_at IS NULL THEN
    RAISE EXCEPTION 'paper_settle_close: 사건 시각이 없습니다 — 포지션도 닫지 않습니다';
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
  UPDATE public.paper_accounts
     SET total_pnl   = total_pnl   + p_realized_pnl,
         total_fees  = total_fees  + p_exit_fee,
         trade_count = trade_count + 1,
         win_count   = win_count   + CASE WHEN p_realized_pnl > 0 THEN 1 ELSE 0 END
   WHERE id = v_account;

  -- ⑧ 판정 — **realized balance만 본다.** NAV(미실현 포함)로 판정하지 않는다.
  --
  --    미실현으로 판정하면 스쳐 지나간 호가에 달성이 확정된다. 그리고 사유는
  --    한 번만 정한다 — 다시 판단하는 것은 `083`의 트리거가 거부한다.
  IF v_challenge IS NOT NULL THEN
    SELECT a.balance INTO v_balance FROM public.paper_accounts a WHERE a.id = v_account;

    SELECT c.status, c.close_intent, c.target_equity, c.failure_equity,
           c.starts_at, c.ends_at
      INTO v_ch
      FROM public.paper_challenges c WHERE c.id = v_challenge;

    IF v_ch.close_intent IS NULL AND v_ch.status IN ('READY', 'RUNNING') THEN
      v_intent := NULL;

      -- **유효기간 안에서 닿아야 달성이다.** 기간 밖의 통과는 달성이 아니다.
      IF v_balance >= v_ch.target_equity
         AND p_event_effective_at >= v_ch.starts_at
         AND p_event_effective_at <= v_ch.ends_at THEN
        v_intent := 'TARGET_REACHED';
      ELSIF v_ch.failure_equity IS NOT NULL AND v_balance <= v_ch.failure_equity THEN
        v_intent := 'FAILED';
      END IF;

      IF v_intent IS NOT NULL THEN
        UPDATE public.paper_challenges
           SET status                = 'CLOSING',
               close_intent          = v_intent,
               close_intent_at       = NOW(),
               close_intent_event_at = p_event_effective_at,
               updated_at            = NOW()
         WHERE id = v_challenge
           AND close_intent IS NULL;      -- CAS. 남이 먼저 정했으면 그대로 둔다

        IF FOUND THEN
          INSERT INTO public.paper_challenge_transitions
            (challenge_id, user_id, from_status, to_status, reason,
             transition_key, event_effective_at)
          VALUES
            (v_challenge, v_owner, v_ch.status, 'CLOSING', v_intent,
             'INTENT:' || v_challenge::TEXT, p_event_effective_at)
          ON CONFLICT ON CONSTRAINT paper_challenge_transitions_idem_key DO NOTHING;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT TRUE, v_owner, p_realized_pnl, p_pnl_pct;
END $$;

-- ══════════════════ ⑥ legacy 경로는 챌린지 계좌에서 멈춘다 ══════════════════
--
-- 이 두 함수에 원장 쓰기를 **덧붙이지 않는다.** 덧붙이면 돈의 정본 경로가
-- 다시 여러 개가 된다. 챌린지 계좌를 지목하면 거부하고, 기본 계좌 동작은
-- 그대로 둔다.
CREATE OR REPLACE FUNCTION public.paper_deposit(
  p_user_id          UUID,
  p_amount           NUMERIC,
  p_paper_account_id UUID DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
AS $$
DECLARE
  v_account UUID;
  v_balance NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'paper_deposit: 입금액이 0 이하입니다 (%)', p_amount;
  END IF;

  SELECT a.id INTO v_account
    FROM public.paper_accounts a
   WHERE a.user_id = p_user_id
     AND (CASE WHEN p_paper_account_id IS NULL THEN a.is_default
               ELSE a.id = p_paper_account_id END);

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'paper_deposit: 계좌를 찾지 못했습니다';
  END IF;

  IF public.paper_is_challenge_account(v_account) THEN
    RAISE EXCEPTION
      'paper_deposit: 챌린지 전용 계좌입니다 (%) — 챌린지 잔고는 챌린지 회계 경로로만 움직입니다',
      v_account;
  END IF;

  UPDATE public.paper_accounts
     SET balance         = balance         + p_amount,
         initial_balance = initial_balance + p_amount,
         updated_at      = NOW()
   WHERE id = v_account
  RETURNING balance INTO v_balance;

  RETURN v_balance;
END $$;

CREATE OR REPLACE FUNCTION public.paper_apply_entry_fee(
  p_user_id          UUID,
  p_entry_fee        NUMERIC,
  p_paper_account_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE v_account UUID;
BEGIN
  SELECT a.id INTO v_account
    FROM public.paper_accounts a
   WHERE a.user_id = p_user_id
     AND (CASE WHEN p_paper_account_id IS NULL THEN a.is_default
               ELSE a.id = p_paper_account_id END);

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'paper_apply_entry_fee: 계좌를 찾지 못했습니다';
  END IF;

  IF public.paper_is_challenge_account(v_account) THEN
    RAISE EXCEPTION
      'paper_apply_entry_fee: 챌린지 전용 계좌입니다 (%) — 챌린지 수수료는 paper_open_position이 적습니다',
      v_account;
  END IF;

  UPDATE public.paper_accounts
     SET balance    = balance    - p_entry_fee,
         total_fees = total_fees + p_entry_fee,
         updated_at = NOW()
   WHERE id = v_account;
END $$;

-- ══════════════════ 권한 ══════════════════
--
-- 이 표들은 service_role만 쓸 수 있다(010의 정책). 함수도 같은 문을 쓴다 —
-- SECURITY DEFINER로 만들지 않는다. 만들면 authenticated가 남의 계좌를
-- 움직일 통로가 생긴다.
REVOKE ALL ON FUNCTION public.paper_is_challenge_account(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_money_apply(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_challenge_create(UUID, NUMERIC, NUMERIC, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_settle_close(
  UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.paper_is_challenge_account(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_money_apply(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_challenge_create(UUID, NUMERIC, NUMERIC, NUMERIC, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_settle_close(
  UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TIMESTAMPTZ, UUID) TO service_role;
