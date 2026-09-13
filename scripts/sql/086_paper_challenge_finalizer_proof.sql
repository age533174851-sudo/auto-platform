-- scripts/sql/086_paper_challenge_finalizer_proof.sql
--
-- **생명주기가 실제로 끝까지 닫히는지 실행해서 본다.**
--
-- `086`이 만든 것을 글자로 읽지 않고 불러 본다. `075`의 `paper_open_position`은
-- 글자로 멀쩡했고 검사기 55개가 초록이었지만 실행할 때마다 42702였다.
--
-- 이 파일이 지키는 두 가지
-- ───────────────────────
--   ① **중재 부등식.** 만료가 가능한 시점의 `ends_at`에 대해, `ends_at` 이하의
--      사건 시각은 **반드시 거부된다.** 이것이 성립해야 "기간 안의 달성이
--      만료 뒤에 도착해 먹히는" 고장이 원천적으로 불가능하다.
--
--        정산 허용  clock_timestamp() <= event + L
--        만료 자격  clock_timestamp() >  ends  + L
--
--   ② **진입은 RUNNING에서만.** READY·CLOSING·CLOSED 전부 거부. 일반 모의
--      계좌는 지금까지의 동작 그대로.
--
-- 오류가 나야 통과인 것
-- ─────────────────────
-- 성공만 보면 "무엇이든 받아 주는 함수"가 만점을 받는다. 거부돼야 하는 것은
-- **기대한 SQLSTATE까지** 맞아야 통과로 적는다.
--
-- 시계
-- ────
-- 만료·신선도는 `clock_timestamp()`를 쓰므로 고정 시각을 박을 수 없다. 대신
-- `paper_event_max_lag()`을 기준으로 **상대 시각**을 만든다 — L이 바뀌어도
-- 이 증명은 따라 움직인다.
--
-- 운영에 닿지 않는다
-- ──────────────────
-- 빈 로컬 DB에서만 돈다. 전부 한 트랜잭션이고 마지막에 ROLLBACK한다.

\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.want(p_label TEXT, p_got TEXT, p_expect TEXT)
RETURNS void AS $fn$
BEGIN
  IF p_got IS DISTINCT FROM p_expect THEN
    RAISE EXCEPTION 'FAIL % : 기대 % / 실제 %', p_label, p_expect, COALESCE(p_got, 'NULL');
  END IF;
  RAISE NOTICE 'ok  %  → %', p_label, p_got;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.must_fail(p_label TEXT, p_sqlstate TEXT, p_sql TEXT)
RETURNS void AS $fn$
DECLARE v_state TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    IF v_state IS DISTINCT FROM p_sqlstate THEN
      RAISE EXCEPTION 'FAIL % : 기대 SQLSTATE % / 실제 % (%)',
        p_label, p_sqlstate, v_state, SQLERRM;
    END IF;
    RAISE NOTICE 'ok  %  → 거부 %', p_label, v_state;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % : 거부돼야 하는데 통과했다', p_label;
END $fn$ LANGUAGE plpgsql;

-- 사용자 셋. 챌린지는 사용자당 하나라 상태별로 사람을 나눈다.
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ready@proof'),
  ('a0000000-0000-0000-0000-000000000002', 'expire@proof'),
  ('a0000000-0000-0000-0000-000000000003', 'live@proof'),
  ('a0000000-0000-0000-0000-000000000004', 'plain@proof'),
  ('a0000000-0000-0000-0000-000000000005', 'idem@proof')
ON CONFLICT DO NOTHING;

-- ══════════════════ ① 중재 부등식 ══════════════════
--
-- **만료가 가능해지는 순간, 기간 안의 사건은 이미 거부된다.**
DO $$
DECLARE
  v_lag   INTERVAL := public.paper_event_max_lag();
  v_ends  TIMESTAMPTZ;
