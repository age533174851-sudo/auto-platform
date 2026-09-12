-- scripts/sql/083_paper_challenge_core_constraints.sql
--
-- **제약이 정말로 거부하는가 — 진짜 Postgres에게 물어본다.**
--
-- 왜 정적 검사로 부족한가
-- ───────────────────────
-- `scripts/check-paper-challenge-core.mjs`는 파일에 그 문장이 **적혀 있는가**를
-- 본다. 적혀 있는데 동작하지 않는 경우는 얼마든지 있다 — `DO $$ ... IF NOT
-- EXISTS` 블록이 조용히 건너뛰거나, 제약 이름이 이미 다른 표에 있어서
-- 안 붙거나, CHECK 식이 NULL을 만나 늘 참이 되거나.
--
-- 이 저장소에서 가장 자주 난 사고가 **"실행은 성공했는데 생기지 않았다"**다.
-- 그래서 여기서는 실제로 위반하는 문장을 넣어 보고 **거부당하는지** 본다.
--
-- 틀린 이유로 실패하면 통과가 아니다
-- ──────────────────────────────────
-- 오타 때문에 42703(컬럼 없음)이 나도 "실패했으니 통과"로 적으면, 이 파일은
-- 아무것도 지키지 않으면서 초록으로 남는다. 그래서 **기대하는 SQLSTATE까지
-- 맞아야** 통과다.
--
-- 통과하는 쪽도 함께 본다
-- ───────────────────────
-- 거부만 확인하면 "전부 거부하는 제약"이 만점을 받는다. 반드시 통과해야
-- 하는 경우(같은 체결의 손익·수수료 두 줄, 끝난 챌린지 옆의 새 챌린지,
-- 같은 상태로의 두 번째 전이 기록)도 함께 넣는다.
--
-- 운영에 닿지 않는다
-- ──────────────────
-- 빈 로컬 DB에서만 돈다. 전부 하나의 트랜잭션 안에서 하고 마지막에 ROLLBACK
-- 한다 — 한 줄도 남기지 않는다.

\set ON_ERROR_STOP on

BEGIN;

-- ── 검사 도구 ──

CREATE FUNCTION pg_temp.must_fail(p_label TEXT, p_sqlstate TEXT, p_sql TEXT)
RETURNS void AS $fn$
DECLARE v_state TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> p_sqlstate THEN
      -- 틀린 이유로 실패한 것을 통과로 적지 않는다.
      RAISE EXCEPTION 'FAIL % : 기대한 사유(%)가 아니라 %로 거부됐습니다', p_label, p_sqlstate, v_state;
    END IF;
    RAISE NOTICE 'ok  거부됨  % (%)', p_label, v_state;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % : 거부돼야 하는데 통과했습니다', p_label;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.must_pass(p_label TEXT, p_sql TEXT)
RETURNS void AS $fn$
BEGIN
  EXECUTE p_sql;
  RAISE NOTICE 'ok  허용됨  %', p_label;
END $fn$ LANGUAGE plpgsql;

-- ── 바탕 데이터 ──
--
-- `paper_accounts.user_id`에는 `auth.users` 외래키가 없다. 그래서 사용자 표를
-- 건드리지 않고 UUID만으로 세울 수 있다.
CREATE TEMP TABLE ids AS SELECT
  '11111111-1111-1111-1111-111111111111'::uuid AS u1,
  '22222222-2222-2222-2222-222222222222'::uuid AS u2,
  'aaaaaaaa-0000-0000-0000-000000000001'::uuid AS acct1,
  'aaaaaaaa-0000-0000-0000-000000000002'::uuid AS acct2,
  'aaaaaaaa-0000-0000-0000-000000000003'::uuid AS acct3,
  'aaaaaaaa-0000-0000-0000-000000000009'::uuid AS acct_other,
  'cccccccc-0000-0000-0000-000000000001'::uuid AS ch1,
  'cccccccc-0000-0000-0000-000000000002'::uuid AS ch2;

