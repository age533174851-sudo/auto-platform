-- scripts/sql/087_paper_challenge_cancel_proof.sql
--
-- **취소가 돈을 만들지 않는지, 남의 사유를 덮지 않는지 실행해서 본다.**
--
-- 왜 글자로 읽지 않는가
-- ─────────────────────
-- `075`의 `paper_open_position`은 글자로 멀쩡했고 검사기 55개가 초록이었지만
-- 실행할 때마다 42702였다. 잠금 순서·CAS·트리거는 특히 그렇다 — 읽어서는
-- 맞아 보인다.
--
-- 이 파일이 지키는 넷
-- ───────────────────
--   ① **취소는 사유만 얼린다.** 잔고 변화 0 · 원장 줄 수 변화 0 ·
--      열린 포지션 그대로. 정리는 스윕이 한다
--   ② **이미 정해진 사유를 덮지 않는다.** 달성·만료가 먼저면 취소가 진다
--   ③ **남의 챌린지는 없는 것과 같다.** 같은 코드, 같은 무변화
--   ④ **다시 눌러도 같은 답이다.** 전이 로그가 두 줄이 되지 않는다
--
-- 오류가 나야 통과인 것은 **기대한 SQLSTATE까지** 맞아야 통과로 적는다.
--
-- 운영에 닿지 않는다: 빈 로컬 DB에서만 돌고, 전부 한 트랜잭션이며 마지막에
-- ROLLBACK한다.

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

-- 챌린지는 사용자당 하나라 경우마다 사람을 나눈다.
INSERT INTO auth.users (id, email) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'cancel-running@proof'),
  ('b0000000-0000-0000-0000-000000000002', 'cancel-ready@proof'),
  ('b0000000-0000-0000-0000-000000000003', 'cancel-frozen@proof'),
  ('b0000000-0000-0000-0000-000000000004', 'cancel-other@proof'),
  ('b0000000-0000-0000-0000-000000000005', 'cancel-closed@proof'),
  ('b0000000-0000-0000-0000-000000000006', 'cancel-plain@proof')
ON CONFLICT DO NOTHING;

-- ══════════════════ ① 취소는 사유만 얼린다 ══════════════════
DO $$
DECLARE
  v_user   UUID := 'b0000000-0000-0000-0000-000000000001';
  v_ch     UUID;
  v_acct   UUID;
  v_pos    UUID;
  v_bal0   NUMERIC; v_bal1 NUMERIC;
  v_rows0  INT;     v_rows1 INT;
  v_open0  INT;     v_open1 INT;
  v_r      RECORD;
  v_trans  INT;