BEGIN
  -- 만료가 가능한 ends_at (now - L - 1s)
  v_ends := clock_timestamp() - v_lag - INTERVAL '1 second';
  PERFORM pg_temp.want('만료 자격: ends_at + L 을 지났다',
    public.paper_challenge_expiry_eligible(v_ends)::TEXT, 'true');

  -- 그 시점의 ends_at 이하 사건은 전부 거부돼야 한다
  PERFORM pg_temp.must_fail('  ends_at 그 자체인 사건은 거부된다', '22008',
    format('SELECT public.paper_event_time_guard(%L::timestamptz)', v_ends));
  PERFORM pg_temp.must_fail('  ends_at 보다 이른 사건도 거부된다', '22008',
    format('SELECT public.paper_event_time_guard(%L::timestamptz)',
           v_ends - INTERVAL '1 second'));

  -- 아직 만료가 불가능한 ends_at (now - L + 5s) — 그때는 사건이 받아들여진다
  v_ends := clock_timestamp() - v_lag + INTERVAL '5 seconds';
  PERFORM pg_temp.want('만료 자격: 유예 안에서는 만료하지 않는다',
    public.paper_challenge_expiry_eligible(v_ends)::TEXT, 'false');
  PERFORM public.paper_event_time_guard(v_ends);
  RAISE NOTICE 'ok  %  → %', '  같은 시점의 사건은 받아들여진다', '통과';

  -- ★ **정확히 같은 순간**에 둘 다 참이 되지 않는다.
  --    실제 시계로는 나노초 차이라 볼 수 없어서, 두 시각을 받는 순수 비교로
  --    같은 순간을 만들어 본다. `>`가 `>=`로 느슨해지면 여기서 잡힌다.
  DECLARE v_e TIMESTAMPTZ := clock_timestamp();
  BEGIN
    PERFORM pg_temp.want('★ 경계: 그 순간의 사건은 아직 신선하다',
      public.paper_event_time_fresh(v_e, v_e + v_lag)::TEXT, 'true');
    PERFORM pg_temp.want('★ 경계: 그 순간은 아직 만료가 아니다',
      public.paper_challenge_expiry_due(v_e, v_e + v_lag)::TEXT, 'false');
    PERFORM pg_temp.want('  경계 한 눈금 뒤: 신선하지 않다',
      public.paper_event_time_fresh(v_e, v_e + v_lag + INTERVAL '1 microsecond')::TEXT, 'false');
    PERFORM pg_temp.want('  경계 한 눈금 뒤: 만료 자격이 생긴다',
      public.paper_challenge_expiry_due(v_e, v_e + v_lag + INTERVAL '1 microsecond')::TEXT, 'true');
    PERFORM pg_temp.want('★ 어느 순간에도 둘 다 참이 아니다',
      (SELECT bool_or(public.paper_event_time_fresh(v_e, n)
                  AND public.paper_challenge_expiry_due(v_e, n))::TEXT
         FROM generate_series(v_e + v_lag - INTERVAL '2 seconds',
                              v_e + v_lag + INTERVAL '2 seconds',
                              INTERVAL '100 milliseconds') AS n), 'false');
  END;

  -- 끝 시각을 모르면 만료시키지 않는다
  PERFORM pg_temp.want('  ends_at이 없으면 만료 자격 없음',
    public.paper_challenge_expiry_eligible(NULL)::TEXT, 'false');

  -- 미래 시각은 받지 않는다
  PERFORM pg_temp.must_fail('  먼 미래 사건은 거부된다', '22008',
    format('SELECT public.paper_event_time_guard(%L::timestamptz)',
           clock_timestamp() + public.paper_event_max_ahead() + INTERVAL '10 seconds'));
  PERFORM pg_temp.must_fail('  사건 시각 없음은 22004', '22004',
    'SELECT public.paper_event_time_guard(NULL)');
END $$;

-- ══════════════════ ② 진입은 RUNNING에서만 ══════════════════

