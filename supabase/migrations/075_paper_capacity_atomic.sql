-- 075: 모의 진입의 **최종 가용 증거금 검사**를 진입 트랜잭션 안으로
--
-- 074가 진입과 수수료를 한 트랜잭션으로 묶었다. 이 마이그레이션은 그
-- 트랜잭션 **안에** 검사 하나를 더 넣는다. 074의 계약은 전부 유지한다 —
-- 잠금 · NO_ACCOUNT · signal_id 멱등 · CONSTRAINT_NAME 기반 중복 판정 ·
-- 포지션과 수수료의 원자성 · service_role 전용 · SECURITY DEFINER 아님.
--
-- ■ 왜 애플리케이션 검사만으로는 부족한가
--
--   `/api/paper/order`도, `buildRiskContext`도 진입 전에 가용 증거금을
--   본다. 그런데 그것은 **읽는 시점의 사실**이다. 자동 신호 두 개가 동시에
--   들어오면 둘 다 같은 잔고를 보고 둘 다 통과한다:
--
--     잔고 1,000 · 사용 중 0
--       신호 A 필요 증거금 600 → 가용 1,000 → 통과
--       신호 B 필요 증거금 600 → 가용 1,000 → 통과
--       합계 1,200 > 1,000
--
--   앱에서 잠금을 흉내 내도 프로세스가 여러 개면 소용이 없다. 계좌 줄을
--   잠근 트랜잭션만이 차례를 세울 수 있다. 그래서 **앱 검사는 안내이고,
--   이 함수가 최종 권한이다.**
--
--   074가 이미 `FOR UPDATE`로 계좌를 잡고 있으므로, 검사를 넣을 자리는
--   이미 마련돼 있다. B는 A가 커밋한 뒤에 잠금을 얻고, 그때는 사용 중
--   증거금이 600으로 보인다.
--
-- ■ 수수료를 빼먹으면 안 된다
--
--   진입 수수료는 **같은 트랜잭션에서 잔고에서 빠진다.** 증거금만 보면
--   체결 직후 잔고가 물고 있는 증거금보다 작아질 수 있다:
--
--     잔고 100 · 기존 증거금 90 · 새 증거금 10 · 수수료 0.1
--       증거금만: 90 + 10 <= 100  → 통과
--       체결 뒤 : 잔고 99.9  물고 있는 증거금 100  → 어긋난다
--
--   그래서 조건은 `used + margin + fee <= balance`다.
--
-- ■ 중복 검사가 용량 검사보다 **앞**이다
--
--   이미 성공한 신호를 재시도했는데 그 사이 잔고가 줄었다면, 답은
--   DUPLICATE여야 한다. INSUFFICIENT_MARGIN으로 바뀌면 같은 요청이 때마다
--   다른 답을 내고 멱등이 아니게 된다.
--
-- ■ 이 함수가 계산하는 것은 용량뿐이다
--
--   증거금·수수료는 `paperExecution.simulateFill()`이 계산해 인자로
--   들어온다(074와 같은 원칙). SQL이 답하는 질문은 하나다 —
--   **지금 장부에 이 증거금을 더 예약할 공간이 있는가.**
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
  v_rows       INT;
  v_constraint TEXT;
BEGIN
  IF p_entry_fee IS NULL OR p_entry_fee < 0 THEN
    RAISE EXCEPTION 'paper_open_position: 진입 수수료가 음수이거나 없습니다 (%)', p_entry_fee;
  END IF;
  IF p_margin IS NULL OR p_margin < 0 THEN
    RAISE EXCEPTION 'paper_open_position: 필요 증거금이 음수이거나 없습니다 (%)', p_margin;
  END IF;

  -- ① 계좌 줄을 잠근다. 없으면 여기서 끝 — 만들지 않는다.
  --    잔고도 이때 함께 읽는다. 잠금 밖에서 읽으면 검사와 갱신 사이가 벌어진다.
  SELECT user_id, balance INTO v_account, v_balance
    FROM public.paper_accounts
   WHERE user_id = p_user_id
     FOR UPDATE;

  IF v_account IS NULL THEN
    RETURN QUERY SELECT 'NO_ACCOUNT'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- ② 같은 신호는 한 번만. 잠금을 쥔 채로 보므로 동시 호출도 한쪽만 넣는다.
  --
  --    **용량 검사보다 앞이다.** 이미 성공한 신호의 재시도는 그 사이 잔고가
  --    줄었더라도 DUPLICATE여야 한다 — 그게 멱등이다.
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

  -- ③ 가용 증거금 — **잠근 상태에서 보는 이 값이 최종이다**
  SELECT COALESCE(SUM(margin), 0) INTO v_used
    FROM public.paper_positions
   WHERE user_id = p_user_id
     AND status = 'open';

  IF v_used + p_margin + p_entry_fee > v_balance THEN
    -- 포지션도 수수료도 건드리지 않고 나간다.
    RETURN QUERY SELECT 'INSUFFICIENT_MARGIN'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- ④ 포지션
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

  -- ⑤ 수수료. **읽고 고쳐 쓰지 않는다** — SQL이 증가시킨다.
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
    -- 문구는 서버 버전·로케일·문안 변경에 따라 달라지고, 다른 인덱스
    -- 이름이 그 문장 안에 우연히 들어갈 수도 있다. PostgreSQL이 실제로
    -- 깨진 제약 이름을 직접 준다.
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

-- 권한은 074와 같다. SECURITY DEFINER로 만들지 않는다 — 만들면
-- authenticated가 남의 계좌를 움직일 통로가 생긴다.
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
  '모의 진입·진입 수수료·가용 증거금 검사를 한 트랜잭션으로 처리한다. '
  '계좌 줄을 잠근 상태에서 used + margin + fee <= balance를 최종 판정한다. '
  '계좌는 만들지 않는다(071). 중복 판정이 용량 판정보다 앞이다.';
