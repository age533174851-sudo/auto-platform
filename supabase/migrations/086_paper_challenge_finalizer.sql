-- 086_paper_challenge_finalizer.sql
--
-- **챌린지를 끝까지 자동으로 닫는다 — 그리고 끝나는 순간을 누가 정하는지 고정한다.**
--
-- `083`이 자리를 만들고 `085`가 돈 경로를 만들었다. 그런데 `READY → RUNNING →
-- CLOSING → CLOSED`를 실제로 밀고 가는 실행자가 **하나도 없었다.** `083`이 만든
-- `paper_challenges_due_idx`·`paper_challenges_closing_idx`는 아무도 읽지 않았다.
--
-- 이 파일이 만드는 것
-- ───────────────────
--   · 사건 시각 신선도 계약           paper_event_time_guard
--   · 만료 자격 판정                  paper_challenge_expiry_eligible
--   · 활성화·만료 스윕                paper_challenge_sweep_due
--   · 마감                            paper_challenge_finalize
--   · 진입 상태 계약                  paper_open_position (RUNNING에서만)
--   · 원장 사건 시각 불변             paper_challenge_cashflows 트리거
--
-- ══════════════════════════════════════════════════════════════════
--  왜 신선도 계약이 필요한가 — 실제로 재현한 고장
-- ══════════════════════════════════════════════════════════════════
--
-- 만료는 **관측 시각**으로 판단하고, 달성은 **사건 시각**으로 판단한다. 두
-- 순서는 어긋날 수 있다. 사건 시각은 앱이 RPC를 부르기 **전에** 찍고, 그 뒤
-- 잠금을 기다리기 때문이다.
--
-- 빈 DB에 083·084·085를 올려 실제로 재현했다:
--
--   settle_event_at = 11:59:59   (ends_at 12:00:00 이내)
--   만료 확정(관측 T+10s)        → status=CLOSING  intent=EXPIRED
--   선-스탬프된 정산 도착        → settled=true
--   최종                          balance=1300  target=1200  intent=EXPIRED
--
-- **잔고가 목표를 넘겼고 사건 시각도 기간 안인데 EXPIRED로 굳었다.**
-- `083`이 DB 제약으로까지 지키려 한 "TARGET_REACHED는 되돌릴 수 없다"가
-- 사건이 기록되기도 전에 깨진 것이다.
--
-- 중재 규칙 — 같은 상수 L 하나로 양쪽을 묶는다
-- ────────────────────────────────────────────
--
--   정산 허용   clock_timestamp() <= event_effective_at + L
--   만료 자격   clock_timestamp() >  ends_at            + L
--
-- 그러면 `event_effective_at <= ends_at`인 사건에 대해, 만료가 가능한 시점에는
-- 반드시
--
--   clock_timestamp() > ends_at + L >= event_effective_at + L
--
-- 이므로 그 옛 정산은 신선도에서 **거부된다.** 경계(`=`)에서 둘 다 가능해지지
-- 않도록 한쪽은 `<=`, 한쪽은 `>`로 고정한다 — 이 부등식 자체가 계약이고,
-- 검사기·실행 증명·뮤테이션이 이것을 지킨다.
--
-- **NOW()를 쓰지 않는다**
-- ───────────────────────
-- `now()`/`CURRENT_TIMESTAMP`는 **트랜잭션 시작 시각**으로 고정된다. 잠금을
-- 오래 기다린 트랜잭션은 옛 현재시각으로 신선도를 통과한다 — 검사가 초록인
-- 채로 방금 막은 고장이 그대로 되살아난다. 중재에 쓰는 현재시각은 전부
-- `clock_timestamp()`다.
--
-- **잠금을 다 잡은 뒤에 본다**
-- ───────────────────────────
-- 신선도 검사는 `paper_accounts → paper_challenges`를 모두 잠근 **뒤**에
-- 수행한다. 잠금 전에 보면 기다리는 동안 시각이 낡고, 비교가 만료와 같은
-- 직렬화 안에서 일어나지 않는다.
--
-- **챌린지 계좌에만 적용한다**
-- ───────────────────────────
-- 일반 모의 계좌의 진입·청산 동작은 바이트 단위로 그대로다. 넓게 걸면 이득
-- 없는 새 실패 모드가 legacy 경로에 생긴다.
--
-- 거부된 정산은 어떻게 되는가
-- ───────────────────────────
-- 한 줄도 쓰지 않고 되돌아간다(22008). 그 사건은 **그 사건 그대로 끝난 것**
-- 이다. 다음 스윕이 다시 청산한다면 그것은 새 서버 동작이고 자기 시각을
-- 갖는다. 이미 적힌 원장 행의 시각을 나중에 덮어쓰는 일은 아래 트리거가
-- 막는다 — "같은 사건에 다른 시각"은 저장될 수 없다.
--
-- 잠금 순서
-- ─────────
-- 이 파일의 모든 경로가 `paper_accounts → paper_challenges → paper_positions`다.
-- 챌린지부터 잠그는 경로를 만들지 않는다 — `paper_settle_close`가 계좌를 쥐고
-- 챌린지를 기다리므로, 반대로 잡는 순간 순환이 생긴다.
--
-- 위험도
-- ──────
-- 더하기만 한다(ADDITIVE). `DROP FUNCTION`이 없다 — 두 함수는 시그니처가
-- 그대로라 `CREATE OR REPLACE`로 대체된다. 즉 **머지되면 자동 적용된다.**
-- 그래서 증명이 머지 전에 끝나야 한다.