-- READY (시작 전)
DO $$
DECLARE v_ch UUID; v_acct UUID; v_st TEXT;
BEGIN
  SELECT challenge_id, paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      'a0000000-0000-0000-0000-000000000001', 1000, 1200, 800,
      clock_timestamp() + INTERVAL '1 hour', clock_timestamp() + INTERVAL '2 hours',
      clock_timestamp());
  PERFORM pg_temp.want('READY 챌린지가 만들어졌다',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'READY');

  SELECT status INTO v_st FROM public.paper_open_position(
    p_user_id => 'a0000000-0000-0000-0000-000000000001', p_signal_id => 'ready-1',
    p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
    p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
    p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
    p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 0,
    p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
    p_paper_account_id => v_acct);
  PERFORM pg_temp.want('★ READY에서는 진입이 막힌다', v_st, 'CHALLENGE_NOT_RUNNING');
  PERFORM pg_temp.want('  포지션이 생기지 않았다',
    (SELECT COUNT(*)::TEXT FROM public.paper_positions pp WHERE pp.paper_account_id = v_acct), '0');
  PERFORM pg_temp.want('  원장도 늘지 않았다 (시작금 한 줄뿐)',
    (SELECT COUNT(*)::TEXT FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch), '1');
END $$;

-- RUNNING → 진입 허용
DO $$
DECLARE v_ch UUID; v_acct UUID; v_st TEXT;
BEGIN
  SELECT challenge_id, paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      'a0000000-0000-0000-0000-000000000003', 1000, 1200, 800,
      clock_timestamp() - INTERVAL '1 hour', clock_timestamp() + INTERVAL '1 hour',
      clock_timestamp());
  PERFORM pg_temp.want('RUNNING 챌린지가 만들어졌다',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'RUNNING');

  SELECT status INTO v_st FROM public.paper_open_position(
    p_user_id => 'a0000000-0000-0000-0000-000000000003', p_signal_id => 'live-1',
    p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
    p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
    p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
    p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 1,
    p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
    p_paper_account_id => v_acct);
  PERFORM pg_temp.want('★ RUNNING에서는 진입이 열린다', v_st, 'OPENED');

  -- 낡은 사건 시각은 챌린지 계좌에서 거부된다
  PERFORM pg_temp.must_fail('  낡은 사건 시각의 진입은 거부된다', '22008',
    format($q$SELECT public.paper_open_position(
      p_user_id => 'a0000000-0000-0000-0000-000000000003', p_signal_id => 'live-stale',
      p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
      p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
      p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
      p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 1,
      p_margin_mode => 'ISOLATED', p_event_effective_at => %L::timestamptz,
      p_paper_account_id => %L::uuid)$q$,
      clock_timestamp() - public.paper_event_max_lag() - INTERVAL '10 seconds', v_acct));
END $$;

-- 일반 모의 계좌는 **동작이 그대로**다 — 신선도도 상태도 걸리지 않는다
DO $$
DECLARE v_acct UUID; v_st TEXT;
BEGIN
  INSERT INTO public.paper_accounts (user_id, balance, initial_balance, is_default)
  VALUES ('a0000000-0000-0000-0000-000000000004', 10000, 10000, TRUE)
  RETURNING id INTO v_acct;

  SELECT status INTO v_st FROM public.paper_open_position(
    p_user_id => 'a0000000-0000-0000-0000-000000000004', p_signal_id => 'plain-old',
    p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
    p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
    p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
    p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 1,
    p_margin_mode => 'ISOLATED',
    -- **아주 낡은 사건 시각** — 챌린지 계좌였다면 거부됐을 값이다
    p_event_effective_at => clock_timestamp() - public.paper_event_max_lag() - INTERVAL '1 hour',
    p_paper_account_id => v_acct);
  PERFORM pg_temp.want('★ 일반 계좌는 신선도에 걸리지 않는다 (동작 불변)', v_st, 'OPENED');
END $$;