BEGIN
  SELECT c.challenge_id, c.paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      v_user, 10000, 12000, 8000,
      clock_timestamp(), clock_timestamp() + INTERVAL '30 days',
      clock_timestamp()) c;

  PERFORM pg_temp.want('기간이 시작됐으면 RUNNING이다',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'RUNNING');

  -- 포지션 하나를 연다. 취소해도 **이 포지션은 그대로 열려 있어야 한다.**
  SELECT p.position_id INTO v_pos
    FROM public.paper_open_position(
      v_user, 'sig-cancel-1', 'strat', NULL, 'BTCUSDT', 'USDM', 'LONG',
      100, 100, 1, 100, 1, 100, 90, NULL, 50, 0.05, 'ISOLATED',
      clock_timestamp(), v_acct) p;
  PERFORM pg_temp.want('  포지션이 열렸다', (v_pos IS NOT NULL)::TEXT, 'true');

  SELECT a.balance INTO v_bal0 FROM public.paper_accounts a WHERE a.id = v_acct;
  SELECT COUNT(*)::INT INTO v_rows0
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch;
  SELECT COUNT(*)::INT INTO v_open0
    FROM public.paper_positions pp WHERE pp.paper_account_id = v_acct AND pp.status = 'open';

  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_ch, v_user, clock_timestamp());

  PERFORM pg_temp.want('★ RUNNING을 취소하면 CLOSING이다', v_r.code, 'CLOSING');
  PERFORM pg_temp.want('  사유는 CANCELLED다', v_r.close_intent, 'CANCELLED');
  PERFORM pg_temp.want('  표에도 그렇게 적혔다',
    (SELECT c.status || '/' || c.close_intent FROM public.paper_challenges c WHERE c.id = v_ch),
    'CLOSING/CANCELLED');

  SELECT a.balance INTO v_bal1 FROM public.paper_accounts a WHERE a.id = v_acct;
  SELECT COUNT(*)::INT INTO v_rows1
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch;
  SELECT COUNT(*)::INT INTO v_open1
    FROM public.paper_positions pp WHERE pp.paper_account_id = v_acct AND pp.status = 'open';

  PERFORM pg_temp.want('★ 잔고 변화 0 — 취소는 돈을 만들지 않는다', (v_bal1 = v_bal0)::TEXT, 'true');
  PERFORM pg_temp.want('★ 원장 줄 수 변화 0', (v_rows1 - v_rows0)::TEXT, '0');
  PERFORM pg_temp.want('★ 열린 포지션 그대로 — 취소가 청산하지 않는다',
    (v_open1 - v_open0)::TEXT, '0');
  PERFORM pg_temp.want('  불변식 SUM(원장) = 잔고',
    (SELECT (COALESCE(SUM(f.amount),0) = v_bal1)::TEXT
       FROM public.paper_challenge_cashflows f WHERE f.challenge_id = v_ch), 'true');

  -- 전이 로그 한 줄, 키는 judge·sweep과 같다
  SELECT COUNT(*)::INT INTO v_trans
    FROM public.paper_challenge_transitions t
   WHERE t.challenge_id = v_ch AND t.to_status = 'CLOSING';
  PERFORM pg_temp.want('  CLOSING 전이는 한 줄이다', v_trans::TEXT, '1');
  PERFORM pg_temp.want('  전이 키가 judge·sweep과 같다',
    (SELECT t.transition_key FROM public.paper_challenge_transitions t
      WHERE t.challenge_id = v_ch AND t.to_status = 'CLOSING'),
    'INTENT:' || v_ch::TEXT);

  -- ── 취소한 챌린지는 주문을 받지 않는다 ──
  PERFORM pg_temp.want('★ 취소 뒤 주문은 CHALLENGE_NOT_RUNNING이다',
    (SELECT p.status FROM public.paper_open_position(
       v_user, 'sig-cancel-2', 'strat', NULL, 'BTCUSDT', 'USDM', 'LONG',
       100, 100, 1, 100, 1, 100, 90, NULL, 50, 0.05, 'ISOLATED',
       clock_timestamp(), v_acct) p),
    'CHALLENGE_NOT_RUNNING');

  -- ── ④ 다시 눌러도 같은 답 ──
  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_ch, v_user, clock_timestamp());
  PERFORM pg_temp.want('★ 다시 취소하면 ALREADY_CLOSING이다', v_r.code, 'ALREADY_CLOSING');
  PERFORM pg_temp.want('  사유는 그대로 CANCELLED', v_r.close_intent, 'CANCELLED');
  SELECT COUNT(*)::INT INTO v_trans
    FROM public.paper_challenge_transitions t
   WHERE t.challenge_id = v_ch AND t.to_status = 'CLOSING';
  PERFORM pg_temp.want('★ 전이 로그가 두 줄이 되지 않는다', v_trans::TEXT, '1');

  -- ── 마감은 포지션이 남아 있는 동안 끝나지 않는다 ──
  PERFORM pg_temp.want('  포지션이 남아 있으면 POSITIONS_OPEN이다',
    (SELECT f.code FROM public.paper_challenge_finalize(v_ch) f), 'POSITIONS_OPEN');

  -- 정리 뒤에는 CANCELLED로 닫힌다 — **사유를 다시 판단하지 않는다**
  PERFORM public.paper_settle_close(v_pos, 100, 'MANUAL', 0.05, 0, -0.1, -0.1, clock_timestamp());
  PERFORM pg_temp.want('★ 정리 뒤 마감된다',
    (SELECT f.code FROM public.paper_challenge_finalize(v_ch) f), 'CLOSED');
  PERFORM pg_temp.want('★ 최종 상태는 동결된 CANCELLED의 복사다',
    (SELECT c.status || '/' || c.terminal_status FROM public.paper_challenges c WHERE c.id = v_ch),
    'CLOSED/CANCELLED');

  -- ── 끝난 것은 다시 취소되지 않는다 ──
  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_ch, v_user, clock_timestamp());
  PERFORM pg_temp.want('  끝난 챌린지는 ALREADY_CLOSED다', v_r.code, 'ALREADY_CLOSED');
END $$;

-- ══════════════════ ② READY도 취소된다 ══════════════════
DO $$
DECLARE
  v_user UUID := 'b0000000-0000-0000-0000-000000000002';
  v_ch   UUID; v_acct UUID; v_r RECORD;
