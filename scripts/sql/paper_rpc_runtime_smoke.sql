-- scripts/sql/paper_rpc_runtime_smoke.sql
--
-- **만들어졌다와 돌아간다는 다른 사실이다.**
--
-- 왜 필요한가
-- ───────────
-- `075`의 `paper_open_position`은 **실행할 때마다** 42702로 터졌다. 반환 칸
-- 이름이 `status`인데 질의가 `AND status = 'open'`을 한정 없이 썼기 때문이다.
--
-- 그런데 그동안 모든 검사가 초록이었다:
--
--   · plpgsql은 질의를 **실행할 때** 계획한다 → `CREATE FUNCTION`은 성공한다
--   · 마이그레이션 재생도 성공한다 → 함수가 "생겼다"
--   · 스키마 모양 검사도 통과한다 → 시그니처가 맞다
--   · 이 저장소의 검사기 55개는 **전부 SQL 파일의 글자를 읽는다**
--
-- 함수를 한 번이라도 **부르는** 자리가 없었다. 그래서 이 파일이 있다.
--
-- 무엇을 하는가
-- ─────────────
-- 빈 DB를 다 세운 뒤, 모의투자 RPC를 **실제로 호출해서** 기대한 답이 오는지
-- 본다. 값을 만들어 내지 않는다 — 답이 다르면 그 자리에서 멈춘다.
--
-- 오류가 나야 통과인 것도 함께 본다
-- ─────────────────────────────────
-- 성공만 확인하면 "무엇이든 OPENED를 돌려주는 함수"가 만점을 받는다. 그래서
-- 중복·증거금 부족·계좌 없음처럼 **다른 답이 나와야 하는 경우**도 같이 넣는다.
--
-- 운영에 닿지 않는다
-- ──────────────────
-- 빈 로컬 DB에서만 돈다. 전부 한 트랜잭션 안에서 하고 마지막에 ROLLBACK한다 —
-- 한 줄도 남기지 않는다.

\set ON_ERROR_STOP on

BEGIN;

-- 틀린 이유로 실패한 것을 통과로 적지 않는다 — 기대 SQLSTATE까지 맞아야 한다.
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

CREATE FUNCTION pg_temp.want(p_label TEXT, p_got TEXT, p_expect TEXT)
RETURNS void AS $fn$
BEGIN
  IF p_got IS DISTINCT FROM p_expect THEN
    RAISE EXCEPTION 'FAIL % : 기대 % / 실제 %', p_label, p_expect, COALESCE(p_got, 'NULL');
  END IF;
  RAISE NOTICE 'ok  %  → %', p_label, p_got;
END $fn$ LANGUAGE plpgsql;

CREATE TEMP TABLE smoke AS SELECT
  '9a000000-0000-0000-0000-00000000000a'::uuid AS u1,
  '9a000000-0000-0000-0000-00000000000b'::uuid AS u_none;

-- 기본 계좌 하나. 이 표에는 auth.users 외래키가 없다.
INSERT INTO public.paper_accounts (user_id, is_default, balance, initial_balance)
SELECT u1, TRUE, 1000, 1000 FROM smoke;

-- ══════════════ 기본 계좌를 찾는가 ══════════════
SELECT pg_temp.want(
  'paper_default_account_id',
  (public.paper_default_account_id((SELECT u1 FROM smoke)) IS NOT NULL)::TEXT,
  'true');

-- ══════════════ ★ 진입 — 이 자리가 42702로 터지고 있었다 ══════════════
SELECT pg_temp.want('paper_open_position 정상 진입',
  (SELECT status FROM public.paper_open_position(
     (SELECT u1 FROM smoke), 'smoke-sig-1', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
     100, 100, 1, 100, 1, 100, NULL, NULL, 50, 0.5, 'ISOLATED', '2026-09-12T00:00:00Z', NULL)),
  'OPENED');

-- 포지션이 정말 생겼는가. "OPENED라고 답했다"와 "줄이 생겼다"는 다른 사실이다.
SELECT pg_temp.want('진입이 실제로 줄을 남겼다',
  (SELECT count(*)::TEXT FROM public.paper_positions
    WHERE signal_id = 'smoke-sig-1' AND status = 'open'),
  '1');

-- 수수료가 빠졌는가 (1000 − 0.5)
SELECT pg_temp.want('진입 수수료가 잔고에서 빠졌다',
  (SELECT balance::TEXT FROM public.paper_accounts WHERE user_id = (SELECT u1 FROM smoke)),
  '999.5');