-- ══════════════════ ③ 만료 → 마감 ══════════════════
DO $$
DECLARE
  v_ch UUID; v_acct UUID; v_pos UUID; v_st TEXT;
  v_act TEXT; v_code TEXT; v_fin BOOLEAN; v_open INT;
BEGIN
  SELECT challenge_id, paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      'a0000000-0000-0000-0000-000000000002', 1000, 1200, 800,
      clock_timestamp() - INTERVAL '2 hours',
      clock_timestamp() - public.paper_event_max_lag() - INTERVAL '1 minute',
      clock_timestamp() - INTERVAL '2 hours');

  -- 만료 전에 포지션 하나를 연다 (RUNNING이고 시각은 지금)
  SELECT position_id INTO v_pos FROM public.paper_open_position(
    p_user_id => 'a0000000-0000-0000-0000-000000000002', p_signal_id => 'exp-1',
    p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
    p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
    p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
    p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 2,
    p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
    p_paper_account_id => v_acct);
  PERFORM pg_temp.want('만료 대상에 열린 포지션이 있다',
    (v_pos IS NOT NULL)::TEXT, 'true');

  -- ── 스윕 ──
  SELECT action INTO v_act FROM public.paper_challenge_sweep_due() s
   WHERE s.challenge = v_ch;
  PERFORM pg_temp.want('★ 만료가 CLOSING으로 민다', v_act, 'EXPIRED');
  PERFORM pg_temp.want('  상태 = CLOSING',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'CLOSING');
  PERFORM pg_temp.want('  사유 = EXPIRED',
    (SELECT c.close_intent FROM public.paper_challenges c WHERE c.id = v_ch), 'EXPIRED');
  PERFORM pg_temp.want('  판정 시각 = ends_at 그 자체',
    (SELECT (c.close_intent_event_at = c.ends_at)::TEXT
       FROM public.paper_challenges c WHERE c.id = v_ch), 'true');
  PERFORM pg_temp.want('  전이 로그는 judge와 같은 키 한 줄',
    (SELECT COUNT(*)::TEXT FROM public.paper_challenge_transitions t
      WHERE t.challenge_id = v_ch AND t.transition_key = 'INTENT:' || v_ch::TEXT), '1');

  -- 스윕을 다시 돌려도 아무 일도 없다
  PERFORM pg_temp.want('  다시 훑어도 더 밀 것이 없다',
    (SELECT COUNT(*)::TEXT FROM public.paper_challenge_sweep_due() s WHERE s.challenge = v_ch), '0');

  -- CLOSING에서는 진입이 막힌다
  SELECT status INTO v_st FROM public.paper_open_position(
    p_user_id => 'a0000000-0000-0000-0000-000000000002', p_signal_id => 'exp-2',
    p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
    p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
    p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
    p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 2,
    p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
    p_paper_account_id => v_acct);
  PERFORM pg_temp.want('★ CLOSING에서는 진입이 막힌다', v_st, 'CHALLENGE_NOT_RUNNING');

  -- ── 포지션이 남아 있으면 닫지 않는다 ──
  SELECT finalized, code, open_count INTO v_fin, v_code, v_open
    FROM public.paper_challenge_finalize(v_ch);
  PERFORM pg_temp.want('★ 열린 포지션이 있으면 마감하지 않는다', v_code, 'POSITIONS_OPEN');
  PERFORM pg_temp.want('  몇 개 남았는지 값으로 말한다', v_open::TEXT, '1');
  PERFORM pg_temp.want('  상태는 CLOSING 그대로',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'CLOSING');

  -- ── 청산은 CLOSING에서도 열려 있다 (기존 회계 경로) ──
  PERFORM public.paper_settle_close(v_pos, 110, 'MANUAL', 2, 10, 8, 8, clock_timestamp());
  PERFORM pg_temp.want('  CLOSING에서도 청산은 된다',
    (SELECT pp.status FROM public.paper_positions pp WHERE pp.id = v_pos), 'closed');

  -- ── 원장과 잔고가 어긋나면 닫지 않는다 ──
  UPDATE public.paper_accounts SET balance = balance + 1 WHERE id = v_acct;
  SELECT code INTO v_code FROM public.paper_challenge_finalize(v_ch);
  PERFORM pg_temp.want('★ 원장과 잔고가 어긋나면 마감하지 않는다', v_code, 'RECONCILE_MISMATCH');
  PERFORM pg_temp.want('  상태는 CLOSING 그대로',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'CLOSING');
  UPDATE public.paper_accounts SET balance = balance - 1 WHERE id = v_acct;

  -- ── 마감 ──
  SELECT finalized, code INTO v_fin, v_code FROM public.paper_challenge_finalize(v_ch);
  PERFORM pg_temp.want('★ 포지션 0 + 원장 일치 → CLOSED', v_code, 'CLOSED');
  PERFORM pg_temp.want('  finalized', v_fin::TEXT, 'true');
  PERFORM pg_temp.want('  최종 상태 = 동결된 사유의 복사',
    (SELECT c.terminal_status FROM public.paper_challenges c WHERE c.id = v_ch), 'EXPIRED');
  PERFORM pg_temp.want('  closed_at이 남았다',
    (SELECT (c.closed_at IS NOT NULL)::TEXT FROM public.paper_challenges c WHERE c.id = v_ch), 'true');
  PERFORM pg_temp.want('  불변식 SUM(원장) = 잔고',
    (SELECT (COALESCE(SUM(f.amount),0) = (SELECT a.balance FROM public.paper_accounts a WHERE a.id = v_acct))::TEXT
       FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch), 'true');

  -- ── 다시 불러도 한 번만 닫힌다 ──
  SELECT code INTO v_code FROM public.paper_challenge_finalize(v_ch);
  PERFORM pg_temp.want('★ 다시 마감하면 NOT_CLOSING (중복 마감 없음)', v_code, 'NOT_CLOSING');
  PERFORM pg_temp.want('  CLOSED 전이 로그는 한 줄',
    (SELECT COUNT(*)::TEXT FROM public.paper_challenge_transitions t
      WHERE t.challenge_id = v_ch AND t.to_status = 'CLOSED'), '1');

  -- ── CLOSED에서도 진입은 막힌다 ──
  SELECT status INTO v_st FROM public.paper_open_position(
    p_user_id => 'a0000000-0000-0000-0000-000000000002', p_signal_id => 'exp-3',
    p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
    p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
    p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
    p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 2,
    p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
    p_paper_account_id => v_acct);
  PERFORM pg_temp.want('★ CLOSED에서도 진입이 막힌다', v_st, 'CHALLENGE_NOT_RUNNING');

  -- ── 없는 챌린지 ──
  PERFORM pg_temp.want('없는 챌린지를 마감하면 NO_CHALLENGE',
    (SELECT code FROM public.paper_challenge_finalize('00000000-0000-0000-0000-0000000000ff')),
    'NO_CHALLENGE');