BEGIN
  SELECT c.challenge_id, c.paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      v_user, 10000, 12000, NULL,
      clock_timestamp() + INTERVAL '2 days', clock_timestamp() + INTERVAL '30 days',
      clock_timestamp()) c;
  PERFORM pg_temp.want('시작 전이면 READY다',
    (SELECT c.status FROM public.paper_challenges c WHERE c.id = v_ch), 'READY');

  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_ch, v_user, clock_timestamp());
  PERFORM pg_temp.want('★ READY도 CLOSING으로 취소된다', v_r.code, 'CLOSING');
  PERFORM pg_temp.want('  전이는 READY → CLOSING으로 적힌다',
    (SELECT t.from_status || '→' || t.to_status
       FROM public.paper_challenge_transitions t
      WHERE t.challenge_id = v_ch AND t.to_status = 'CLOSING'),
    'READY→CLOSING');
END $$;

-- ══════════════════ ③ 이미 정해진 사유는 덮지 않는다 ══════════════════
DO $$
DECLARE
  v_user UUID := 'b0000000-0000-0000-0000-000000000003';
  v_ch   UUID; v_acct UUID; v_r RECORD;
  v_at   TIMESTAMPTZ;
BEGIN
  SELECT c.challenge_id, c.paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      v_user, 10000, 12000, 8000,
      clock_timestamp(), clock_timestamp() + INTERVAL '30 days',
      clock_timestamp()) c;

  -- 달성이 먼저 정해졌다고 두고(사유 동결), 취소를 시도한다.
  v_at := clock_timestamp();
  UPDATE public.paper_challenges c
     SET status = 'CLOSING', close_intent = 'TARGET_REACHED',
         close_intent_at = v_at, close_intent_event_at = v_at
   WHERE c.id = v_ch;

  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_ch, v_user, clock_timestamp());
  PERFORM pg_temp.want('★ 달성이 먼저면 취소가 진다', v_r.code, 'INTENT_FROZEN');
  PERFORM pg_temp.want('  얼어 있는 사유를 그대로 돌려준다', v_r.close_intent, 'TARGET_REACHED');
  PERFORM pg_temp.want('★ 표의 사유가 바뀌지 않았다',
    (SELECT c.close_intent FROM public.paper_challenges c WHERE c.id = v_ch), 'TARGET_REACHED');
  PERFORM pg_temp.want('  사유가 정해진 시각도 그대로다',
    (SELECT (c.close_intent_event_at = v_at)::TEXT
       FROM public.paper_challenges c WHERE c.id = v_ch), 'true');
  PERFORM pg_temp.want('  취소가 전이 줄을 만들지 않았다',
    (SELECT COUNT(*)::TEXT FROM public.paper_challenge_transitions t
      WHERE t.challenge_id = v_ch AND t.reason = 'CANCELLED'), '0');
END $$;

-- ══════════════════ ④ 남의 챌린지 · 없는 챌린지 ══════════════════
DO $$
DECLARE
  v_owner UUID := 'b0000000-0000-0000-0000-000000000004';
  v_thief UUID := 'b0000000-0000-0000-0000-000000000006';
  v_ch    UUID; v_acct UUID; v_r RECORD; v_r2 RECORD;
  v_bal0  NUMERIC; v_bal1 NUMERIC;
BEGIN
  SELECT c.challenge_id, c.paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      v_owner, 10000, 12000, 8000,
      clock_timestamp(), clock_timestamp() + INTERVAL '30 days',
      clock_timestamp()) c;

  SELECT a.balance INTO v_bal0 FROM public.paper_accounts a WHERE a.id = v_acct;

  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_ch, v_thief, clock_timestamp());
  PERFORM pg_temp.want('★ 남의 챌린지는 NOT_FOUND다', v_r.code, 'NOT_FOUND');
  PERFORM pg_temp.want('  상태를 알려 주지 않는다', COALESCE(v_r.status, 'NULL'), 'NULL');
  PERFORM pg_temp.want('★ 남의 챌린지가 그대로다',
    (SELECT c.status || '/' || COALESCE(c.close_intent, 'NULL')
       FROM public.paper_challenges c WHERE c.id = v_ch), 'RUNNING/NULL');

  SELECT a.balance INTO v_bal1 FROM public.paper_accounts a WHERE a.id = v_acct;
  PERFORM pg_temp.want('  남의 잔고도 그대로다', (v_bal1 = v_bal0)::TEXT, 'true');

  -- 없는 챌린지와 **같은 답**이어야 한다 — 존재 여부를 알려 주지 않는다
  SELECT * INTO v_r2 FROM public.paper_challenge_cancel(
    'ffffffff-ffff-4fff-8fff-ffffffffffff', v_thief, clock_timestamp());
  PERFORM pg_temp.want('★ 없는 챌린지도 같은 NOT_FOUND다', v_r2.code, v_r.code);

  -- 소유자가 부르면 된다
  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_ch, v_owner, clock_timestamp());
  PERFORM pg_temp.want('  소유자는 취소할 수 있다', v_r.code, 'CLOSING');
