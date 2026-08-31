-- 074: 모의 진입과 진입 수수료를 **한 트랜잭션**으로 묶는다
--
-- 072가 청산 쪽을 닫았고, 같은 문서에 이렇게 적어 두었다:
--
--   "다만 이 함수는 포지션 INSERT까지 묶지는 않는다. (…) 남은 것은
--    보고에 적는다."
--
-- 그 남은 것이 이것이다. 지금까지 진입은 두 단계였다:
--
--   ① paper_positions  INSERT
--   ② paper_apply_entry_fee  RPC (balance −= fee, total_fees += fee)
--
-- 서로 다른 트랜잭션이라 ②만 실패할 수 있다. 그러면:
--
--   · 포지션은 존재하고 그 줄에 entry_fee가 적혀 있는데
--   · 계좌 balance는 수수료만큼 **영구히 높게** 남고
--   · total_fees는 낮게 남는다
--
-- 그리고 수익률은 `(balance − initial) / initial`로 나온다. 즉 한 번
-- 어긋나면 **그 뒤의 모든 수익률과 다음 주문 크기가 그 위에서 계산된다.**
-- 한 건의 오차는 작지만 누적되고, 되돌릴 수 없고, 아무도 모른다 —
-- ②의 실패를 읽는 코드가 한 곳도 없었다.
--
-- 반대 방향(수수료만 빠지고 포지션 없음)은 순서상 일어날 수 없었다.
-- 즉 고장은 언제나 "장부가 실제보다 부자로 보이는" 쪽이었다.
--
-- ■ 무엇을 하는가
--
--   계좌 줄을 잠그고 → 중복을 보고 → 포지션을 넣고 → 수수료를 뺀다.
--   전부 한 함수 = 한 트랜잭션이다. 중간에 무엇이 실패하든 통째로
--   되돌아간다. **"포지션은 있는데 수수료는 안 빠짐"이 만들어질 수 없다.**
--
-- ■ 계좌 줄을 왜 잠그는가
--
--   동시에 두 건이 진입하면 수수료 차감이 서로 덮어쓸 수 있다. 072가
--   청산에서 겪은 것과 같은 고장이다. 잠금은 그 차례를 세우고, 동시에
--   **같은 신호의 두 호출도 한쪽만 통과하게** 만든다 — 뒤에 온 쪽은
--   잠금이 풀린 뒤에 이미 들어간 줄을 보게 된다.
--
--   갱신 자체도 `balance = balance - fee`로 SQL이 증가시킨다. 읽은 값을
--   애플리케이션이 계산해 덮어쓰지 않는다.
--
-- ■ 계좌를 만들지 않는다
--
--   071의 규칙 그대로다. 없으면 NO_ACCOUNT를 돌려주고 포지션도 넣지
--   않는다. 여기서 계좌를 만들면 "시작한 적 없는 계좌"가 거래로 생긴다.
--
-- ■ 금액을 계산하지 않는다
--
--   수량·명목가·증거금·수수료는 `paperExecution.simulateFill()`이 계산해
--   인자로 들어온다. 공식을 SQL에도 적으면 같은 판단이 두 곳에 생기고
--   언젠가 한쪽만 바뀐다. 이 함수가 보장하는 것은 **계산이 아니라
--   원자성**이다. 072와 같은 원칙이다.
--
-- ■ 중복은 signal_id 충돌만이다
--
--   010의 `paper_pos_signal_uniq`(signal_id IS NOT NULL)가 정본이다.
--   다른 유니크 위반까지 중복으로 삼키면, 진짜 고장이 "이미 체결됨"으로
--   조용히 사라진다.
--
-- ADDITIVE 전용이다. 표·칸을 만들지도 지우지도 않는다.

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
  p_margin_mode       TEXT
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
  v_constraint TEXT;
BEGIN
  IF p_entry_fee IS NULL OR p_entry_fee < 0 THEN
    RAISE EXCEPTION 'paper_open_position: 진입 수수료가 음수이거나 없습니다 (%)', p_entry_fee;
  END IF;

  -- ① 계좌 줄을 잠근다. 없으면 여기서 끝 — 만들지 않는다.
  SELECT user_id INTO v_account
    FROM public.paper_accounts
   WHERE user_id = p_user_id
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

  -- ③ 포지션
  INSERT INTO public.paper_positions (
    user_id, signal_id, strategy_id, bucket, symbol, market, side, status,
    entry_price, fill_price, quantity, notional, leverage, margin,
    stop_loss, take_profit, liquidation_price, entry_fee, margin_mode
  ) VALUES (
    p_user_id, p_signal_id, p_strategy_id, p_bucket, p_symbol,
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
   WHERE user_id = p_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- ①에서 잠근 줄이 사라졌다는 뜻이다. 포지션만 남기지 않는다.
    RAISE EXCEPTION
      'paper_open_position: 계좌를 정산하지 못했습니다 (갱신 %행) — 진입을 되돌립니다', v_rows;
  END IF;

  RETURN QUERY SELECT 'OPENED'::TEXT, v_id;

EXCEPTION
  WHEN unique_violation THEN
    -- **signal_id 충돌만 멱등 중복이다.** 다른 유니크 위반은 삼키지 않는다 —
    -- 삼키면 진짜 고장이 '이미 체결됨'으로 조용히 사라진다.
    --
    -- 어느 유니크가 깨졌는지는 **오류 문구를 읽어 판단하지 않는다.**
    -- `SQLERRM`은 사람이 읽는 문장이라 서버 버전·로케일·문구 변경에 따라
    -- 달라지고, 다른 인덱스 이름이 그 문장 안에 우연히 들어갈 수도 있다.
    -- 우리가 알고 싶은 것은 "문구에 그 이름이 있었나"가 아니라 **실제로
    -- 깨진 제약이 무엇인가**다. PostgreSQL이 그 값을 직접 준다.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

    IF p_signal_id IS NOT NULL AND v_constraint = 'paper_pos_signal_uniq' THEN
      SELECT id INTO v_existing
        FROM public.paper_positions
       WHERE signal_id = p_signal_id
       LIMIT 1;
      RETURN QUERY SELECT 'DUPLICATE'::TEXT, v_existing;
      RETURN;
    END IF;
    RAISE;
END;
$$;

-- 이 표들은 service_role만 쓸 수 있다(010의 정책). 함수도 같은 문을 쓴다 —
-- SECURITY DEFINER로 만들지 않는다. 만들면 authenticated가 남의 계좌를
-- 움직일 통로가 생긴다.
REVOKE ALL ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT
) TO service_role;

COMMENT ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT
) IS
  '모의 진입과 진입 수수료를 한 트랜잭션으로 처리한다. 포지션만 생기고 '
  '수수료가 빠지지 않는 상태를 만들 수 없다. 계좌는 만들지 않는다(071).';