END $$;

-- ══════════════════ ④ 원장 사건 시각은 바뀌지 않는다 ══════════════════
DO $$
DECLARE v_row UUID;
BEGIN
  SELECT f.id INTO v_row FROM public.paper_challenge_cashflows f LIMIT 1;
  PERFORM pg_temp.must_fail('★ 적힌 원장의 사건 시각은 덮어쓸 수 없다', '23514',
    format('UPDATE public.paper_challenge_cashflows SET event_effective_at = now() WHERE id = %L', v_row));
END $$;

-- ══════════════════ ⑤ 활성화 ══════════════════
DO $$
DECLARE v_ch UUID; v_act TEXT;
BEGIN
  -- READY 챌린지의 시작 시각을 지나게 만든다 (사용자 ①의 것)
  SELECT c.id INTO v_ch FROM public.paper_challenges c
   WHERE c.user_id = 'a0000000-0000-0000-0000-000000000001';
  UPDATE public.paper_challenges c
     SET starts_at = clock_timestamp() - INTERVAL '1 minute'
   WHERE c.id = v_ch;

  SELECT action INTO v_act FROM public.paper_challenge_sweep_due() s WHERE s.challenge = v_ch;
  PERFORM pg_temp.want('★ starts_at을 지나면 RUNNING으로 민다', v_act, 'STARTED');
  PERFORM pg_temp.want('  상태 = RUNNING',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'RUNNING');
  PERFORM pg_temp.want('  전이 로그 START: 한 줄',
    (SELECT COUNT(*)::TEXT FROM public.paper_challenge_transitions t
      WHERE t.challenge_id = v_ch AND t.transition_key = 'START:' || v_ch::TEXT), '1');
  PERFORM pg_temp.want('  판정 시각 = starts_at 그 자체',
    (SELECT (t.event_effective_at = c.starts_at)::TEXT
       FROM public.paper_challenge_transitions t JOIN public.paper_challenges c ON c.id = t.challenge_id
      WHERE t.challenge_id = v_ch AND t.to_status = 'RUNNING'), 'true');
  PERFORM pg_temp.want('  다시 훑어도 더 밀 것이 없다',
    (SELECT COUNT(*)::TEXT FROM public.paper_challenge_sweep_due() s WHERE s.challenge = v_ch), '0');
