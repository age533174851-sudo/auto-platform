-- 072: 모의 청산과 계좌 정산을 **한 트랜잭션**으로 묶는다
--
-- 071 이후 `closePaperPosition()`은 이랬다:
--
--   ① paper_positions  status='open'일 때만 바뀌는 조건부 UPDATE (선점)
--   ② paper_accounts   읽는다
--   ③ paper_accounts   읽은 값 + 손익으로 **덮어쓴다**
--
-- ①은 **같은 포지션**을 두 번 닫는 것을 막았다. 그런데 두 가지가 남았다.
--
-- ■ 하나. ①이 성공하고 ③이 실패하면 되돌릴 방법이 없다
--
--   포지션은 이미 CLOSED인데 잔고·손익·수수료·매매횟수가 반영되지 않은
--   채로 남는다. 그 포지션은 다시 닫을 수도 없다(이미 closed다). 장부가
--   조용히 어긋나고, 어긋난 것을 알아챌 방법도 없다.
--
--   더 나쁜 것은 ③이 `try { } catch {}` 안에 있었다는 것이다 — 실패가
--   기록조차 되지 않았다.
--
-- ■ 둘. **서로 다른** 두 포지션이 동시에 닫히면 한쪽 손익이 사라진다
--
--     포지션 A 청산 ─┐                    balance 10,000 읽음
--                    ├→ 같은 paper_account
--     포지션 B 청산 ─┘                    balance 10,000 읽음
--
--     A가 10,100을 쓰고 B가 10,050을 쓴다. **A의 손익이 사라진다.**
--     같은 포지션이 아니므로 ①의 선점은 여기서 아무 일도 하지 않는다.
--     읽고-고쳐-쓰는 구조 자체가 원인이다.
--
-- ■ 그래서 무엇을 하는가
--
--   포지션 선점과 계좌 정산을 **하나의 함수 = 하나의 트랜잭션**에 넣는다.
--   함수 안에서 예외가 나면 포지션 UPDATE까지 통째로 되돌아간다 —
--   "포지션만 닫히고 계좌는 그대로"가 만들어질 수 없다.
--
--   계좌는 `balance = balance + delta` 로 **SQL이 직접 증가**시킨다. 읽은
--   값을 JS가 더해서 덮어쓰지 않는다. 같은 줄을 동시에 건드리면 Postgres가
--   줄 잠금으로 차례를 세우므로 두 손익이 모두 남는다.
--
-- ■ 손익 계산은 여기서 하지 않는다
--
--   금액은 `paperExecution.computeClose()`가 계산해서 인자로 들어온다.
--   공식을 SQL에도 적으면 같은 판단이 두 곳에 생기고, 언젠가 한쪽만
--   바뀐다. 이 함수가 보장하는 것은 **계산이 아니라 원자성**이다.
--
-- ■ user_id는 부르는 쪽을 믿지 않는다
--
--   정산 대상은 **선점에 성공한 포지션 줄의 user_id**다. 인자로 받지
--   않는다 — 받으면 남의 계좌에 정산할 통로가 생긴다.
--
-- ADDITIVE 전용이다. 표·칸을 만들지도 지우지도 않는다.

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
  v_accounts INT;
BEGIN
  -- ① 선점. status='open'인 줄만 바뀐다.
  --    진 쪽은 v_owner가 NULL로 남는다.
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
  RETURNING user_id INTO v_owner;

  IF v_owner IS NULL THEN
    -- 없거나, 이미 다른 실행기가 닫았다. **계좌를 건드리지 않는다.**
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- ② 정산. 읽지 않고 **증가시킨다.**
  UPDATE public.paper_accounts
     SET balance     = balance     + p_gross_pnl - p_exit_fee,
         total_pnl   = total_pnl   + p_realized_pnl,
         total_fees  = total_fees  + p_exit_fee,
         trade_count = trade_count + 1,
         win_count   = win_count   + CASE WHEN p_realized_pnl > 0 THEN 1 ELSE 0 END,
         updated_at  = NOW()
   WHERE user_id = v_owner;

  GET DIAGNOSTICS v_accounts = ROW_COUNT;

  IF v_accounts <> 1 THEN
    -- **여기서 예외를 던지면 ①까지 되돌아간다.** 포지션은 열린 채로
    -- 남고, 다음 회차가 다시 집는다. 닫힌 채로 정산만 빠지는 상태를
    -- 만들지 않는다.
    RAISE EXCEPTION
      'paper_settle_close: 계좌를 정산하지 못했습니다 (갱신 %행) — 청산을 되돌립니다',
      v_accounts;
  END IF;

  RETURN QUERY SELECT TRUE, v_owner, p_realized_pnl, p_pnl_pct;