-- ══════════════ 다른 답이 나와야 하는 것들 ══════════════
SELECT pg_temp.want('같은 신호는 DUPLICATE',
  (SELECT status FROM public.paper_open_position(
     (SELECT u1 FROM smoke), 'smoke-sig-1', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
     100, 100, 1, 100, 1, 100, NULL, NULL, 50, 0.5, 'ISOLATED', '2026-09-12T00:00:00Z', NULL)),
  'DUPLICATE');

SELECT pg_temp.want('증거금이 모자라면 INSUFFICIENT_MARGIN',
  (SELECT status FROM public.paper_open_position(
     (SELECT u1 FROM smoke), 'smoke-sig-2', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
     100, 100, 1, 100000, 1, 100000, NULL, NULL, 50, 0.5, 'ISOLATED', '2026-09-12T00:00:00Z', NULL)),
  'INSUFFICIENT_MARGIN');

SELECT pg_temp.want('계좌가 없으면 NO_ACCOUNT — 만들지 않는다',
  (SELECT status FROM public.paper_open_position(
     (SELECT u_none FROM smoke), 'smoke-sig-3', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
     100, 100, 1, 100, 1, 100, NULL, NULL, 50, 0.5, 'ISOLATED', '2026-09-12T00:00:00Z', NULL)),
  'NO_ACCOUNT');

-- ══════════════ 청산 정산 ══════════════
SELECT pg_temp.want('paper_settle_close 정산',
  (SELECT settled::TEXT FROM public.paper_settle_close(
     (SELECT id FROM public.paper_positions WHERE signal_id = 'smoke-sig-1'),
     110, 'TP', 0.6, 10, 9.4, 1.0, '2026-09-12T00:00:00Z')),
  'true');

-- 같은 포지션을 다시 닫으면 false. 계좌는 한 번만 움직인다.
SELECT pg_temp.want('이미 닫힌 포지션은 다시 정산하지 않는다',
  (SELECT settled::TEXT FROM public.paper_settle_close(
     (SELECT id FROM public.paper_positions WHERE signal_id = 'smoke-sig-1'),
     110, 'TP', 0.6, 10, 9.4, 1.0, '2026-09-12T00:00:00Z')),
  'false');

-- 999.5 + 10 − 0.6 = 1008.9  (두 번째 정산이 또 밀었다면 1018.3이 된다)
SELECT pg_temp.want('정산이 정확히 한 번만 반영됐다',
  (SELECT balance::TEXT FROM public.paper_accounts WHERE user_id = (SELECT u1 FROM smoke)),
  '1008.9');

-- ══════════════ 입금 · 수수료 ══════════════
SELECT pg_temp.want('paper_deposit이 새 잔고를 돌려준다',
  public.paper_deposit((SELECT u1 FROM smoke), 100)::TEXT,
  '1108.9');

-- `RETURNS VOID`라 돌려주는 값이 없다. **효과로 확인한다** — 값을 물으면
-- 무엇을 물어도 그럴듯한 답이 나와서 아무것도 지키지 못한다.
SELECT public.paper_apply_entry_fee((SELECT u1 FROM smoke), 1);

SELECT pg_temp.want('paper_apply_entry_fee가 실제로 수수료를 뺐다',
  (SELECT balance::TEXT FROM public.paper_accounts WHERE user_id = (SELECT u1 FROM smoke)),
  '1107.9');

-- ══════════════ 사건 시각이 없으면 아무것도 하지 않는다 ══════════════
--
-- 칸의 NOT NULL만 믿으면 원장 INSERT까지 가서야 실패한다. 그 사이에 이미
-- 포지션을 만들고 잠금을 잡은 뒤다. **함수 진입에서 거부해야** 한다.
-- 그래서 '거부했다'로 끝내지 않고 **아무 줄도 안 생겼는지**까지 본다.
SELECT pg_temp.must_fail('진입: 사건 시각 없으면 거부 (진입 계약 22004)', '22004', $q$
  SELECT status FROM public.paper_open_position(
    (SELECT u1 FROM smoke), 'smoke-sig-noev', NULL, NULL, 'BTCUSDT', 'USDM', 'LONG',
    100, 100, 1, 100, 1, 100, NULL, NULL, 50, 0.5, 'ISOLATED', NULL, NULL)
$q$);

SELECT pg_temp.want('거부된 진입은 줄을 남기지 않았다',
  (SELECT count(*)::TEXT FROM public.paper_positions WHERE signal_id = 'smoke-sig-noev'),
  '0');

SELECT pg_temp.want('거부된 진입은 잔고를 건드리지 않았다',
  (SELECT balance::TEXT FROM public.paper_accounts WHERE user_id = (SELECT u1 FROM smoke)),
  '1107.9');

\echo 'RPC 실행 연기 전부 통과'

ROLLBACK;