END $$;

-- ══════════════════ ⑥ 같은 사건, 다른 시각 ══════════════════
--
-- **같은 사건에 나중 시각을 적을 수 없다.**
--
-- 신선도에 걸려 거부된 정산은 한 줄도 쓰지 않으므로, 다음 회차의 청산은 새
-- 서버 동작이고 자기 시각을 갖는다. 그런데 **이미 적힌 사건**에 대해 같은
-- 식별자로 다른 시각이 들어오면 어떻게 되는가 — 그것이 이 절이다.
--
-- 세 층이 함께 막는다:
--   ① 원장 멱등 키 (083) — 같은 (챌린지·종류·출처·식별자)는 한 줄이다
--   ② paper_money_apply (085) — 원장이 안 생기면 **잔고도 밀지 않는다**
--   ③ 사건 시각 동결 트리거 (086) — 적힌 시각은 UPDATE로도 못 바꾼다
DO $$
DECLARE
  v_ch UUID; v_acct UUID; v_pos UUID;
  v_bal0 NUMERIC; v_bal1 NUMERIC;
  v_rows0 INT; v_rows1 INT;
  v_at0 TIMESTAMPTZ; v_at1 TIMESTAMPTZ;
  v_applied BOOLEAN;
  v_settled BOOLEAN;
