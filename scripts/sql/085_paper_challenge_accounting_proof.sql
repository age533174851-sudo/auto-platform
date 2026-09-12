-- scripts/sql/085_paper_challenge_accounting_proof.sql
--
-- **챌린지 회계가 실제로 돌아가는지 실행해서 본다.**
--
-- `083`은 자리를, `085`는 경로를 만들었다. 이 파일은 그 경로에 돈을 실제로
-- 흘려보내고, **기대한 답이 아니면 그 자리에서 멈춘다.**
--
-- 왜 실행해서 보는가
-- ──────────────────
-- `075`의 `paper_open_position`은 글자로 보면 멀쩡했고 검사기 55개가 전부
-- 초록이었다. 실행할 때마다 42702로 터지고 있었다는 것은 **한 번 불러 보고야**
-- 알았다. 회계는 그보다 조용히 어긋난다 — 원장과 잔고가 갈리면 한참 뒤
-- "수익률이 이상하다"로 나타난다.
--
-- 무엇을 지키는가
-- ───────────────
-- 불변식은 하나다: **SUM(cashflows.amount) = paper_accounts.balance.**
-- 아래 모든 검사는 결국 이것이 깨지지 않는지 본다.
--
-- 오류가 나야 통과인 것
-- ─────────────────────
-- 성공만 보면 "무엇이든 받아 주는 함수"가 만점을 받는다. 그래서 거부돼야 하는
-- 것(사건 시각 없음 · legacy 경로의 챌린지 계좌 지목 · 기간 밖 달성)도 같이
-- 넣고, **기대한 SQLSTATE까지** 맞아야 통과로 적는다.
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

-- 틀린 이유로 실패한 것을 통과로 적지 않는다.
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

-- **불변식을 한 줄로 확인하는 자리.** 검사마다 이걸 부른다.
CREATE FUNCTION pg_temp.invariant(p_label TEXT, p_challenge UUID)
RETURNS void AS $fn$
DECLARE v_bal NUMERIC; v_led NUMERIC; v_acc UUID;
BEGIN
  SELECT c.paper_account_id INTO v_acc FROM public.paper_challenges c WHERE c.id = p_challenge;
  SELECT a.balance INTO v_bal FROM public.paper_accounts a WHERE a.id = v_acc;
  SELECT COALESCE(SUM(f.amount), 0) INTO v_led
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = p_challenge;
  IF v_bal IS DISTINCT FROM v_led THEN
    RAISE EXCEPTION 'FAIL % : 원장 % ≠ 잔고 %', p_label, v_led, v_bal;
  END IF;
  RAISE NOTICE 'ok  %  → SUM(원장)=잔고=%', p_label, v_bal;
END $fn$ LANGUAGE plpgsql;

CREATE TEMP TABLE t AS SELECT
  'ca000000-0000-0000-0000-00000000000a'::uuid AS u1,
  'ca000000-0000-0000-0000-00000000000b'::uuid AS u2,
  '2026-03-01T00:00:00Z'::timestamptz AS t_start,
  '2026-03-31T00:00:00Z'::timestamptz AS t_end,
  '2026-03-10T00:00:00Z'::timestamptz AS t_mid,
  '2026-04-05T00:00:00Z'::timestamptz AS t_after;

CREATE TEMP TABLE h (k TEXT PRIMARY KEY, v UUID);

-- ══════════════════ ① 생성 ══════════════════
--
-- 시작금 1000, 목표 1200, 실패선 900.
INSERT INTO h
SELECT 'ch', challenge_id FROM t, public.paper_challenge_create(
  t.u1, 1000, 1200, 900, t.t_start, t.t_end, t.t_mid);

INSERT INTO h SELECT 'acc', c.paper_account_id
  FROM public.paper_challenges c WHERE c.id = (SELECT v FROM h WHERE k='ch');

SELECT pg_temp.want('생성: 상태 RUNNING (기간이 이미 시작됐다)',
  (SELECT c.status FROM public.paper_challenges c WHERE c.id = (SELECT v FROM h WHERE k='ch')),
  'RUNNING');