-- ══════════════════ ① 시각 계약의 상수 — 한 곳에서만 정한다 ══════════════════
--
-- 신선도와 만료 유예가 **같은 값**을 읽어야 위 부등식이 성립한다. 두 곳에
-- 적으면 언젠가 한쪽만 바뀌고, 그 순간 재현한 고장이 돌아온다.
CREATE OR REPLACE FUNCTION public.paper_event_max_lag()
RETURNS INTERVAL
LANGUAGE sql
IMMUTABLE
AS $$ SELECT INTERVAL '60 seconds' $$;

COMMENT ON FUNCTION public.paper_event_max_lag() IS
  '사건 시각이 실제 현재시각보다 얼마나 오래될 수 있는가(L). 정산 신선도와 '
  '만료 유예가 이 값 하나를 함께 쓴다 — 두 곳에 적으면 중재가 깨진다.';

-- 시계 어긋남으로 아주 조금 미래인 값은 받는다. 그 이상은 받지 않는다.
CREATE OR REPLACE FUNCTION public.paper_event_max_ahead()
RETURNS INTERVAL
LANGUAGE sql
IMMUTABLE
AS $$ SELECT INTERVAL '5 seconds' $$;

-- ══════════════════ ② 사건 시각 신선도 ══════════════════
--
-- **현재시각을 인자로 받지 않는다.** 받으면 부르는 쪽이 옛 시각을 넘겨
-- 검사를 통과시킬 수 있다. 여기서 `clock_timestamp()`로 직접 읽는다.
-- 부등식만 떼어 낸 순수 비교. **경계를 실행해서 볼 수 있게** 하려고 나눴다.
--
-- 실제 시계는 늘 앞으로 가므로 `>`와 `>=`의 차이는 나노초 안에서만 다르고,
-- `clock_timestamp()`를 안에서 읽는 함수로는 그 차이를 시험할 수 없다. 두
-- 시각을 **받는** 함수로 두면 정확히 같은 순간을 만들어 볼 수 있다.
--
-- 이 함수로 시각을 속일 수는 없다 — 불리언을 돌려줄 뿐이고, 실제 관문인
-- `paper_event_time_guard`는 자기가 `clock_timestamp()`를 읽는다.
CREATE OR REPLACE FUNCTION public.paper_event_time_fresh(
  p_event_at TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$ SELECT p_now <= p_event_at + public.paper_event_max_lag() $$;

CREATE OR REPLACE FUNCTION public.paper_challenge_expiry_due(
  p_ends_at TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$ SELECT p_now > p_ends_at + public.paper_event_max_lag() $$;

COMMENT ON FUNCTION public.paper_event_time_fresh(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '사건이 아직 신선한가: now <= event + L. 만료의 now > ends + L과 짝이라 '
  '경계에서 둘 다 참이 되지 않는다 — 같은 순간을 넣어 실행해서 볼 수 있다.';
COMMENT ON FUNCTION public.paper_challenge_expiry_due(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '만료를 확정해도 되는가: now > ends + L. 신선도의 <=와 짝이다.';

CREATE OR REPLACE FUNCTION public.paper_event_time_guard(p_event_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();   -- **now()가 아니다** (머리말 참고)
BEGIN
  IF p_event_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22004',
      MESSAGE = 'paper_event_time_guard: 사건 시각이 없습니다';
  END IF;

  -- 허용: clock_timestamp() <= event + L      (경계 포함)
  IF NOT public.paper_event_time_fresh(p_event_at, v_now) THEN
    RAISE EXCEPTION USING ERRCODE = '22008',
      MESSAGE = format('사건 시각이 너무 오래됐습니다 (%s, 허용 %s)'
                       ' — 이 사건으로는 돈을 움직이지 않습니다',
                       p_event_at, public.paper_event_max_lag());
  END IF;

  IF p_event_at > v_now + public.paper_event_max_ahead() THEN
    RAISE EXCEPTION USING ERRCODE = '22008',
      MESSAGE = format('사건 시각이 미래입니다 (%s)', p_event_at);
  END IF;
END $$;

COMMENT ON FUNCTION public.paper_event_time_guard(TIMESTAMPTZ) IS
  '사건 시각이 실제 현재시각 기준으로 신선한가. clock_timestamp()를 직접 '
  '읽는다 — now()는 트랜잭션 시작 시각이라 잠금을 오래 기다린 트랜잭션이 '
  '옛 시각으로 통과한다. 부르는 쪽은 계좌·챌린지를 모두 잠근 뒤에 부른다.';

-- ══════════════════ ③ 만료 자격 ══════════════════
--
-- `>`다. 신선도가 `<=`이므로 경계에서 둘 다 가능해지지 않는다.
CREATE OR REPLACE FUNCTION public.paper_challenge_expiry_eligible(p_ends_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_ends_at IS NULL THEN
    RETURN FALSE;                      -- 끝 시각을 모르면 만료시키지 않는다
  END IF;
  RETURN public.paper_challenge_expiry_due(p_ends_at, v_now);
END $$;

COMMENT ON FUNCTION public.paper_challenge_expiry_eligible(TIMESTAMPTZ) IS
  '만료를 확정해도 되는가. clock_timestamp() > ends_at + L. 신선도의 <=와 '
  '짝이라 경계에서 옛 정산과 만료가 동시에 가능해지지 않는다.';

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
  UPDATE public.paper_accounts
     SET total_pnl   = total_pnl   + p_realized_pnl,
         total_fees  = total_fees  + p_exit_fee,
         trade_count = trade_count + 1,
         win_count   = win_count   + CASE WHEN p_realized_pnl > 0 THEN 1 ELSE 0 END
   WHERE id = v_account;

  -- ⑧ 판정. **진입 경로와 같은 함수를 부른다** — 판정이 두 곳에 있으면 갈린다.
  PERFORM public.paper_challenge_judge(
    v_challenge, v_account, v_owner, p_event_effective_at);

  RETURN QUERY SELECT TRUE, v_owner, p_realized_pnl, p_pnl_pct;
END $$;

-- ══════════════════ ⑥ 원장 사건 시각은 바뀌지 않는다 ══════════════════
--
-- 신선도에 걸려 거부된 정산은 한 줄도 쓰지 않는다. 그러니 "같은 사건에
-- 다른 시각"이 생길 자리는 원래 없다 — 그런데 그 사실을 코드 규율이 아니라
-- **DB가** 지키게 한다. 운영 수리·수동 UPDATE·앞으로 생길 경로는 규율을
-- 지나가지 않는다.
--
-- `083`이 `close_intent`에 한 것과 같은 장치다. 행 단위 CHECK는 이전 값을
-- 볼 수 없어서, 이전 값을 볼 수 있는 유일한 자리인 BEFORE UPDATE로 막는다.
CREATE OR REPLACE FUNCTION public.paper_challenge_cashflows_freeze_event_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.event_effective_at IS DISTINCT FROM OLD.event_effective_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('원장 사건 시각은 바꿀 수 없습니다 (%s → %s)',
                       OLD.event_effective_at, NEW.event_effective_at),
      HINT = '같은 사건에 다른 시각을 적을 수 없습니다. 새 행동이면 새 사건으로 적으세요';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.paper_challenge_cashflows_freeze_event_at() IS
  '원장 한 줄의 사건 시각을 처음 적힌 값으로 고정한다. 재시도가 옛 사건의 '
  '시각을 자기 시각으로 덮는 일을 DB가 막는다. 회계를 하지 않는다.';

DROP TRIGGER IF EXISTS paper_challenge_cashflows_freeze_trg
  ON public.paper_challenge_cashflows;
CREATE TRIGGER paper_challenge_cashflows_freeze_trg
  BEFORE UPDATE ON public.paper_challenge_cashflows
  FOR EACH ROW
  EXECUTE FUNCTION public.paper_challenge_cashflows_freeze_event_at();

-- ══════════════════ ⑦ 활성화·만료 스윕 ══════════════════
--
-- 잠금 순서를 지키려고 **계좌를 먼저** 잡는다. 어느 계좌인지 알려면 먼저
-- 읽어야 하므로, 잠그지 않고 읽은 뒤 계좌를 잠그고 **챌린지를 다시 읽는다**
-- (`paper_settle_close`와 같은 모양). 그 사이에 바뀐 것은 다시 읽은 값이
-- 말해 준다.
--
-- 판정 시각은 전부 잠금을 잡은 **뒤** `clock_timestamp()`다.
--
-- 반환 칸 이름을 `challenge`·`account`·`owner`·`action`으로 둔 이유
-- ─────────────────────────────────────────────────────────────────
-- `084`가 고친 고장이 "반환 칸 이름이 표의 칸 이름과 겹쳐 실행 시점에
-- 42702"였다. 여기서는 겹칠 이름(`status`·`user_id`·`challenge_id`)을
-- 아예 쓰지 않는다. 읽는 칸은 전부 표 이름으로 한정한다.
CREATE OR REPLACE FUNCTION public.paper_challenge_sweep_due()
RETURNS TABLE (
  challenge UUID,
  account   UUID,
  owner     UUID,
  action    TEXT          -- STARTED | EXPIRED
)
LANGUAGE plpgsql
AS $$
DECLARE
  r        RECORD;
  v_locked UUID;
  v_ch     RECORD;
  v_now    TIMESTAMPTZ;
BEGIN
  FOR r IN
    SELECT c.id AS cid, c.paper_account_id AS acct
      FROM public.paper_challenges c
     WHERE c.status IN ('READY', 'RUNNING')
     ORDER BY c.ends_at
  LOOP
    -- ① 계좌 (잠금 순서의 첫 자리)
    SELECT a.id INTO v_locked
      FROM public.paper_accounts a WHERE a.id = r.acct FOR UPDATE;
    IF v_locked IS NULL THEN
      CONTINUE;                        -- 계좌가 사라졌다. 추측하지 않는다
    END IF;

    -- ② 챌린지 — 잠그고 **다시 읽는다**
    SELECT c.id AS cid, c.user_id AS uid, c.status AS st,
           c.starts_at AS s_at, c.ends_at AS e_at, c.close_intent AS intent
      INTO v_ch
      FROM public.paper_challenges c WHERE c.id = r.cid FOR UPDATE;
    IF v_ch.cid IS NULL THEN
      CONTINUE;
    END IF;

    v_now := clock_timestamp();        -- **잠금을 잡은 뒤의 실제 현재시각**

    IF v_ch.st IN ('READY', 'RUNNING')
       AND v_ch.intent IS NULL
       AND public.paper_challenge_expiry_eligible(v_ch.e_at) THEN
      -- ── 만료 ──
      --    사건 시각은 `ends_at` 그 자체다. 스윕이 늦게 돌아도 기록이 밀리지
      --    않고, 재시도해도 같은 값이다.
      UPDATE public.paper_challenges c
         SET status                = 'CLOSING',
             close_intent          = 'EXPIRED',
             close_intent_at       = v_now,
             close_intent_event_at = v_ch.e_at,
             updated_at            = v_now
       WHERE c.id = v_ch.cid
         AND c.close_intent IS NULL;   -- CAS. judge가 먼저 정했으면 그대로 둔다

      IF FOUND THEN
        -- **judge와 같은 키를 쓴다.** 새 키를 만들면 CLOSING 로그가 두 줄이 된다.
        INSERT INTO public.paper_challenge_transitions
          (challenge_id, user_id, from_status, to_status, reason,
           transition_key, event_effective_at)
        VALUES
          (v_ch.cid, v_ch.uid, v_ch.st, 'CLOSING', 'EXPIRED',
           'INTENT:' || v_ch.cid::TEXT, v_ch.e_at)
        ON CONFLICT ON CONSTRAINT paper_challenge_transitions_idem_key DO NOTHING;

        challenge := v_ch.cid; account := r.acct; owner := v_ch.uid;
        action := 'EXPIRED';
        RETURN NEXT;
      END IF;

    ELSIF v_ch.st = 'READY' AND v_ch.s_at <= v_now THEN
      -- ── 활성화 ──
      --    사건 시각은 `starts_at` 그 자체다(만료와 같은 이유).
      UPDATE public.paper_challenges c
         SET status = 'RUNNING', updated_at = v_now
       WHERE c.id = v_ch.cid
         AND c.status = 'READY';

      IF FOUND THEN
        INSERT INTO public.paper_challenge_transitions
          (challenge_id, user_id, from_status, to_status, reason,
           transition_key, event_effective_at)
        VALUES
          (v_ch.cid, v_ch.uid, 'READY', 'RUNNING', '기간 시작',
           'START:' || v_ch.cid::TEXT, v_ch.s_at)
        ON CONFLICT ON CONSTRAINT paper_challenge_transitions_idem_key DO NOTHING;

        challenge := v_ch.cid; account := r.acct; owner := v_ch.uid;
        action := 'STARTED';
        RETURN NEXT;
      END IF;
    END IF;
  END LOOP;

  RETURN;
END $$;

COMMENT ON FUNCTION public.paper_challenge_sweep_due() IS
  'starts_at 도달은 RUNNING으로, ends_at + L 경과는 CLOSING(EXPIRED)로 민다. '
  '계좌 → 챌린지 순으로 잠근 뒤 clock_timestamp()로 판정한다. 만료 사건 '
  '시각은 ends_at, 활성화는 starts_at — 늦게 돌아도 기록이 밀리지 않는다.';

-- ══════════════════ ⑧ 마감 ══════════════════
--
-- **여기서 돈을 만들지 않는다.** 잔고를 고치지도, 원장을 적지도 않는다.
-- 청산은 이미 `paper_settle_close`가 했고, 이 함수는 그 결과를 확인하고
-- 상태만 확정한다.
--
-- 사유를 다시 판단하지 않는다 — 동결된 `close_intent`를 그대로 옮긴다.
-- 마지막 잔고를 보고 판단하면 `083`의 제약이 거부한다.
--
-- 반환 칸 이름에 `balance`를 쓰지 않는다(`paper_accounts.balance`와 겹친다).
CREATE OR REPLACE FUNCTION public.paper_challenge_finalize(p_challenge UUID)
RETURNS TABLE (
  finalized       BOOLEAN,
  code            TEXT,     -- CLOSED | NO_CHALLENGE | NOT_CLOSING | POSITIONS_OPEN
                            -- | RECONCILE_MISMATCH | LOST_RACE
  open_count      INT,
  ledger          NUMERIC,
  account_balance NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_acct   UUID;
  v_locked UUID;
  v_bal    NUMERIC;
  v_ch     RECORD;
  v_open   INT;
  v_ledger NUMERIC;
  v_now    TIMESTAMPTZ;
BEGIN
  -- ① 잠그지 않고 읽는다 — 어느 계좌를 잠글지 알기 위해서만.
  SELECT c.paper_account_id INTO v_acct
    FROM public.paper_challenges c WHERE c.id = p_challenge;
  IF v_acct IS NULL THEN
    RETURN QUERY SELECT FALSE, 'NO_CHALLENGE'::TEXT, NULL::INT, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- ② 계좌 → ③ 챌린지. **이 순서를 뒤집으면 정산과 순환이 생긴다.**
  SELECT a.id, a.balance INTO v_locked, v_bal
    FROM public.paper_accounts a WHERE a.id = v_acct FOR UPDATE;
  IF v_locked IS NULL THEN
    RAISE EXCEPTION 'paper_challenge_finalize: 계좌가 없습니다 (%)', v_acct;
  END IF;

  SELECT c.id AS cid, c.user_id AS uid, c.status AS st, c.close_intent AS intent
    INTO v_ch
    FROM public.paper_challenges c WHERE c.id = p_challenge FOR UPDATE;

  IF v_ch.st IS DISTINCT FROM 'CLOSING' THEN
    -- 남이 이미 끝냈거나 아직 정리 대상이 아니다. **실패가 아니다.**
    RETURN QUERY SELECT FALSE, 'NOT_CLOSING'::TEXT, NULL::INT, NULL::NUMERIC, v_bal;
    RETURN;
  END IF;

  -- ④ 포지션 0. **계좌 잠금을 쥔 채로 센다** — 그래야 세는 사이에 늘지 않는다.
  SELECT COUNT(*)::INT INTO v_open
    FROM public.paper_positions pp
   WHERE pp.paper_account_id = v_acct AND pp.status = 'open';

  IF v_open > 0 THEN
    -- 아직 못 닫았다. **CLOSING을 유지한다** — 다음 회차가 다시 집는다.
    RETURN QUERY SELECT FALSE, 'POSITIONS_OPEN'::TEXT, v_open, NULL::NUMERIC, v_bal;
    RETURN;
  END IF;

  -- ⑤ 원장 ↔ 잔고. 어긋나면 **끝났다고 적지 않는다.**
  SELECT COALESCE(SUM(f.amount), 0) INTO v_ledger
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = p_challenge;

  IF v_ledger IS DISTINCT FROM v_bal THEN
    RETURN QUERY SELECT FALSE, 'RECONCILE_MISMATCH'::TEXT, 0, v_ledger, v_bal;
    RETURN;
  END IF;

  -- ⑥ CAS. 두 finalizer가 붙어도 한 번만 닫힌다.
  v_now := clock_timestamp();
  UPDATE public.paper_challenges c
     SET status          = 'CLOSED',
         terminal_status = c.close_intent,   -- **동결된 사유를 그대로 옮긴다**
         closed_at       = v_now,
         updated_at      = v_now
   WHERE c.id = p_challenge
     AND c.status = 'CLOSING';

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'LOST_RACE'::TEXT, 0, v_ledger, v_bal;
    RETURN;
  END IF;

  INSERT INTO public.paper_challenge_transitions
    (challenge_id, user_id, from_status, to_status, reason,
     transition_key, event_effective_at)
  VALUES
    (p_challenge, v_ch.uid, 'CLOSING', 'CLOSED', v_ch.intent,
     'CLOSED:' || p_challenge::TEXT, v_now)
  ON CONFLICT ON CONSTRAINT paper_challenge_transitions_idem_key DO NOTHING;

  RETURN QUERY SELECT TRUE, 'CLOSED'::TEXT, 0, v_ledger, v_bal;
END $$;

COMMENT ON FUNCTION public.paper_challenge_finalize(UUID) IS
  'CLOSING을 CLOSED로 확정한다. 돈을 만들지 않는다 — 잔고도 원장도 쓰지 '
  '않는다. 계좌 → 챌린지 순으로 잠그고, 열린 포지션 0과 원장·잔고 일치를 '
  '확인한 뒤 CAS로 닫는다. terminal_status는 동결된 close_intent의 복사다.';

-- ══════════════════ ⑨ 마감이 셀 것을 빨리 세게 한다 ══════════════════
CREATE INDEX IF NOT EXISTS paper_positions_account_open_idx
  ON public.paper_positions (paper_account_id)
  WHERE status = 'open';