END;
$$;

-- 진입 수수료도 같은 이유로 **증가 연산**으로 바꾼다.
--
-- 두 포지션이 동시에 열리면 예전 구조(읽고-고쳐-쓰기)에서는 한쪽 수수료가
-- 사라졌다. 청산과 같은 고장이고, 같은 장부다.
--
-- 다만 이 함수는 **포지션 INSERT까지 묶지는 않는다.** 진입은 중복 방지
-- (signal_id 유니크)·규격 검증이 얽혀 있어 한 트랜잭션으로 옮기는 것이
-- 이 PR의 범위를 넘는다. 여기서 닫는 것은 "동시에 열면 수수료가 사라진다"
-- 하나다. 남은 것은 보고에 적는다.
CREATE OR REPLACE FUNCTION public.paper_apply_entry_fee(
  p_user_id   UUID,
  p_entry_fee NUMERIC
)
RETURNS TABLE (applied BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows INT;
BEGIN
  UPDATE public.paper_accounts
     SET balance    = balance    - p_entry_fee,
         total_fees = total_fees + p_entry_fee,
         updated_at = NOW()
   WHERE user_id = p_user_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN QUERY SELECT v_rows = 1;
END;
$$;

-- 충전도 같은 줄을 건드린다.
--
-- 충전이 `읽은 balance + 금액`이면, 워커의 60초 청산과 겹쳤을 때 둘 중
-- 하나가 사라진다. 사람이 누르는 동작이라 드물 뿐, 같은 고장이다.
-- 계좌를 **만들지는 않는다** — 없으면 0행을 돌려주고 끝난다(071의 규칙).
CREATE OR REPLACE FUNCTION public.paper_deposit(
  p_user_id UUID,
  p_amount  NUMERIC
)
RETURNS TABLE (
  applied         BOOLEAN,
  new_balance     NUMERIC,
  new_initial     NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC;
  v_initial NUMERIC;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'paper_deposit: 금액이 0 이하입니다';
  END IF;

  -- **초기자본도 같이 올린다.** 안 올리면 넣은 돈이 수익으로 잡혀
  -- 수익률이 부풀려진다.
  UPDATE public.paper_accounts
     SET balance         = balance         + p_amount,
         initial_balance = initial_balance + p_amount,
         updated_at      = NOW()
   WHERE user_id = p_user_id
  RETURNING balance, initial_balance INTO v_balance, v_initial;

  IF v_balance IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;
  RETURN QUERY SELECT TRUE, v_balance, v_initial;
END;
$$;

-- 이 표들은 service_role만 쓸 수 있다(010의 정책). 함수도 같은 문을 쓴다 —
-- SECURITY DEFINER로 만들지 않는다. 만들면 authenticated가 남의 계좌를
-- 움직일 통로가 생긴다.
REVOKE ALL ON FUNCTION public.paper_settle_close(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_apply_entry_fee(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paper_deposit(UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.paper_settle_close(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_apply_entry_fee(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.paper_deposit(UUID, NUMERIC) TO service_role;

COMMENT ON FUNCTION public.paper_settle_close(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC) IS
  '모의 포지션 선점 청산 + 계좌 정산을 한 트랜잭션으로. 전부 성공하거나 전부 실패한다.';
