-- 082_paper_rpc_account_id.sql
--
-- **모의 계좌 RPC가 계좌를 지정받을 수 있게 한다.**
--
-- `081`이 계좌에 정체를 줬지만, RPC들은 아직 `WHERE user_id = ...`로 계좌를
-- 찾는다. 사용자당 계좌가 하나일 때는 그것이 곧 그 계좌였다. 이제 여럿이
-- 될 수 있으므로 그 질의는 **어느 계좌인지 말해 주지 못한다.**
--
-- 기존 호출을 깨지 않는다
-- ───────────────────────
-- 계좌를 지정하지 않은 호출은 **그 사용자의 기본 계좌**로 간다. 지금은
-- 계좌가 하나뿐이고 그것이 기본 계좌이므로 동작이 동일하다. 기존 제품
-- 코드는 한 줄도 고치지 않아도 된다.
--
-- 새 인자는 맨 뒤에 기본값으로 붙인다. 그래야 인자 수가 적은 기존 호출이
-- 그대로 맞는다.
--
-- 왜 DROP 후 CREATE인가
-- ─────────────────────
-- `CREATE OR REPLACE`는 **인자가 다르면 교체가 아니라 새 함수**를 만든다.
-- 그러면 같은 이름의 함수가 둘이 되고, 기본값 때문에 기존 인자 수의 호출이
-- **모호해져서 실패**한다. 그래서 옛 시그니처를 명시적으로 지우고 하나만
-- 남긴다.
--
-- 정산은 왜 인자가 없는가
-- ───────────────────────
-- 포지션이 `paper_account_id`를 들고 있으므로 정산은 그것을 따라가면 된다.
-- 호출부가 계좌를 다시 말해 줄 필요가 없고, 말해 준 값이 포지션과 다를
-- 위험도 없다.