END $$;

-- ══════════════════ ⑤ 사건 시각 ══════════════════
DO $$
DECLARE
  v_user UUID := 'b0000000-0000-0000-0000-000000000005';
  v_ch   UUID; v_acct UUID;
BEGIN
  SELECT c.challenge_id, c.paper_account_id INTO v_ch, v_acct
    FROM public.paper_challenge_create(
      v_user, 10000, 12000, 8000,
      clock_timestamp(), clock_timestamp() + INTERVAL '30 days',
      clock_timestamp()) c;

  PERFORM pg_temp.must_fail('★ 사건 시각이 없으면 아무것도 바꾸지 않는다', '22004',
    format('SELECT public.paper_challenge_cancel(%L, %L, NULL)', v_ch, v_user));

  -- **읽기도 전에 거부한다.** 남의 챌린지에 NULL 시각을 넣어도 NOT_FOUND가
  -- 아니라 22004다 — 거부가 조회 뒤로 밀리면 "시각이 없어도 조회는 했다"가
  -- 되고, 그 순서는 다음에 무엇이 붙느냐에 따라 돈에 닿는다.
  PERFORM pg_temp.must_fail('★ 시각 없음은 소유권을 보기도 전에 거부된다', '22004',
    format('SELECT public.paper_challenge_cancel(%L, %L, NULL)',
           'ffffffff-ffff-4fff-8fff-ffffffffffff', v_user));

  PERFORM pg_temp.must_fail('★ 낡은 사건 시각은 거부된다', '22008',
    format('SELECT public.paper_challenge_cancel(%L, %L, %L::timestamptz)',
           v_ch, v_user,
           clock_timestamp() - public.paper_event_max_lag() - INTERVAL '10 seconds'));

  PERFORM pg_temp.must_fail('  먼 미래 사건 시각도 거부된다', '22008',
    format('SELECT public.paper_challenge_cancel(%L, %L, %L::timestamptz)',
           v_ch, v_user,
           clock_timestamp() + public.paper_event_max_ahead() + INTERVAL '10 seconds'));

  PERFORM pg_temp.want('★ 거부된 뒤에도 챌린지는 그대로다',
    (SELECT c.status || '/' || COALESCE(c.close_intent, 'NULL')
       FROM public.paper_challenges c WHERE c.id = v_ch), 'RUNNING/NULL');
END $$;

-- ══════════════════ ⑥ 일반 모의 계좌는 건드리지 않는다 ══════════════════
--
-- 챌린지가 아닌 기본 계좌는 이 함수의 대상이 아니다. 계좌 id를 넣어도
-- 챌린지로 읽히지 않는다.
DO $$
DECLARE
  v_user UUID := 'b0000000-0000-0000-0000-000000000006';
  v_acct UUID;
  v_r    RECORD;
  v_bal0 NUMERIC; v_bal1 NUMERIC;
  v_pos  UUID;
BEGIN
  INSERT INTO public.paper_accounts (user_id, is_default, balance, initial_balance)
  VALUES (v_user, TRUE, 10000, 10000) RETURNING id INTO v_acct;

  SELECT a.balance INTO v_bal0 FROM public.paper_accounts a WHERE a.id = v_acct;

  -- 계좌 id를 챌린지 id 자리에 넣어도 챌린지가 아니다
  SELECT * INTO v_r FROM public.paper_challenge_cancel(v_acct, v_user, clock_timestamp());
  PERFORM pg_temp.want('★ 계좌 id는 챌린지가 아니다 — NOT_FOUND', v_r.code, 'NOT_FOUND');

  SELECT a.balance INTO v_bal1 FROM public.paper_accounts a WHERE a.id = v_acct;
  PERFORM pg_temp.want('  기본 계좌 잔고가 그대로다', (v_bal1 = v_bal0)::TEXT, 'true');

  -- 그리고 일반 모의 주문은 지금까지처럼 열린다
  SELECT p.status INTO v_r FROM public.paper_open_position(
    v_user, 'sig-plain-1', 'strat', NULL, 'BTCUSDT', 'USDM', 'LONG',
    100, 100, 1, 100, 1, 100, 90, NULL, 50, 0.05, 'ISOLATED',
    clock_timestamp(), NULL) p;
  PERFORM pg_temp.want('★ 일반 모의 주문은 지금까지처럼 열린다', v_r.status, 'OPENED');
END $$;

DO $$ BEGIN RAISE NOTICE '챌린지 취소 실행 증명 전부 통과'; END $$;

ROLLBACK;
