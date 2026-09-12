-- 084_paper_open_position_ambiguity.sql
--
-- **모의 진입이 실행될 때마다 터지고 있었다.**
--
-- 무엇이 있었나
-- ─────────────
-- `075`가 진입 트랜잭션 안에 가용 증거금 검사를 넣으면서 이 질의를 썼다:
--
--   SELECT COALESCE(SUM(margin), 0) INTO v_used
--     FROM public.paper_positions
--    WHERE user_id = p_user_id
--      AND paper_account_id = v_account
--      AND status = 'open';          -- ← 여기
--
-- 그런데 이 함수의 반환 칸 이름이 `status`다
-- (`RETURNS TABLE (status TEXT, position_id UUID)`). plpgsql은 `status`가
-- 반환 변수인지 표의 칸인지 알 수 없어 **거부한다**:
--
--   ERROR:  column reference "status" is ambiguous        (SQLSTATE 42702)
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- `082`가 계좌 인자를 붙이면서 이 자리를 그대로 물려받았다.
--
-- 왜 아무도 못 잡았나
-- ───────────────────
-- plpgsql은 질의를 **실행할 때** 계획한다. 그래서 `CREATE FUNCTION`은 성공하고,
-- 마이그레이션 재생도 통과하고, 스키마 모양 검사도 전부 초록이다. 이 저장소의
-- 검사기 55개는 **전부 SQL 파일의 글자를 읽는다** — 함수를 한 번이라도
-- 실행하는 검사기는 0개였고, supabase-replay도 표를 세운 뒤 RPC를 부르지
-- 않았다.
--
-- 즉 "만들어졌다"와 "돌아간다"를 아무도 구분하지 않고 있었다. 이 PR은 그
-- 구분을 만드는 것까지 포함한다(supabase-replay의 실행 연기 시험).
--
-- 어디서 터지나
-- ─────────────
-- 계좌 잠금과 중복 검사 **다음**이다. 그래서 `NO_ACCOUNT`·`DUPLICATE`로 먼저
-- 빠지는 경우를 빼면 **실제 진입은 전부** 이 자리에서 멈춘다. 부르는 쪽
-- (`paperStore.openPaperPosition`)은 RPC 오류에서 옛 두 단계 경로로 되돌아가지
-- 않으므로(그건 다른 사고를 막기 위한 계약이다) 그대로 실패가 된다.
--
-- 무엇을 고치나
-- ─────────────
-- **칸을 표 이름으로 한정하는 것뿐이다.** 시그니처도, 반환 모양도, 잠금 순서도,
-- 계약도 그대로다. `CREATE OR REPLACE`만 쓴다 — `DROP`이 없으므로 이 파일은
-- ADDITIVE이고 자동 적용된다. 돌아가지 않는 함수를 승인 대기에 묶어 둘 이유가
-- 없다.
--
-- 같은 부류를 이 함수 안에서 한 번에 없앤다: 한정 없이 `paper_positions`를
-- 참조하는 자리 세 곳(용량 검사 하나, 중복 검사 둘)을 전부 `pp.`로 한정했다.
-- 그 셋 말고 바뀐 줄은 없다.
--
-- 운영에 배포된 본문은 아직 모른다
-- ────────────────────────────────
-- 이 파일이 깨져 있다는 것과, 운영 DB의 함수 **본문**이 이 파일과 같다는 것은
-- 다른 사실이다. B1 감사는 이 함수의 **시그니처**만 확인했고 본문은 보지
-- 않았다. 그래서 같이 넣는 읽기 전용 감사
-- (`audit-production-paper-open-position-body.yml`)가 운영의 `prosrc`를 읽어
-- 확인한다. 확인 전까지 운영 영향은 **UNKNOWN**이다 — 0으로도, 100%로도 적지
-- 않는다.
--
-- 운영이 손으로 고쳐져 있더라도 이 수정은 필요하다. 저장소가 정본이고, 다음
-- 배포나 재구축은 이 파일로 선다.

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
  --
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

  -- ② 같은 신호는 한 번만. 잠금을 쥔 채로 보므로 동시 호출도 한쪽만 넣는다.
  --
  --    **용량 검사보다 앞이다.** 이미 성공한 신호의 재시도는 그 사이 잔고가
  --    줄었더라도 DUPLICATE여야 한다 — 그게 멱등이다.
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

  -- ③ 가용 증거금 — **잠근 상태에서 보는 이 값이 최종이다**
  --
  --    **그 계좌의 포지션만 센다.** 사용자 전체로 세면 챌린지 계좌의
  --    증거금이 기본 계좌의 용량을 깎는다 — 계좌를 나눈 이유가 사라진다.
  --    **소유자와 계좌를 둘 다 본다.** 계좌만 보면 "남의 포지션이 예산에
  --    들어가지 않는다"는 보장이 복합 외래키에만 의존하게 되고, 사용자로만
  --    보면 챌린지 계좌의 증거금이 기본 계좌 용량을 깎는다.
  SELECT COALESCE(SUM(pp.margin), 0) INTO v_used
    FROM public.paper_positions pp
   WHERE pp.user_id = p_user_id
     AND pp.paper_account_id = v_account
     AND pp.status = 'open';

  IF v_used + p_margin + p_entry_fee > v_balance THEN
    -- 포지션도 수수료도 건드리지 않고 나간다.
    RETURN QUERY SELECT 'INSUFFICIENT_MARGIN'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- ④ 포지션. **자기 계좌를 들고 태어난다.**
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

  -- ⑤ 수수료. **읽고 고쳐 쓰지 않는다** — SQL이 증가시킨다.
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

EXCEPTION
  WHEN unique_violation THEN
    -- **signal_id 충돌만 멱등 중복이다.** 다른 유니크 위반은 삼키지 않는다 —
    -- 삼키면 진짜 고장이 '이미 체결됨'으로 조용히 사라진다.
    --
    -- 어느 유니크가 깨졌는지는 **오류 문구를 읽어 판단하지 않는다.**
    -- PostgreSQL이 실제로 깨진 제약 이름을 직접 준다.
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

-- 권한은 `082`가 준 그대로다. `CREATE OR REPLACE`는 기존 권한을 유지하지만,
-- 빈 DB에서 이 파일만 재생될 때를 위해 같은 문을 다시 적는다.
REVOKE ALL ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.paper_open_position(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, INT, NUMERIC,
  NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) TO service_role;