-- ── 기본 계좌를 찾는 자리는 하나다 ──
--
-- 세 함수가 같은 판단을 하면 언젠가 갈린다.
CREATE OR REPLACE FUNCTION public.paper_default_account_id(p_user_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM public.paper_accounts
   WHERE user_id = p_user_id AND is_default
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.paper_default_account_id(UUID) IS
  '계좌를 지정하지 않은 경로가 갈 곳. 부분 유니크 인덱스가 사용자당 하나를 보장한다.';

-- ══════════════════ 진입 ══════════════════
DROP FUNCTION IF EXISTS public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION public.paper_open_position(
  p_user_id           UUID,
  p_signal_id         TEXT,
  p_strategy_id       TEXT,
  p_bucket            TEXT,
  p_symbol            TEXT,
  p_market            TEXT,
  p_side              TEXT,
  p_entry_price       NUMERIC,
  p_fill_price        NUMERIC,
  p_quantity          NUMERIC,
  p_notional          NUMERIC,
  p_leverage          INT,
  p_margin            NUMERIC,
  p_stop_loss         NUMERIC,
  p_take_profit       NUMERIC,
  p_liquidation_price NUMERIC,
  p_entry_fee         NUMERIC,
  p_margin_mode       TEXT,
  p_paper_account_id  UUID DEFAULT NULL
)
RETURNS TABLE (
  status      TEXT,      -- OPENED | DUPLICATE | NO_ACCOUNT
  position_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account    UUID;
  v_existing   UUID;
  v_id         UUID;
  v_rows       INT;
BEGIN
  IF p_entry_fee IS NULL OR p_entry_fee < 0 THEN
    RAISE EXCEPTION 'paper_open_position: 진입 수수료가 음수이거나 없습니다 (%)', p_entry_fee;
  END IF;

  -- ① 계좌 줄을 잠근다. 없으면 여기서 끝 — 만들지 않는다.
  --
  -- **소유자까지 함께 본다.** 남의 계좌 id를 넣어도 여기서 안 잡힌다.
  -- DB 복합 FK가 마지막 방어선이지만, 그 전에 사유가 분명한 자리에서
  -- 멈추는 편이 낫다.
  SELECT a.id INTO v_account
    FROM public.paper_accounts a
   WHERE a.user_id = p_user_id
     AND (CASE WHEN p_paper_account_id IS NULL THEN a.is_default
               ELSE a.id = p_paper_account_id END)
     FOR UPDATE;

  IF v_account IS NULL THEN
    RETURN QUERY SELECT 'NO_ACCOUNT'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- ② 같은 신호는 한 번만. 잠금을 쥔 채로 보므로 동시 호출도 한쪽만 넣는다.
  IF p_signal_id IS NOT NULL THEN
    SELECT id INTO v_existing
      FROM public.paper_positions
     WHERE signal_id = p_signal_id
     LIMIT 1;
    IF v_existing IS NOT NULL THEN
      RETURN QUERY SELECT 'DUPLICATE'::TEXT, v_existing;
      RETURN;
    END IF;
  END IF;

  -- ③ 포지션. **자기 계좌를 들고 태어난다.**
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

  -- ④ 수수료. **읽고 고쳐 쓰지 않는다** — SQL이 증가시킨다.
  UPDATE public.paper_accounts
     SET balance    = balance    - p_entry_fee,
         total_fees = total_fees + p_entry_fee,
         updated_at = NOW()
   WHERE id = v_account;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- ①에서 잠근 줄이 사라졌다는 뜻이다. 포지션만 남기지 않는다.
    RAISE EXCEPTION
      'paper_open_position: 계좌를 정산하지 못했습니다 (갱신 %행) — 진입을 되돌립니다', v_rows;
  END IF;

  RETURN QUERY SELECT 'OPENED'::TEXT, v_id;
END $$;

-- ══════════════════ 청산 정산 ══════════════════
--
-- 인자는 그대로다. 계좌는 포지션이 들고 있는 것을 따라간다.
CREATE OR REPLACE FUNCTION public.paper_settle_close(
  p_position_id  UUID,
  p_exit_price   NUMERIC,
  p_exit_reason  TEXT,
  p_exit_fee     NUMERIC,
  p_gross_pnl    NUMERIC,
  p_realized_pnl NUMERIC,
  p_pnl_pct      NUMERIC
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
  v_owner    UUID;
  v_account  UUID;
  v_accounts INT;
BEGIN
  -- ① 선점. status='open'인 줄만 바뀐다.
  UPDATE public.paper_positions
     SET status       = 'closed',
         exit_price   = p_exit_price,
         exit_reason  = p_exit_reason,
         exit_fee     = p_exit_fee,
         gross_pnl    = p_gross_pnl,
         realized_pnl = p_realized_pnl,
         pnl_pct      = p_pnl_pct,
         closed_at    = NOW()
   WHERE id = p_position_id
     AND status = 'open'
  RETURNING user_id, paper_account_id INTO v_owner, v_account;

  IF v_owner IS NULL THEN
    -- 없거나, 이미 다른 실행기가 닫았다. **계좌를 건드리지 않는다.**
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- 계좌를 안 들고 있는 옛 줄은 그 사용자의 기본 계좌로 간다.
  -- `081` 이전에 열린 포지션이 그렇다.
  IF v_account IS NULL THEN
    v_account := public.paper_default_account_id(v_owner);
  END IF;

  -- ② 정산. 읽지 않고 **증가시킨다.**
  UPDATE public.paper_accounts
     SET balance     = balance     + p_gross_pnl - p_exit_fee,
         total_pnl   = total_pnl   + p_realized_pnl,
         total_fees  = total_fees  + p_exit_fee,
         trade_count = trade_count + 1,
         win_count   = win_count   + CASE WHEN p_realized_pnl > 0 THEN 1 ELSE 0 END,
         updated_at  = NOW()
   WHERE id = v_account;

  GET DIAGNOSTICS v_accounts = ROW_COUNT;

  IF v_accounts <> 1 THEN
    -- **여기서 예외를 던지면 ①까지 되돌아간다.** 포지션은 열린 채로
    -- 남고, 다음 회차가 다시 집는다.
    RAISE EXCEPTION
      'paper_settle_close: 계좌를 정산하지 못했습니다 (갱신 %행) — 청산을 되돌립니다', v_accounts;
  END IF;

  RETURN QUERY SELECT TRUE, v_owner, p_realized_pnl, p_pnl_pct;
END $$;

-- ══════════════════ 수수료 · 입금 ══════════════════
DROP FUNCTION IF EXISTS public.paper_apply_entry_fee(UUID, NUMERIC);

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

  UPDATE public.paper_accounts
     SET balance    = balance    - p_entry_fee,
         total_fees = total_fees + p_entry_fee,
         updated_at = NOW()
   WHERE id = v_account;
END $$;

DROP FUNCTION IF EXISTS public.paper_deposit(UUID, NUMERIC);

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

  UPDATE public.paper_accounts
     SET balance         = balance         + p_amount,
         initial_balance = initial_balance + p_amount,
         updated_at      = NOW()
   WHERE id = v_account
  RETURNING balance INTO v_balance;

  RETURN v_balance;
END $$;

-- ══════════════════ 권한 ══════════════════
REVOKE ALL ON FUNCTION public.paper_default_account_id(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_apply_entry_fee(UUID, NUMERIC, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_deposit(UUID, NUMERIC, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.paper_default_account_id(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_apply_entry_fee(UUID, NUMERIC, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_deposit(UUID, NUMERIC, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) TO service_role;