BEGIN
  SELECT challenge_id, paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      'a0000000-0000-0000-0000-000000000005', 1000, 1200, 800,
      clock_timestamp() - INTERVAL '1 hour', clock_timestamp() + INTERVAL '1 hour',
      clock_timestamp());

  SELECT position_id INTO v_pos FROM public.paper_open_position(
    p_user_id => 'a0000000-0000-0000-0000-000000000005', p_signal_id => 'idem-1',
    p_strategy_id => 's', p_bucket => NULL, p_symbol => 'BTCUSDT', p_market => 'USDM',
    p_side => 'LONG', p_entry_price => 100, p_fill_price => 100, p_quantity => 1,
    p_notional => 100, p_leverage => 1, p_margin => 100, p_stop_loss => NULL,
    p_take_profit => NULL, p_liquidation_price => 50, p_entry_fee => 1,
    p_margin_mode => 'ISOLATED', p_event_effective_at => clock_timestamp(),
    p_paper_account_id => v_acct);

  PERFORM public.paper_settle_close(v_pos, 110, 'TP', 1, 10, 8, 8, clock_timestamp());

  -- 정산 뒤 상태를 기록한다. **아래 재호출들은 이 값을 하나도 바꾸면 안 된다.**
  SELECT a.balance INTO v_bal0 FROM public.paper_accounts a WHERE a.id = v_acct;
  SELECT COUNT(*)::INT INTO v_rows0
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch;
  SELECT f.event_effective_at INTO v_at0
    FROM public.paper_challenge_cashflows f
   WHERE f.challenge_id = v_ch AND f.cashflow_type = 'REALIZED_PNL'
     AND f.source_event_id = v_pos::TEXT;
  PERFORM pg_temp.want('정산이 원장에 남았다', (v_at0 IS NOT NULL)::TEXT, 'true');

  -- ── ① 같은 식별자 · **다른 시각**으로 돈을 다시 넣어 본다 ──
  --
  --    금액도 일부러 다르게 준다. 두 번째가 통과하면 잔고가 그만큼 튄다.
  v_applied := public.paper_money_apply(
    v_acct, 'a0000000-0000-0000-0000-000000000005', 'REALIZED_PNL', 999,
    'POSITION_CLOSE', v_pos::TEXT, clock_timestamp());
  PERFORM pg_temp.want('★ 같은 사건을 다른 시각으로 다시 넣으면 적용되지 않는다',
    v_applied::TEXT, 'false');

  SELECT a.balance INTO v_bal1 FROM public.paper_accounts a WHERE a.id = v_acct;
  SELECT COUNT(*)::INT INTO v_rows1
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch;
  SELECT f.event_effective_at INTO v_at1
    FROM public.paper_challenge_cashflows f
   WHERE f.challenge_id = v_ch AND f.cashflow_type = 'REALIZED_PNL'
     AND f.source_event_id = v_pos::TEXT;

  PERFORM pg_temp.want('  잔고 변화 0', (v_bal1 - v_bal0)::TEXT, '0');
  PERFORM pg_temp.want('  원장 줄 수 변화 0', (v_rows1 - v_rows0)::TEXT, '0');
  PERFORM pg_temp.want('★ 적힌 사건 시각이 그대로다', (v_at1 = v_at0)::TEXT, 'true');

  -- ── ② 포지션을 다시 정산해 본다 ──
  SELECT settled INTO v_settled
    FROM public.paper_settle_close(v_pos, 500, 'TP', 1, 400, 398, 398, clock_timestamp());
  PERFORM pg_temp.want('★ 이미 닫힌 포지션은 다시 정산되지 않는다', v_settled::TEXT, 'false');

  SELECT a.balance INTO v_bal1 FROM public.paper_accounts a WHERE a.id = v_acct;
  SELECT COUNT(*)::INT INTO v_rows1
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch;
  SELECT f.event_effective_at INTO v_at1
    FROM public.paper_challenge_cashflows f
   WHERE f.challenge_id = v_ch AND f.cashflow_type = 'REALIZED_PNL'
     AND f.source_event_id = v_pos::TEXT;

  PERFORM pg_temp.want('  잔고 변화 0', (v_bal1 - v_bal0)::TEXT, '0');
  PERFORM pg_temp.want('  원장 줄 수 변화 0', (v_rows1 - v_rows0)::TEXT, '0');
  PERFORM pg_temp.want('  사건 시각도 그대로다', (v_at1 = v_at0)::TEXT, 'true');
  PERFORM pg_temp.want('  불변식 SUM(원장) = 잔고',
    (SELECT (COALESCE(SUM(f.amount),0) = v_bal1)::TEXT
       FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch), 'true');

  -- ── ③ 적힌 시각을 직접 고치려 들면 DB가 거부한다 ──
  PERFORM pg_temp.must_fail('★ 적힌 사건 시각은 UPDATE로도 못 바꾼다', '23514',
    format('UPDATE public.paper_challenge_cashflows SET event_effective_at = %L
             WHERE challenge_id = %L AND source_event_id = %L',
           clock_timestamp(), v_ch, v_pos::TEXT));
END $$;

DO $$ BEGIN RAISE NOTICE '챌린지 생명주기 실행 증명 전부 통과'; END $$;

ROLLBACK;