SELECT pg_temp.want('생성: 전용 계좌는 기본 계좌가 아니다',
  (SELECT a.is_default::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  'false');

SELECT pg_temp.want('생성: 잔고는 원장으로 들어왔다 (계좌를 시작금으로 만들지 않았다)',
  (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '1000');

SELECT pg_temp.want('생성: initial_balance는 수익률의 분모다',
  (SELECT a.initial_balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '1000');

SELECT pg_temp.want('생성: INITIAL_DEPOSIT 정확히 1줄',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id = (SELECT v FROM h WHERE k='ch') AND f.cashflow_type = 'INITIAL_DEPOSIT'),
  '1');

SELECT pg_temp.invariant('생성 직후 불변식', (SELECT v FROM h WHERE k='ch'));

-- ══════════════════ ② 같은 사용자가 다시 눌렀다 ══════════════════
--
-- **오류가 아니다.** 이미 있는 것을 돌려주고 새로 만들지 않는다.
SELECT pg_temp.want('재생성: created=false',
  (SELECT created::TEXT FROM t, public.paper_challenge_create(
     t.u1, 1000, 1200, 900, t.t_start, t.t_end, t.t_mid)),
  'false');

SELECT pg_temp.want('재생성: 챌린지는 여전히 1개',
  (SELECT count(*)::TEXT FROM public.paper_challenges c WHERE c.user_id = (SELECT u1 FROM t)),
  '1');

SELECT pg_temp.want('재생성: 계좌도 여전히 1개',
  (SELECT count(*)::TEXT FROM public.paper_accounts a WHERE a.user_id = (SELECT u1 FROM t)),
  '1');

SELECT pg_temp.want('재생성: INITIAL_DEPOSIT은 여전히 1줄 — 두 번 들어가지 않았다',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id = (SELECT v FROM h WHERE k='ch') AND f.cashflow_type = 'INITIAL_DEPOSIT'),
  '1');

SELECT pg_temp.invariant('재생성 뒤 불변식', (SELECT v FROM h WHERE k='ch'));

-- ══════════════════ ③ 사건 시각이 없으면 돈을 건드리지 않는다 ══════════════════
SELECT pg_temp.must_fail('생성: 사건 시각 없으면 거부 (진입 계약 22004)', '22004', $q$
  SELECT challenge_id FROM public.paper_challenge_create(
    'ca000000-0000-0000-0000-00000000000b'::uuid, 1000, 1200, 900,
    '2026-03-01T00:00:00Z'::timestamptz, '2026-03-31T00:00:00Z'::timestamptz, NULL)
$q$);

SELECT pg_temp.want('거부된 생성은 계좌를 만들지 않았다',
  (SELECT count(*)::TEXT FROM public.paper_accounts a WHERE a.user_id = (SELECT u2 FROM t)),
  '0');

SELECT pg_temp.want('거부된 생성은 챌린지를 만들지 않았다',
  (SELECT count(*)::TEXT FROM public.paper_challenges c WHERE c.user_id = (SELECT u2 FROM t)),
  '0');

-- ══════════════════ ④ legacy 경로는 챌린지 계좌에서 멈춘다 ══════════════════
--
-- 이 계좌는 기본 계좌가 아니므로 `p_paper_account_id`로 **직접 지목**해야
-- 닿는다. 지목하면 거부한다 — 마감된 원장에 설명되지 않는 돈이 들어오는 것을
-- 막는 것이 핵심이다.
SELECT pg_temp.must_fail('legacy paper_deposit: 챌린지 계좌 지목은 거부', 'P0001', $q$
  SELECT public.paper_deposit(
    'ca000000-0000-0000-0000-00000000000a'::uuid, 500,
    (SELECT v FROM h WHERE k='acc'))
$q$);

SELECT pg_temp.must_fail('legacy paper_apply_entry_fee: 챌린지 계좌 지목은 거부', 'P0001', $q$
  SELECT public.paper_apply_entry_fee(
    'ca000000-0000-0000-0000-00000000000a'::uuid, 1,
    (SELECT v FROM h WHERE k='acc'))
$q$);

SELECT pg_temp.want('legacy 거부 뒤에도 잔고 그대로',
  (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '1000');

SELECT pg_temp.invariant('legacy 거부 뒤 불변식', (SELECT v FROM h WHERE k='ch'));

-- ══════════════════ ⑤ 진입 — 수수료가 원장에 남는다 ══════════════════
INSERT INTO h
SELECT 'pos1', position_id FROM t, public.paper_open_position(
  t.u1, 'ch-sig-1', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
  100, 100, 1, 100, 1, 100, NULL, NULL, 50, 2, 'ISOLATED',
  t.t_mid, (SELECT v FROM h WHERE k='acc'));

SELECT pg_temp.want('진입: 포지션이 생겼다',
  (SELECT (v IS NOT NULL)::TEXT FROM h WHERE k='pos1'), 'true');

SELECT pg_temp.want('진입: 수수료가 TRADING_FEE 음수 1줄로 남았다',
  (SELECT f.amount::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id = (SELECT v FROM h WHERE k='ch')
      AND f.source_event_type = 'POSITION_OPEN'),
  '-2');

SELECT pg_temp.want('진입: 잔고 1000 − 2',
  (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '998');

SELECT pg_temp.invariant('진입 뒤 불변식', (SELECT v FROM h WHERE k='ch'));

-- ══════════════════ ⑥ 청산 — 한 체결에 두 줄 ══════════════════
--
-- gross 실현손익 +250, 청산 수수료 3. **순액 247을 한 줄로 적지 않는다** —
-- 그러면 수수료가 어디로 갔는지 설명할 수 없고, 총수수료와 원장이 갈린다.
SELECT pg_temp.want('청산: settled=true',
  (SELECT settled::TEXT FROM t, public.paper_settle_close(
     (SELECT v FROM h WHERE k='pos1'), 350, 'TP', 3, 250, 247, 25.0, t.t_mid)),
  'true');

SELECT pg_temp.want('청산: REALIZED_PNL은 gross 그대로 1줄',
  (SELECT f.amount::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id = (SELECT v FROM h WHERE k='ch')
      AND f.cashflow_type = 'REALIZED_PNL' AND f.source_event_type = 'POSITION_CLOSE'),
  '250');

SELECT pg_temp.want('청산: TRADING_FEE는 음수 1줄',
  (SELECT f.amount::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id = (SELECT v FROM h WHERE k='ch')
      AND f.cashflow_type = 'TRADING_FEE' AND f.source_event_type = 'POSITION_CLOSE'),
  '-3');

SELECT pg_temp.want('청산: 그 체결의 원장 줄은 정확히 2개',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id = (SELECT v FROM h WHERE k='ch')
      AND f.source_event_type = 'POSITION_CLOSE'),
  '2');

-- 998 + 250 − 3 = 1245  → 목표 1200을 넘었다
SELECT pg_temp.want('청산: 잔고 1245',
  (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '1245');

SELECT pg_temp.invariant('청산 뒤 불변식', (SELECT v FROM h WHERE k='ch'));

-- ══════════════════ ⑦ 달성 판정 ══════════════════
SELECT pg_temp.want('판정: 기간 안에서 목표를 넘었으므로 TARGET_REACHED',
  (SELECT c.close_intent FROM public.paper_challenges c WHERE c.id = (SELECT v FROM h WHERE k='ch')),
  'TARGET_REACHED');

SELECT pg_temp.want('판정: 상태는 CLOSING',
  (SELECT c.status FROM public.paper_challenges c WHERE c.id = (SELECT v FROM h WHERE k='ch')),
  'CLOSING');

SELECT pg_temp.want('판정: 사유가 정해진 시각은 사건 시각이다 (NOW()가 아니다)',
  (SELECT c.close_intent_event_at::TEXT FROM public.paper_challenges c
    WHERE c.id = (SELECT v FROM h WHERE k='ch')),
  (SELECT t_mid::TEXT FROM t));

SELECT pg_temp.want('판정: 전이 기록 1줄',
  (SELECT count(*)::TEXT FROM public.paper_challenge_transitions r
    WHERE r.challenge_id = (SELECT v FROM h WHERE k='ch') AND r.to_status = 'CLOSING'),
  '1');

-- ══════════════════ ⑧ 같은 사건을 다시 보내면 ══════════════════
--
-- 포지션 CAS가 먼저 막는다(settled=false). 그래서 원장도 잔고도 그대로다.
SELECT pg_temp.want('재시도: settled=false',
  (SELECT settled::TEXT FROM t, public.paper_settle_close(
     (SELECT v FROM h WHERE k='pos1'), 350, 'TP', 3, 250, 247, 25.0, t.t_mid)),
  'false');

SELECT pg_temp.want('재시도: 그 체결의 원장 줄은 여전히 2개',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id = (SELECT v FROM h WHERE k='ch')
      AND f.source_event_type = 'POSITION_CLOSE'),
  '2');

SELECT pg_temp.want('재시도: 잔고도 여전히 1245',
  (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '1245');

SELECT pg_temp.invariant('재시도 뒤 불변식', (SELECT v FROM h WHERE k='ch'));

-- ══════════════════ ⑨ 원장 멱등을 직접 때린다 ══════════════════
--
-- 포지션 CAS를 우회해서 **같은 사건을 원장 경로에 직접** 다시 넣어 본다.
-- 여기서 잔고가 또 밀리면, CAS가 없는 다른 경로가 생기는 순간 이중 반영이다.
SELECT pg_temp.want('원장 멱등: 같은 사건은 FALSE를 돌려준다',
  public.paper_money_apply(
    (SELECT v FROM h WHERE k='acc'), (SELECT u1 FROM t),
    'REALIZED_PNL', 250, 'POSITION_CLOSE',
    (SELECT v::TEXT FROM h WHERE k='pos1'), (SELECT t_mid FROM t))::TEXT,
  'false');

SELECT pg_temp.want('원장 멱등: 잔고를 다시 밀지 않았다',
  (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '1245');

SELECT pg_temp.invariant('원장 멱등 뒤 불변식', (SELECT v FROM h WHERE k='ch'));

-- ══════════════════ ⑩ 달성 뒤에는 사유가 바뀌지 않는다 ══════════════════
--
-- 달성한 챌린지가 그 뒤 큰 손실로 실패선 아래로 내려가도 **FAILED로 바뀌지
-- 않는다.** 판정 함수가 `close_intent IS NOT NULL`에서 멈추고, 그래도 새어
-- 나가면 `083`의 freeze 트리거가 거부한다.
INSERT INTO h
SELECT 'pos2', position_id FROM t, public.paper_open_position(
  t.u1, 'ch-sig-2', NULL, NULL, 'ETHUSDT', 'USDM', 'LONG',
  100, 100, 1, 100, 1, 100, NULL, NULL, 50, 1, 'ISOLATED',
  t.t_mid, (SELECT v FROM h WHERE k='acc'));

-- 실현손익 −500 → 1245 − 1 − 500 − 1 = 743  → 실패선 900 아래
SELECT pg_temp.want('달성 뒤 강제청산: settled=true',
  (SELECT settled::TEXT FROM t, public.paper_settle_close(
     (SELECT v FROM h WHERE k='pos2'), 10, 'SL', 1, -500, -501, -50.0, t.t_mid)),
  'true');

SELECT pg_temp.want('달성 뒤 강제청산: 잔고는 실패선 아래로 내려갔다',
  (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = (SELECT v FROM h WHERE k='acc')),
  '743');

SELECT pg_temp.want('★ 사유는 여전히 TARGET_REACHED — 재평가하지 않는다',
  (SELECT c.close_intent FROM public.paper_challenges c WHERE c.id = (SELECT v FROM h WHERE k='ch')),
  'TARGET_REACHED');

SELECT pg_temp.want('★ 사유가 정해진 시각도 그대로',
  (SELECT c.close_intent_event_at::TEXT FROM public.paper_challenges c
    WHERE c.id = (SELECT v FROM h WHERE k='ch')),
  (SELECT t_mid::TEXT FROM t));

SELECT pg_temp.invariant('강제청산 뒤 불변식', (SELECT v FROM h WHERE k='ch'));

-- DB가 직접 거부하는지도 본다 (083의 freeze 트리거).
SELECT pg_temp.must_fail('DB가 사유 변경을 거부한다', '23514', $q$
  UPDATE public.paper_challenges
     SET close_intent = 'FAILED'
   WHERE id = (SELECT v FROM h WHERE k='ch')
$q$);

-- ══════════════════ ⑪ 유효기간 경계 ══════════════════
--
-- **달성은 기간 안에서만 인정한다.** 경계를 어느 쪽으로 두는지가 곧 계약이다:
-- `ends_at`과 **같은 순간은 안**이다(`<=`). 하루 지난 통과는 달성이 아니다.
--
-- 실패선은 기간 조건을 걸지 않는다 — 돈이 없어진 것은 시각과 무관하다.

-- 시나리오를 한 자리에서 만든다. 같은 절차를 세 번 적으면 언젠가 갈린다.
CREATE FUNCTION pg_temp.run_case(
  p_user UUID, p_sig TEXT, p_gross NUMERIC, p_event TIMESTAMPTZ)
RETURNS TEXT AS $fn$
DECLARE v_ch UUID; v_acc UUID; v_pos UUID;
BEGIN
  SELECT challenge_id, paper_account_id INTO v_ch, v_acc
    FROM public.paper_challenge_create(
      p_user, 1000, 1200, 900,
      '2026-03-01T00:00:00Z'::timestamptz, '2026-03-31T00:00:00Z'::timestamptz,
      '2026-03-02T00:00:00Z'::timestamptz);

  SELECT position_id INTO v_pos FROM public.paper_open_position(
    p_user, p_sig, NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
    100, 100, 1, 100, 1, 100, NULL, NULL, 50, 1, 'ISOLATED',
    '2026-03-02T00:00:00Z'::timestamptz, v_acc);

  -- **아직 실현된 것이 없다.** 열린 포지션이 얼마짜리든 판정은 움직이지 않는다.
  IF (SELECT c.close_intent FROM public.paper_challenges c WHERE c.id = v_ch) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL %: 진입만으로 사유가 정해졌다', p_sig;
  END IF;

  PERFORM public.paper_settle_close(v_pos, 350, 'TP', 1, p_gross, p_gross - 1, 1, p_event);

  -- 원장과 잔고가 갈리지 않았는지 매번 본다.
  IF (SELECT a.balance FROM public.paper_accounts a WHERE a.id = v_acc)
     IS DISTINCT FROM
     (SELECT COALESCE(SUM(f.amount), 0) FROM public.paper_challenge_cashflows f
       WHERE f.challenge_id = v_ch) THEN
    RAISE EXCEPTION 'FAIL %: 원장과 잔고가 갈렸다', p_sig;
  END IF;

  RETURN COALESCE(
    (SELECT c.close_intent FROM public.paper_challenges c WHERE c.id = v_ch), 'NULL');
END $fn$ LANGUAGE plpgsql;

-- 1000 − 1 + 300 − 1 = 1298 ≥ 1200. 사건 시각이 **ends_at과 같은 순간**이다.
SELECT pg_temp.want('경계: ends_at과 같은 순간의 달성은 인정한다',
  pg_temp.run_case('ca000000-0000-0000-0000-00000000000c'::uuid, 'edge-eq', 300,
                   '2026-03-31T00:00:00Z'::timestamptz),
  'TARGET_REACHED');

-- 같은 금액인데 1초 늦었다. **달성이 아니다.**
SELECT pg_temp.want('경계: ends_at을 1초 지난 통과는 달성이 아니다',
  pg_temp.run_case('ca000000-0000-0000-0000-00000000000d'::uuid, 'edge-1s', 300,
                   '2026-03-31T00:00:01Z'::timestamptz),
  'NULL');

-- starts_at보다 이른 사건도 달성이 아니다.
SELECT pg_temp.want('경계: starts_at 이전의 통과도 달성이 아니다',
  pg_temp.run_case('ca000000-0000-0000-0000-00000000000e'::uuid, 'edge-pre', 300,
                   '2026-02-28T23:59:59Z'::timestamptz),
  'NULL');

-- ══════════════════ ⑫ 실패는 실현 잔고로만 판정한다 ══════════════════
--
-- 1000 − 1 − 160 − 1 = 838 ≤ 900.
SELECT pg_temp.want('실패: 실현 잔고가 실패선 아래로 내려가면 FAILED',
  pg_temp.run_case('ca000000-0000-0000-0000-00000000000f'::uuid, 'fail-1', -160,
                   '2026-03-10T00:00:00Z'::timestamptz),
  'FAILED');

-- 실패선은 기간 밖에서도 판정한다 — 돈이 없어진 것은 시각과 무관하다.
SELECT pg_temp.want('실패: 기간을 지난 뒤에도 실패는 실패다',
  pg_temp.run_case('ca000000-0000-0000-0000-000000000010'::uuid, 'fail-late', -160,
                   '2026-04-05T00:00:00Z'::timestamptz),
  'FAILED');

-- 아슬아슬하게 안 내려갔으면 아무 사유도 없다.
-- 1000 − 1 − 98 − 1 = 900 ≤ 900 이므로 실패다. 1 더 벌면 901로 살아난다.
SELECT pg_temp.want('실패: 실패선과 같은 값은 실패다 (<=)',
  pg_temp.run_case('ca000000-0000-0000-0000-000000000011'::uuid, 'fail-eq', -98,
                   '2026-03-10T00:00:00Z'::timestamptz),
  'FAILED');

SELECT pg_temp.want('실패: 실패선보다 1 위면 아무 사유도 정하지 않는다',
  pg_temp.run_case('ca000000-0000-0000-0000-000000000012'::uuid, 'fail-above', -97,
                   '2026-03-10T00:00:00Z'::timestamptz),
  'NULL');

-- ══════════════════ ⑬ 진입 수수료만으로 실패선을 넘길 수 있다 ══════════════════
--
-- **판정을 청산에만 두면 이 경우를 놓친다.** 수수료도 실현 잔고를 움직인다.
-- 그래서 진입 경로가 청산과 **같은 판정 함수**를 부른다.
--
-- 시작금 1000, 실패선 900. 진입 수수료 150 → 잔고 850. 청산은 없다.
CREATE FUNCTION pg_temp.open_only_case(p_user UUID, p_sig TEXT, p_fee NUMERIC)
RETURNS TEXT AS $fn$
DECLARE v_ch UUID; v_acc UUID;
BEGIN
  SELECT challenge_id, paper_account_id INTO v_ch, v_acc
    FROM public.paper_challenge_create(
      p_user, 1000, 1200, 900,
      '2026-03-01T00:00:00Z'::timestamptz, '2026-03-31T00:00:00Z'::timestamptz,
      '2026-03-02T00:00:00Z'::timestamptz);

  PERFORM public.paper_open_position(
    p_user, p_sig, NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
    100, 100, 1, 100, 1, 100, NULL, NULL, 50, p_fee, 'ISOLATED',
    '2026-03-02T00:00:00Z'::timestamptz, v_acc);

  IF (SELECT a.balance FROM public.paper_accounts a WHERE a.id = v_acc)
     IS DISTINCT FROM
     (SELECT COALESCE(SUM(f.amount), 0) FROM public.paper_challenge_cashflows f
       WHERE f.challenge_id = v_ch) THEN
    RAISE EXCEPTION 'FAIL %: 원장과 잔고가 갈렸다', p_sig;
  END IF;

  RETURN COALESCE(
    (SELECT c.close_intent FROM public.paper_challenges c WHERE c.id = v_ch), 'NULL');
END $fn$ LANGUAGE plpgsql;

SELECT pg_temp.want('★ 진입 수수료가 실패선을 넘기면 그 자리에서 FAILED',
  pg_temp.open_only_case('ca000000-0000-0000-0000-000000000013'::uuid, 'openfee-1', 150),
  'FAILED');

SELECT pg_temp.want('진입 수수료가 실패선 위에 남으면 사유 없음',
  pg_temp.open_only_case('ca000000-0000-0000-0000-000000000014'::uuid, 'openfee-2', 50),
  'NULL');

-- ══════════════════ ⑭ 청산도 같은 진입 계약이다 ══════════════════
--
-- 시각이 없으면 **포지션을 닫지도 않는다.** 원장까지 갔다가 실패하면 그
-- 사이에 이미 계좌를 잠그고 선점까지 한 뒤다.
CREATE FUNCTION pg_temp.close_no_event_case(p_user UUID, p_sig TEXT)
RETURNS TEXT AS $fn$
DECLARE v_acc UUID; v_pos UUID; v_state TEXT;
BEGIN
  SELECT paper_account_id INTO v_acc FROM public.paper_challenge_create(
    p_user, 1000, 1200, 900,
    '2026-03-01T00:00:00Z'::timestamptz, '2026-03-31T00:00:00Z'::timestamptz,
    '2026-03-02T00:00:00Z'::timestamptz);
  SELECT position_id INTO v_pos FROM public.paper_open_position(
    p_user, p_sig, NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
    100, 100, 1, 100, 1, 100, NULL, NULL, 50, 1, 'ISOLATED',
    '2026-03-02T00:00:00Z'::timestamptz, v_acc);

  BEGIN
    PERFORM public.paper_settle_close(v_pos, 350, 'TP', 1, 250, 249, 25, NULL);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;

  -- 거부 코드 · 포지션이 여전히 열려 있는지 · 잔고가 그대로인지를 한 줄로.
  RETURN COALESCE(v_state, 'NO_ERROR')
      || '/' || (SELECT pp.status FROM public.paper_positions pp WHERE pp.id = v_pos)
      || '/' || (SELECT a.balance::TEXT FROM public.paper_accounts a WHERE a.id = v_acc);
END $fn$ LANGUAGE plpgsql;

SELECT pg_temp.want('청산: 시각 없으면 22004로 거부 · 포지션 open · 잔고 999 그대로',
  pg_temp.close_no_event_case('ca000000-0000-0000-0000-000000000015'::uuid, 'noev-close'),
  '22004/open/999');

\echo '챌린지 회계 실행 증명 전부 통과'

ROLLBACK;