INSERT INTO public.paper_accounts (id, user_id, is_default, balance)
SELECT acct1, u1, TRUE,  0 FROM ids
UNION ALL SELECT acct2, u1, FALSE, 0 FROM ids
UNION ALL SELECT acct3, u1, FALSE, 0 FROM ids
UNION ALL SELECT acct_other, u2, TRUE, 0 FROM ids;

-- 기준이 되는 챌린지 하나 (RUNNING).
INSERT INTO public.paper_challenges
  (id, user_id, paper_account_id, status, initial_equity, target_equity, failure_equity,
   starts_at, ends_at)
SELECT ch1, u1, acct1, 'RUNNING', 1000, 2000, 500,
       NOW() - INTERVAL '1 day', NOW() + INTERVAL '29 days'
  FROM ids;

-- ══════════════ ① 상태·사유 ══════════════

SELECT pg_temp.must_fail('상태에 없는 값', '23514', format(
  $q$ UPDATE public.paper_challenges SET status = 'PAUSED' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

SELECT pg_temp.must_fail('사유에 없는 값', '23514', format(
  $q$ UPDATE public.paper_challenges
         SET close_intent = 'WITHDRAWN', close_intent_event_at = NOW() WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- 왜 끝나는지 모른 채 정리에 들어갈 수 없다.
SELECT pg_temp.must_fail('사유 없는 CLOSING', '23514', format(
  $q$ UPDATE public.paper_challenges SET status = 'CLOSING' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- 끝났다는 것과 결론이 적혔다는 것은 같은 사실이다 — 양쪽 방향 모두.
SELECT pg_temp.must_fail('결론 없는 CLOSED', '23514', format(
  $q$ UPDATE public.paper_challenges SET status = 'CLOSED' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

SELECT pg_temp.must_fail('끝나지 않았는데 결론이 적힘', '23514', format(
  $q$ UPDATE public.paper_challenges
         SET close_intent = 'EXPIRED', close_intent_event_at = NOW(),
             terminal_status = 'EXPIRED' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- 사유가 정해졌으면 언제 정해졌는지도 남는다.
SELECT pg_temp.must_fail('사유만 있고 판정 시각이 없음', '23514', format(
  $q$ UPDATE public.paper_challenges SET close_intent = 'EXPIRED' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- ══════════════ ② TARGET_REACHED 불가역 ══════════════
--
-- 이 챌린지의 가장 불쾌한 고장: 기간 안에 목표에 닿아 달성이 확정됐는데,
-- 정리 중 강제청산 손실로 최종 잔고가 목표 아래로 내려간다. 그때 finalizer가
-- **마지막 잔고를 다시 보고** 사유를 판단하면 달성이 실패로 뒤집힌다.
--
-- 코드 규율이 아니라 제약이 막아야 한다.

SELECT pg_temp.must_pass('목표 달성으로 사유 고정', format(
  $q$ UPDATE public.paper_challenges
         SET status = 'CLOSING', close_intent = 'TARGET_REACHED',
             close_intent_at = NOW(), close_intent_event_at = NOW()
       WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

SELECT pg_temp.must_fail('달성을 실패로 마감', '23514', format(
  $q$ UPDATE public.paper_challenges
         SET status = 'CLOSED', terminal_status = 'FAILED', closed_at = NOW()
       WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- ★ **사유 자체가 바뀌지 않는다.**
--
-- 위의 `terminal_status = close_intent` CHECK는 **마감할 때** 결론이 사유와
-- 같은지만 본다. 아직 terminal_status가 NULL인 CLOSING 중에 사유를 직접
-- 덮어쓰면 CHECK 넷이 전부 통과하고, 그 뒤 같은 값으로 마감하면 아무 제약도
-- 울지 않는다 — **달성이 조용히 실패가 된다.**
--
-- 행 단위 CHECK는 이전 값을 볼 수 없으므로 BEFORE UPDATE 트리거가 막는다.
-- 여기서 그 트리거가 실제로 붙어 있는지 본다.

SELECT pg_temp.must_fail('달성을 정리 중에 실패로 바꿔치기', '23514', format(
  $q$ UPDATE public.paper_challenges SET close_intent = 'FAILED' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

SELECT pg_temp.must_fail('달성을 만료로 바꿔치기', '23514', format(
  $q$ UPDATE public.paper_challenges SET close_intent = 'EXPIRED' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

SELECT pg_temp.must_fail('달성을 취소로 바꿔치기', '23514', format(
  $q$ UPDATE public.paper_challenges SET close_intent = 'CANCELLED' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- 지우고 다시 쓰는 우회로도 막는다.
SELECT pg_temp.must_fail('사유를 지워서 되돌리기', '23514', format(
  $q$ UPDATE public.paper_challenges
         SET close_intent = NULL, close_intent_event_at = NULL WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- 사유는 그대로 두고 시각만 옮기면 "언제 달성했는가"가 움직이고,
-- 그것이 곧 만료 판정을 뒤집는다.
SELECT pg_temp.must_fail('판정 시각만 옮기기', '23514', format(
  $q$ UPDATE public.paper_challenges
         SET close_intent_event_at = NOW() + INTERVAL '1 day' WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- 재시도는 변경이 아니다. 같은 값을 다시 써도 통과해야 한다 — 여기서 막으면
-- 정상 경로의 멱등 재시도가 죽는다.
SELECT pg_temp.must_pass('같은 사유를 다시 기록', format(
  $q$ UPDATE public.paper_challenges
         SET close_intent = 'TARGET_REACHED', close_intent_at = NOW() WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- 사유와 무관한 칸은 평소처럼 갱신된다. 트리거가 UPDATE를 통째로 막으면
-- 통계도 못 적는다.
SELECT pg_temp.must_pass('통계는 계속 갱신된다', format(
  $q$ UPDATE public.paper_challenges SET peak_nav = 2100 WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

SELECT pg_temp.must_pass('고정된 사유 그대로 마감', format(
  $q$ UPDATE public.paper_challenges
         SET status = 'CLOSED', terminal_status = 'TARGET_REACHED', closed_at = NOW()
       WHERE id = %L $q$,
  (SELECT ch1 FROM ids)));

-- ══════════════ ③ 활성은 사용자당 하나 ══════════════
--
-- 위에서 ch1이 CLOSED가 됐다. 끝난 챌린지는 새 챌린지를 막지 않아야 한다.

SELECT pg_temp.must_pass('끝난 챌린지 옆에 새 챌린지', format(
  $q$ INSERT INTO public.paper_challenges
        (id, user_id, paper_account_id, status, initial_equity, target_equity,
         starts_at, ends_at)
      VALUES (%L, %L, %L, 'READY', 1000, 2000, NOW(), NOW() + INTERVAL '30 days') $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

-- 처음 정하는 것은 허용된다 — 트리거가 막는 것은 **바꾸는 것**뿐이다.
SELECT pg_temp.must_pass('사유를 처음 정한다 (NULL → TARGET_REACHED)', format(
  $q$ UPDATE public.paper_challenges
         SET close_intent = 'TARGET_REACHED', close_intent_at = NOW(),
             close_intent_event_at = NOW()
       WHERE id = %L $q$,
  (SELECT ch2 FROM ids)));

-- 그리고 그 순간부터 얼어붙는다.
SELECT pg_temp.must_fail('방금 정한 사유를 바꾸기', '23514', format(
  $q$ UPDATE public.paper_challenges SET close_intent = 'CANCELLED' WHERE id = %L $q$,
  (SELECT ch2 FROM ids)));

-- READY와 RUNNING은 **둘 다 활성**이다. 한쪽만 세면 활성이 둘이 된다.
SELECT pg_temp.must_fail('활성 챌린지 둘', '23505', format(
  $q$ INSERT INTO public.paper_challenges
        (user_id, paper_account_id, status, initial_equity, target_equity, starts_at, ends_at)
      VALUES (%L, %L, 'RUNNING', 1000, 2000, NOW(), NOW() + INTERVAL '30 days') $q$,
  (SELECT u1 FROM ids), (SELECT acct3 FROM ids)));

-- 챌린지 ↔ 전용 계좌는 1:1.
SELECT pg_temp.must_fail('한 계좌에 두 챌린지', '23505', format(
  $q$ INSERT INTO public.paper_challenges
        (user_id, paper_account_id, status, close_intent, close_intent_event_at,
         terminal_status, initial_equity, target_equity, starts_at, ends_at)
      VALUES (%L, %L, 'CLOSED', 'CANCELLED', NOW(), 'CANCELLED', 1000, 2000, NOW(), NOW() + INTERVAL '30 days') $q$,
  (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

-- ══════════════ ④ 소유권을 DB가 강제한다 ══════════════
--
-- 계좌 id만 맞고 소유자가 다르면 단일 외래키는 통과시킨다. 복합 외래키만
-- "이 계좌가 이 사용자 것인가"를 본다.

SELECT pg_temp.must_fail('남의 계좌를 챌린지에 붙임', '23503', format(
  $q$ INSERT INTO public.paper_challenges
        (user_id, paper_account_id, status, close_intent, close_intent_event_at,
         terminal_status, initial_equity, target_equity, starts_at, ends_at)
      VALUES (%L, %L, 'CLOSED', 'CANCELLED', NOW(), 'CANCELLED', 1000, 2000, NOW(), NOW() + INTERVAL '30 days') $q$,
  (SELECT u1 FROM ids), (SELECT acct_other FROM ids)));

SELECT pg_temp.must_fail('남의 챌린지에 돈 사건을 붙임', '23503', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'INITIAL_DEPOSIT', 1000, 'CHALLENGE_CREATE', 'x', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u2 FROM ids), (SELECT acct_other FROM ids)));

-- ★ **같은 사용자의 다른 계좌도 안 된다.**
--
-- `(challenge_id, user_id)`와 `(paper_account_id, user_id)` 두 외래키는 각각
-- "챌린지가 내 것인가"와 "계좌가 내 것인가"만 본다. 둘 다 만족하면서 계좌가
-- 이 챌린지의 전용 계좌가 **아닐** 수 있다. 그러면 원장은 이 챌린지 것인데
-- 돈은 다른 계좌에 있게 되고, SUM(amount) = balance가 조용히 깨진다.
SELECT pg_temp.must_fail('내 다른 계좌를 챌린지 원장에 붙임', '23503', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'REALIZED_PNL', 10, 'POSITION_CLOSE', 'sibling', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct3 FROM ids)));

-- ══════════════ ⑤ 판정 시각 ══════════════
--
-- DEFAULT가 없으므로 빠뜨리면 NOT NULL 위반으로 멈춘다. 기본값이 있으면
-- 여기가 통과해 버리고, 그때부터 기록 시각이 조용히 판정 기준이 된다.

SELECT pg_temp.must_fail('판정 시각 없는 돈 사건', '23502', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id)
      VALUES (%L, %L, %L, 'INITIAL_DEPOSIT', 1000, 'CHALLENGE_CREATE', 'seed') $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

SELECT pg_temp.must_fail('판정 시각 없는 전이 기록', '23502', format(
  $q$ INSERT INTO public.paper_challenge_transitions
        (challenge_id, user_id, from_status, to_status, transition_key)
      VALUES (%L, %L, 'READY', 'RUNNING', 'k1') $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids)));

-- 파일에 DEFAULT를 안 쓴 것과, 표에 기본값이 없는 것은 다른 사실이다.
DO $$
DECLARE v INT;
BEGIN
  SELECT count(*) INTO v
    FROM pg_attribute a
   WHERE a.attrelid IN ('public.paper_challenge_cashflows'::regclass,
                        'public.paper_challenge_transitions'::regclass)
     AND a.attname = 'event_effective_at'
     AND a.atthasdef;
  IF v <> 0 THEN
    RAISE EXCEPTION 'FAIL 판정 시각에 기본값이 붙어 있습니다 (%개)', v;
  END IF;
  RAISE NOTICE 'ok  판정 시각에 기본값 없음';
END $$;

-- ══════════════ ⑥ 돈 사건의 부호와 멱등 ══════════════

SELECT pg_temp.must_fail('수수료를 양수로', '23514', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'TRADING_FEE', 0.6, 'POSITION_CLOSE', 'p-1', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

SELECT pg_temp.must_fail('시작금을 0으로', '23514', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'INITIAL_DEPOSIT', 0, 'CHALLENGE_CREATE', 'seed', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

SELECT pg_temp.must_fail('없는 현금흐름 종류', '23514', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'WITHDRAWAL', -10, 'POSITION_CLOSE', 'p-1', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

SELECT pg_temp.must_pass('시작금 한 줄', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'INITIAL_DEPOSIT', 1000, 'CHALLENGE_CREATE', 'seed', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

SELECT pg_temp.must_fail('같은 시작금을 두 번', '23505', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'INITIAL_DEPOSIT', 1000, 'CHALLENGE_CREATE', 'seed', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

-- ★ 멱등 키에 `cashflow_type`이 들어 있어야 **같은 체결 하나**가 실현손익과
--   수수료 두 줄을 둘 다 남긴다. 체결 id 하나를 전역 키로 쓰면 하나가 사라진다.
SELECT pg_temp.must_pass('한 체결의 실현손익', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'REALIZED_PNL', 120, 'POSITION_CLOSE', 'fill-7', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

SELECT pg_temp.must_pass('같은 체결의 수수료 (사라지면 안 된다)', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'TRADING_FEE', -0.6, 'POSITION_CLOSE', 'fill-7', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

SELECT pg_temp.must_fail('같은 체결의 실현손익을 두 번', '23505', format(
  $q$ INSERT INTO public.paper_challenge_cashflows
        (challenge_id, user_id, paper_account_id, cashflow_type, amount,
         source_event_type, source_event_id, event_effective_at)
      VALUES (%L, %L, %L, 'REALIZED_PNL', 120, 'POSITION_CLOSE', 'fill-7', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids), (SELECT acct2 FROM ids)));

-- 원장이 잔고를 설명한다: 1000 + 120 - 0.6
DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT sum(amount) INTO v FROM public.paper_challenge_cashflows
   WHERE challenge_id = 'cccccccc-0000-0000-0000-000000000002'::uuid;
  IF v IS DISTINCT FROM 1119.4 THEN
    RAISE EXCEPTION 'FAIL 원장 합계가 1119.4가 아니라 %입니다', v;
  END IF;
  RAISE NOTICE 'ok  원장 합계 %', v;
END $$;

-- ══════════════ ⑦ 전이 기록 ══════════════

SELECT pg_temp.must_pass('전이 기록 한 줄', format(
  $q$ INSERT INTO public.paper_challenge_transitions
        (challenge_id, user_id, from_status, to_status, transition_key, event_effective_at)
      VALUES (%L, %L, 'READY', 'RUNNING', 'start-1', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids)));

SELECT pg_temp.must_fail('같은 사건이 두 번', '23505', format(
  $q$ INSERT INTO public.paper_challenge_transitions
        (challenge_id, user_id, from_status, to_status, transition_key, event_effective_at)
      VALUES (%L, %L, 'READY', 'RUNNING', 'start-1', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids)));

-- **감사 기록은 제품 정책을 강제하지 않는다.** 같은 상태로 가는 다른 사건이
-- 두 번 기록될 수 있어야 한다 — `UNIQUE (challenge_id, to_status)`를 두지
-- 않기로 한 결정이 실제로 지켜지는지 여기서 본다.
SELECT pg_temp.must_pass('같은 상태로 가는 다른 사건', format(
  $q$ INSERT INTO public.paper_challenge_transitions
        (challenge_id, user_id, from_status, to_status, transition_key, event_effective_at)
      VALUES (%L, %L, 'READY', 'RUNNING', 'start-2', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids)));

SELECT pg_temp.must_fail('전이 기록의 없는 상태', '23514', format(
  $q$ INSERT INTO public.paper_challenge_transitions
        (challenge_id, user_id, from_status, to_status, transition_key, event_effective_at)
      VALUES (%L, %L, 'READY', 'PAUSED', 'k-x', NOW()) $q$,
  (SELECT ch2 FROM ids), (SELECT u1 FROM ids)));

-- ══════════════ ⑧ 금액·기간 ══════════════

SELECT pg_temp.must_fail('목표가 시작금 이하', '23514', format(
  $q$ INSERT INTO public.paper_challenges
        (user_id, paper_account_id, status, close_intent, close_intent_event_at,
         terminal_status, initial_equity, target_equity, starts_at, ends_at)
      VALUES (%L, %L, 'CLOSED', 'CANCELLED', NOW(), 'CANCELLED', 1000, 1000, NOW(), NOW() + INTERVAL '30 days') $q$,
  (SELECT u1 FROM ids), (SELECT acct3 FROM ids)));

SELECT pg_temp.must_fail('끝이 시작보다 앞', '23514', format(
  $q$ INSERT INTO public.paper_challenges
        (user_id, paper_account_id, status, close_intent, close_intent_event_at,
         terminal_status, initial_equity, target_equity, starts_at, ends_at)
      VALUES (%L, %L, 'CLOSED', 'CANCELLED', NOW(), 'CANCELLED', 1000, 2000, NOW(), NOW() - INTERVAL '1 day') $q$,
  (SELECT u1 FROM ids), (SELECT acct3 FROM ids)));

SELECT pg_temp.must_fail('낙폭이 100을 넘음', '23514', format(
  $q$ INSERT INTO public.paper_challenges
        (user_id, paper_account_id, status, close_intent, close_intent_event_at,
         terminal_status, initial_equity, target_equity,
         starts_at, ends_at, max_drawdown_pct)
      VALUES (%L, %L, 'CLOSED', 'CANCELLED', NOW(), 'CANCELLED', 1000, 2000, NOW(), NOW() + INTERVAL '30 days', 120) $q$,
  (SELECT u1 FROM ids), (SELECT acct3 FROM ids)));

-- ══════════════ ⑨ RLS가 실제로 켜져 있는가 ══════════════
DO $$
DECLARE v INT;
BEGIN
  SELECT count(*) INTO v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('paper_challenges','paper_challenge_cashflows','paper_challenge_transitions')
     AND c.relrowsecurity;
  IF v <> 3 THEN RAISE EXCEPTION 'FAIL RLS가 켜진 표가 3개가 아니라 %개입니다', v; END IF;

  -- authenticated에게 쓰기를 열어 준 정책이 없어야 한다.
  SELECT count(*) INTO v FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('paper_challenges','paper_challenge_cashflows','paper_challenge_transitions')
     AND 'authenticated' = ANY(roles) AND cmd <> 'SELECT';
  IF v <> 0 THEN RAISE EXCEPTION 'FAIL authenticated 쓰기 정책이 %개 있습니다', v; END IF;
  RAISE NOTICE 'ok  RLS 3표 · authenticated는 읽기만';
END $$;

\echo '제약 시험 전부 통과'

ROLLBACK;
