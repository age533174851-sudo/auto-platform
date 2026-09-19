-- scripts/sql/088_paper_spot_holdings_proof.sql
--
-- **현물 분할매도 회계가 실제로 돌아가는지 실행해서 본다.**
--
-- 이 파일이 지키려는 것은 한 문장이다:
--
--   **25% + 25% + 남은 전부**로 팔든 **한 번에 100%**로 팔든,
--   최종 보유수량·잔고·손익·수수료·원장·거래통계가 **정확히 같아야 한다.**
--
-- 왜 실행해서 보는가
-- ──────────────────
-- 설계 단계에서 JS double로 같은 계산을 돌렸더니 두 경로가 -7.1e-15만큼
-- 달랐다. 그 정도 차이는 화면에서 안 보이고, 검사기도 시험도 잡지 않는다 —
-- 그런데 그것이 lot에 dust로 남으면 **영원히 안 풀리는 잔량**이 된다.
-- NUMERIC에서 정말 0인지는 실행해야 안다.
--
-- 불변식
-- ──────
-- `SUM(cashflows.amount) = paper_accounts.balance`. 매 단계 확인한다.
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

-- 불변식 한 줄.
CREATE FUNCTION pg_temp.invariant(p_label TEXT, p_challenge UUID)
RETURNS void AS $fn$
DECLARE v_bal NUMERIC; v_led NUMERIC; v_acc UUID;
BEGIN
  SELECT c.paper_account_id INTO v_acc FROM public.paper_challenges c WHERE c.id = p_challenge;
  SELECT a.balance INTO v_bal FROM public.paper_accounts a WHERE a.id = v_acc;
  SELECT COALESCE(SUM(f.amount), 0) INTO v_led
    FROM public.paper_challenge_cashflows f WHERE f.challenge_id = p_challenge;
  IF v_bal IS DISTINCT FROM v_led THEN
    RAISE EXCEPTION 'FAIL 불변식(%) : 잔고 % / 원장 %', p_label, v_bal, v_led;
  END IF;
  RAISE NOTICE 'ok  불변식 %  → 잔고=원장=%', p_label, v_bal;
END $fn$ LANGUAGE plpgsql;

-- 현물 lot 하나를 여는 짧은 이름. `paperPlan`과 같은 식이다:
--   notional = 요청수량 × 기준가 · margin = notional(배율 1) · fee = notional × 수수료율
CREATE FUNCTION pg_temp.buy(
  p_user UUID, p_acct UUID, p_sig TEXT, p_sym TEXT,
  p_mark NUMERIC, p_qty NUMERIC, p_feerate NUMERIC, p_at TIMESTAMPTZ)
RETURNS UUID AS $fn$
DECLARE v_fill NUMERIC; v_not NUMERIC; v_q NUMERIC; v_fee NUMERIC; v_id UUID;
BEGIN
  v_fill := p_mark * (1 + 0.0005);           -- 슬리피지 0.05%
  v_not  := p_qty * p_mark;
  v_q    := v_not / v_fill;
  v_fee  := v_not * p_feerate;
  SELECT position_id INTO v_id FROM public.paper_open_position(
    p_user, p_sig, NULL, NULL, p_sym, 'SPOT', 'LONG',
    p_mark, v_fill, v_q, v_not, 1, v_not, NULL, NULL, NULL, v_fee, 'ISOLATED',
    p_at, p_acct);
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;

CREATE TEMP TABLE t AS SELECT
  'cb000000-0000-0000-0000-000000000001'::uuid AS uA,
  'cb000000-0000-0000-0000-000000000002'::uuid AS uB,
  'cb000000-0000-0000-0000-000000000003'::uuid AS uC,
  NOW() - INTERVAL '1 hour' AS t_start,
  NOW() + INTERVAL '10 days' AS t_end,
  NOW() AS t_now;

CREATE TEMP TABLE h (k TEXT PRIMARY KEY, v UUID);

-- ══════════════════ 설정: 똑같은 계좌 둘 ══════════════════
--
-- A는 나눠 팔고, B는 한 번에 판다. 시작금·매수·청산가·수수료율이 같다.
INSERT INTO h SELECT 'chA', challenge_id FROM t, public.paper_challenge_create(
  t.uA, 10000, 1000000, 1, t.t_start, t.t_end, t.t_now);
INSERT INTO h SELECT 'chB', challenge_id FROM t, public.paper_challenge_create(
  t.uB, 10000, 1000000, 1, t.t_start, t.t_end, t.t_now);
INSERT INTO h SELECT 'accA', c.paper_account_id FROM public.paper_challenges c
  WHERE c.id = (SELECT v FROM h WHERE k='chA');
INSERT INTO h SELECT 'accB', c.paper_account_id FROM public.paper_challenges c
  WHERE c.id = (SELECT v FROM h WHERE k='chB');

SELECT pg_temp.invariant('생성 A', (SELECT v FROM h WHERE k='chA'));
SELECT pg_temp.invariant('생성 B', (SELECT v FROM h WHERE k='chB'));

-- ══════════════════ E1 · 1 lot — 25 + 25 + 100 vs 100 ══════════════════
INSERT INTO h SELECT 'pA1', pg_temp.buy(
  (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'),
  'e1-a', 'BTCUSDT', 60000, 0.01, 0.0005, (SELECT t_now FROM t));
INSERT INTO h SELECT 'pB1', pg_temp.buy(
  (SELECT uB FROM t), (SELECT v FROM h WHERE k='accB'),
  'e1-b', 'BTCUSDT', 60000, 0.01, 0.0005, (SELECT t_now FROM t));

SELECT pg_temp.want('진입: 원 체결 증거가 남은 상태와 같다',
  (SELECT (pp.open_quantity = pp.quantity AND pp.open_notional = pp.notional
           AND pp.open_margin = pp.margin
           AND pp.remaining_entry_fee_basis = pp.entry_fee)::TEXT
     FROM public.paper_positions pp WHERE pp.id = (SELECT v FROM h WHERE k='pA1')),
  'true');

SELECT pg_temp.invariant('매수 A', (SELECT v FROM h WHERE k='chA'));

-- A: 25% → 25% → 남은 전부
SELECT pg_temp.want('A 25%: SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'BTCUSDT',
     25, NULL, 66000, 0.0005, 'cs-a-1', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.invariant('A 매도1', (SELECT v FROM h WHERE k='chA'));

SELECT pg_temp.want('A 25%(2): SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'BTCUSDT',
     25, NULL, 66000, 0.0005, 'cs-a-2', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.invariant('A 매도2', (SELECT v FROM h WHERE k='chA'));

SELECT pg_temp.want('A 100%: SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'BTCUSDT',
     100, NULL, 66000, 0.0005, 'cs-a-3', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.invariant('A 매도3', (SELECT v FROM h WHERE k='chA'));

-- B: 한 번에 100%
SELECT pg_temp.want('B 100%: SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uB FROM t), (SELECT v FROM h WHERE k='accB'), 'SPOT', 'BTCUSDT',
     100, NULL, 66000, 0.0005, 'cs-b-1', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.invariant('B 매도', (SELECT v FROM h WHERE k='chB'));

-- ── E1 등가 ──
SELECT pg_temp.want('E1 잔고가 정확히 같다',
  (SELECT (a.balance = b.balance)::TEXT
     FROM public.paper_accounts a, public.paper_accounts b
    WHERE a.id = (SELECT v FROM h WHERE k='accA')
      AND b.id = (SELECT v FROM h WHERE k='accB')), 'true');

SELECT pg_temp.want('E1 남은 수량 둘 다 0',
  (SELECT (COALESCE(SUM(pp.quantity),0))::TEXT FROM public.paper_positions pp
    WHERE pp.status='open' AND pp.paper_account_id IN
      ((SELECT v FROM h WHERE k='accA'), (SELECT v FROM h WHERE k='accB'))), '0');

SELECT pg_temp.want('E1 Σgross가 같다',
  (SELECT (
     (SELECT SUM(f.amount) FROM public.paper_challenge_cashflows f
       WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA') AND f.cashflow_type='REALIZED_PNL')
     = (SELECT SUM(f.amount) FROM public.paper_challenge_cashflows f
       WHERE f.challenge_id=(SELECT v FROM h WHERE k='chB') AND f.cashflow_type='REALIZED_PNL'))::TEXT),
  'true');

SELECT pg_temp.want('E1 Σ수수료가 같다',
  (SELECT (
     (SELECT SUM(f.amount) FROM public.paper_challenge_cashflows f
       WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA') AND f.cashflow_type='TRADING_FEE')
     = (SELECT SUM(f.amount) FROM public.paper_challenge_cashflows f
       WHERE f.challenge_id=(SELECT v FROM h WHERE k='chB') AND f.cashflow_type='TRADING_FEE'))::TEXT),
  'true');

SELECT pg_temp.want('E1 total_pnl(실현 통계)이 같다',
  (SELECT (a.total_pnl = b.total_pnl)::TEXT
     FROM public.paper_accounts a, public.paper_accounts b
    WHERE a.id=(SELECT v FROM h WHERE k='accA') AND b.id=(SELECT v FROM h WHERE k='accB')), 'true');

SELECT pg_temp.want('E1 total_fees가 같다',
  (SELECT (a.total_fees = b.total_fees)::TEXT
     FROM public.paper_accounts a, public.paper_accounts b
    WHERE a.id=(SELECT v FROM h WHERE k='accA') AND b.id=(SELECT v FROM h WHERE k='accB')), 'true');

-- ── D1 ──
SELECT pg_temp.want('D1 trade_count: 분할 3회도 1건이다',
  (SELECT a.trade_count::TEXT FROM public.paper_accounts a
    WHERE a.id=(SELECT v FROM h WHERE k='accA')), '1');
SELECT pg_temp.want('D1 trade_count: 전량 1회도 1건이다',
  (SELECT a.trade_count::TEXT FROM public.paper_accounts a
    WHERE a.id=(SELECT v FROM h WHERE k='accB')), '1');
SELECT pg_temp.want('D1 win_count가 같다',
  (SELECT (a.win_count = b.win_count)::TEXT
     FROM public.paper_accounts a, public.paper_accounts b
    WHERE a.id=(SELECT v FROM h WHERE k='accA') AND b.id=(SELECT v FROM h WHERE k='accB')), 'true');

-- ── C1: 과거 수수료는 안 줄었다 ──
SELECT pg_temp.want('C1 entry_fee는 끝까지 원래 값 그대로 (0.3)',
  (SELECT (pp.entry_fee = 0.3)::TEXT FROM public.paper_positions pp
    WHERE pp.id=(SELECT v FROM h WHERE k='pA1')), 'true');
SELECT pg_temp.want('C1 남은 귀속분은 0이 됐다',
  (SELECT (pp.remaining_entry_fee_basis = 0)::TEXT FROM public.paper_positions pp
    WHERE pp.id=(SELECT v FROM h WHERE k='pA1')), 'true');
SELECT pg_temp.want('C1 귀속분 합 = 원래 수수료',
  (SELECT (SUM(l.allocated_entry_fee_basis) = (SELECT pp.entry_fee FROM public.paper_positions pp
              WHERE pp.id=(SELECT v FROM h WHERE k='pA1')))::TEXT
     FROM public.paper_sell_event_lots l WHERE l.position_id=(SELECT v FROM h WHERE k='pA1')), 'true');

-- ── C2: 수수료가 각각 정확히 한 번 ──
SELECT pg_temp.want('C2 A: 진입 수수료 원장 1줄',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA')
      AND f.cashflow_type='TRADING_FEE' AND f.source_event_type='POSITION_OPEN'), '1');
SELECT pg_temp.want('C2 A: 매도 수수료 원장 3줄 (매도 3회)',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA')
      AND f.cashflow_type='TRADING_FEE' AND f.source_event_type='POSITION_SELL'), '3');
SELECT pg_temp.want('C2 A: 실현손익 원장 3줄',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA')
      AND f.cashflow_type='REALIZED_PNL'), '3');
SELECT pg_temp.want('C2 A: POSITION_CLOSE 원장은 0줄 (기존 이력을 안 건드린다)',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA')
      AND f.source_event_type='POSITION_CLOSE'), '0');
SELECT pg_temp.want('C2 A: 매도 원장의 source_event_id가 전부 다르다',
  (SELECT (count(DISTINCT f.source_event_id) = 3)::TEXT
     FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA')
      AND f.source_event_type='POSITION_SELL' AND f.cashflow_type='REALIZED_PNL'), 'true');

-- ══════════════════ E2 · 3 lot(다른 가격) ══════════════════
INSERT INTO h SELECT 'chC', challenge_id FROM t, public.paper_challenge_create(
  t.uC, 10000, 1000000, 1, t.t_start, t.t_end, t.t_now);
INSERT INTO h SELECT 'accC', c.paper_account_id FROM public.paper_challenges c
  WHERE c.id=(SELECT v FROM h WHERE k='chC');

SELECT pg_temp.buy((SELECT uC FROM t), (SELECT v FROM h WHERE k='accC'),
  'e2-1', 'ETHUSDT', 3000, 0.3, 0.0005, (SELECT t_now FROM t));
SELECT pg_temp.buy((SELECT uC FROM t), (SELECT v FROM h WHERE k='accC'),
  'e2-2', 'ETHUSDT', 3300, 0.2, 0.0005, (SELECT t_now FROM t));
SELECT pg_temp.buy((SELECT uC FROM t), (SELECT v FROM h WHERE k='accC'),
  'e2-3', 'ETHUSDT', 2800, 0.5, 0.0005, (SELECT t_now FROM t));

SELECT pg_temp.want('E2 보유 집계: lot 3개',
  (SELECT h_lots::TEXT FROM public.paper_holdings(
     (SELECT uC FROM t), (SELECT v FROM h WHERE k='accC')) WHERE h_symbol='ETHUSDT'), '3');

SELECT pg_temp.want('E2 체결평균가 = Σnotional/Σquantity',
  (SELECT (hh.h_avg_price = hh.h_notional / hh.h_quantity)::TEXT
     FROM public.paper_holdings((SELECT uC FROM t), (SELECT v FROM h WHERE k='accC')) hh
    WHERE hh.h_symbol='ETHUSDT'), 'true');

-- 33% → 33% → 남은 전부
SELECT pg_temp.want('E3 33%: SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uC FROM t), (SELECT v FROM h WHERE k='accC'), 'SPOT', 'ETHUSDT',
     33, NULL, 3100, 0.0005, 'cs-c-1', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.invariant('E3 매도1', (SELECT v FROM h WHERE k='chC'));
SELECT pg_temp.want('E3 33%(2): SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uC FROM t), (SELECT v FROM h WHERE k='accC'), 'SPOT', 'ETHUSDT',
     33, NULL, 3100, 0.0005, 'cs-c-2', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.want('E3 남은 전부: SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uC FROM t), (SELECT v FROM h WHERE k='accC'), 'SPOT', 'ETHUSDT',
     100, NULL, 3100, 0.0005, 'cs-c-3', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.invariant('E3 매도3', (SELECT v FROM h WHERE k='chC'));

SELECT pg_temp.want('E3 남은 수량 정확히 0 — dust 없음',
  (SELECT COALESCE(SUM(pp.quantity),0)::TEXT FROM public.paper_positions pp
    WHERE pp.paper_account_id=(SELECT v FROM h WHERE k='accC') AND pp.status='open'), '0');
SELECT pg_temp.want('E3 남은 증거금 정확히 0',
  (SELECT COALESCE(SUM(pp.margin),0)::TEXT FROM public.paper_positions pp
    WHERE pp.paper_account_id=(SELECT v FROM h WHERE k='accC') AND pp.status='open'), '0');
SELECT pg_temp.want('E3 보유 목록이 비었다',
  (SELECT count(*)::TEXT FROM public.paper_holdings(
     (SELECT uC FROM t), (SELECT v FROM h WHERE k='accC'))), '0');
SELECT pg_temp.want('E3 lot 3개가 모두 닫혔다 → trade_count 3',
  (SELECT a.trade_count::TEXT FROM public.paper_accounts a
    WHERE a.id=(SELECT v FROM h WHERE k='accC')), '3');
SELECT pg_temp.want('E3 각 lot의 귀속 수수료 합 = 그 lot의 entry_fee',
  (SELECT (count(*) = 0)::TEXT FROM public.paper_positions pp
    WHERE pp.paper_account_id=(SELECT v FROM h WHERE k='accC')
      AND pp.entry_fee <> (SELECT COALESCE(SUM(l.allocated_entry_fee_basis),0)
                             FROM public.paper_sell_event_lots l WHERE l.position_id=pp.id)),
  'true');

-- ══════════════════ E4 · 수량 직접 지정 ══════════════════
INSERT INTO h SELECT 'pA2', pg_temp.buy(
  (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'),
  'e4-a', 'SOLUSDT', 100, 5, 0.0005, (SELECT t_now FROM t));

SELECT pg_temp.want('E4 수량 지정 매도: SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'SOLUSDT',
     NULL, 2, 110, 0.0005, 'cs-a-4', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.want('E4 정확히 2개가 팔렸다',
  (SELECT (out_sold_qty = 2)::TEXT FROM public.paper_sell_events e,
     LATERAL (SELECT e.sold_quantity AS out_sold_qty) x
    WHERE e.client_sell_id='cs-a-4'), 'true');
SELECT pg_temp.invariant('E4', (SELECT v FROM h WHERE k='chA'));

-- ══════════════════ 멱등 · 충돌 ══════════════════
SELECT pg_temp.want('멱등: 같은 식별자 재시도는 REPLAYED',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'SOLUSDT',
     NULL, 2, 110, 0.0005, 'cs-a-4', (SELECT t_now FROM t))), 'REPLAYED');
SELECT pg_temp.want('멱등: 매도 사건은 여전히 1줄',
  (SELECT count(*)::TEXT FROM public.paper_sell_events e WHERE e.client_sell_id='cs-a-4'), '1');
SELECT pg_temp.want('멱등: 그 매도의 원장도 여전히 2줄',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.source_event_id = (SELECT e.id::TEXT FROM public.paper_sell_events e
                                WHERE e.client_sell_id='cs-a-4')), '2');
SELECT pg_temp.invariant('멱등 재시도 뒤', (SELECT v FROM h WHERE k='chA'));

SELECT pg_temp.want('충돌: 같은 식별자 + 다른 내용은 CONFLICT',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'SOLUSDT',
     NULL, 1, 110, 0.0005, 'cs-a-4', (SELECT t_now FROM t))), 'CONFLICT');
SELECT pg_temp.want('충돌: 아무것도 안 움직였다 (원장 2줄 그대로)',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.source_event_id = (SELECT e.id::TEXT FROM public.paper_sell_events e
                                WHERE e.client_sell_id='cs-a-4')), '2');
SELECT pg_temp.invariant('충돌 뒤', (SELECT v FROM h WHERE k='chA'));

-- ══════════════════ oversell · 경합(순차) ══════════════════
-- 남은 보유는 3개다. 70%씩 두 번 = 순차로는 두 번째가 가진 것보다 많이
-- 달라고 하지는 않지만, **수량으로 5개**를 달라면 fail closed여야 한다.
SELECT pg_temp.want('oversell: 가진 것보다 많이 팔 수 없다',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'SOLUSDT',
     NULL, 5, 110, 0.0005, 'cs-a-over', (SELECT t_now FROM t))), 'INSUFFICIENT_HOLDING');
SELECT pg_temp.want('oversell: 매도 사건이 안 생겼다',
  (SELECT count(*)::TEXT FROM public.paper_sell_events e
    WHERE e.client_sell_id='cs-a-over'), '0');
-- 체결수량은 notional/체결가라 딱 떨어지지 않는다. **지어낸 기대값 대신
-- 장부가 아는 값끼리 맞춘다**: 남은 수량 = 원 체결 수량 - 이미 판 수량.
SELECT pg_temp.want('oversell: 보유 수량이 안 줄었다',
  (SELECT (hh.h_quantity = pp.open_quantity - 2)::TEXT
     FROM public.paper_holdings((SELECT uA FROM t), (SELECT v FROM h WHERE k='accA')) hh,
          public.paper_positions pp
    WHERE hh.h_symbol='SOLUSDT' AND pp.id=(SELECT v FROM h WHERE k='pA2')), 'true');
SELECT pg_temp.invariant('oversell 뒤', (SELECT v FROM h WHERE k='chA'));

-- 70% + 70% (순차). 두 번째는 남은 것의 70%라 성공하고, 합은 140%가 아니다.
SELECT pg_temp.want('70%(1): SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'SOLUSDT',
     70, NULL, 110, 0.0005, 'cs-a-70a', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.want('70%(2): SOLD — 남은 것의 70%다',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'SOLUSDT',
     70, NULL, 110, 0.0005, 'cs-a-70b', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.want('70%+70%가 판 합은 그때 보유를 넘지 않았다',
  (SELECT (SUM(e.sold_quantity) <= (SELECT pp.open_quantity - 2 FROM public.paper_positions pp
                                     WHERE pp.id=(SELECT v FROM h WHERE k='pA2')))::TEXT
     FROM public.paper_sell_events e
    WHERE e.client_sell_id IN ('cs-a-70a','cs-a-70b')), 'true');
SELECT pg_temp.invariant('70+70 뒤', (SELECT v FROM h WHERE k='chA'));

-- ══════════════════ E7 · 부분매도 뒤 legacy 전량청산 ══════════════════
--
-- 남은 SOL 잔량을 `paper_settle_close`(기존 경로)로 닫는다.
-- **A1**: 청산 계산은 남은 귀속분을 써야 한다.
-- **A2**: 승패는 이 lot의 일생으로 판정해야 한다.
INSERT INTO h SELECT 'solLot', pp.id FROM public.paper_positions pp
  WHERE pp.paper_account_id=(SELECT v FROM h WHERE k='accA')
    AND pp.symbol='SOLUSDT' AND pp.status='open' LIMIT 1;

SELECT pg_temp.want('E7 legacy 청산 전: 남은 귀속분이 원래 수수료보다 작다',
  (SELECT (pp.remaining_entry_fee_basis < pp.entry_fee)::TEXT
     FROM public.paper_positions pp WHERE pp.id=(SELECT v FROM h WHERE k='solLot')), 'true');

-- 금액은 기존 계약대로 밖에서 받는다(legacy 경로는 그대로다).
-- 남은 귀속분을 쓰는 것이 A1이다.
SELECT pg_temp.want('E7 legacy 전량청산: settled',
  (SELECT settled::TEXT FROM public.paper_settle_close(
     (SELECT v FROM h WHERE k='solLot'), 110, 'MANUAL',
     (SELECT 110 * pp.quantity * 0.0005 FROM public.paper_positions pp
        WHERE pp.id=(SELECT v FROM h WHERE k='solLot')),
     (SELECT (110 - pp.fill_price) * pp.quantity FROM public.paper_positions pp
        WHERE pp.id=(SELECT v FROM h WHERE k='solLot')),
     (SELECT (110 - pp.fill_price) * pp.quantity
             - pp.remaining_entry_fee_basis
             - 110 * pp.quantity * 0.0005
        FROM public.paper_positions pp WHERE pp.id=(SELECT v FROM h WHERE k='solLot')),
     0, (SELECT t_now FROM t))), 'true');
SELECT pg_temp.invariant('E7 legacy 청산 뒤', (SELECT v FROM h WHERE k='chA'));

SELECT pg_temp.want('E7 legacy 청산은 POSITION_CLOSE로 적혔다 (구분된다)',
  (SELECT count(*)::TEXT FROM public.paper_challenge_cashflows f
    WHERE f.challenge_id=(SELECT v FROM h WHERE k='chA')
      AND f.source_event_type='POSITION_CLOSE'
      AND f.source_event_id=(SELECT v FROM h WHERE k='solLot')::TEXT), '2');
SELECT pg_temp.want('E7 SOL 보유가 비었다',
  (SELECT count(*)::TEXT FROM public.paper_holdings(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA')) WHERE h_symbol='SOLUSDT'), '0');

-- ══════════════════ 불변 칸 · 시장 · 계좌 격리 ══════════════════
SELECT pg_temp.must_fail('freeze: entry_fee 변경은 거부', '23514', $q$
  UPDATE public.paper_positions SET entry_fee = entry_fee + 1
   WHERE id = (SELECT v FROM h WHERE k='pA1')
$q$);
SELECT pg_temp.must_fail('freeze: open_quantity 변경은 거부', '23514', $q$
  UPDATE public.paper_positions SET open_quantity = open_quantity + 1
   WHERE id = (SELECT v FROM h WHERE k='pA1')
$q$);
SELECT pg_temp.must_fail('freeze: fill_price 변경은 거부', '23514', $q$
  UPDATE public.paper_positions SET fill_price = fill_price + 1
   WHERE id = (SELECT v FROM h WHERE k='pA1')
$q$);

SELECT pg_temp.want('USDM은 이 경로로 팔 수 없다',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'USDM', 'BTCUSDT',
     100, NULL, 66000, 0.0005, 'cs-a-usdm', (SELECT t_now FROM t))), 'NOT_SPOT');

SELECT pg_temp.want('없는 보유는 NO_HOLDING',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'DOGEUSDT',
     100, NULL, 1, 0.0005, 'cs-a-none', (SELECT t_now FROM t))), 'NO_HOLDING');

-- 남의 계좌를 지목해도 안 잡힌다.
SELECT pg_temp.want('계좌 격리: 남의 계좌 id는 NO_ACCOUNT',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accB'), 'SPOT', 'BTCUSDT',
     100, NULL, 66000, 0.0005, 'cs-a-steal', (SELECT t_now FROM t))), 'NO_ACCOUNT');

-- 다른 계좌의 같은 종목은 건드리지 않는다.
INSERT INTO h SELECT 'pB2', pg_temp.buy(
  (SELECT uB FROM t), (SELECT v FROM h WHERE k='accB'),
  'iso-b', 'ADAUSDT', 2, 100, 0.0005, (SELECT t_now FROM t));
INSERT INTO h SELECT 'pA3', pg_temp.buy(
  (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'),
  'iso-a', 'ADAUSDT', 2, 100, 0.0005, (SELECT t_now FROM t));
SELECT pg_temp.want('격리: A가 팔아도 B의 ADA는 그대로',
  (SELECT out_status FROM public.paper_sell_holding(
     (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'ADAUSDT',
     100, NULL, 3, 0.0005, 'cs-a-ada', (SELECT t_now FROM t))), 'SOLD');
SELECT pg_temp.want('격리: B의 ADA 보유 그대로',
  (SELECT (h_lots = 1)::TEXT FROM public.paper_holdings(
     (SELECT uB FROM t), (SELECT v FROM h WHERE k='accB')) WHERE h_symbol='ADAUSDT'), 'true');
SELECT pg_temp.invariant('격리 A', (SELECT v FROM h WHERE k='chA'));
SELECT pg_temp.invariant('격리 B', (SELECT v FROM h WHERE k='chB'));

-- ══════════════════ 거부돼야 하는 입력 ══════════════════
SELECT pg_temp.must_fail('사건 시각 없음은 거부', '22004', $q$
  SELECT public.paper_sell_holding(
    (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'ADAUSDT',
    100, NULL, 3, 0.0005, 'cs-x1', NULL)
$q$);
SELECT pg_temp.must_fail('비율과 수량을 둘 다 주면 거부', 'P0001', $q$
  SELECT public.paper_sell_holding(
    (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'ADAUSDT',
    50, 1, 3, 0.0005, 'cs-x2', (SELECT t_now FROM t))
$q$);
SELECT pg_temp.must_fail('둘 다 없으면 거부', 'P0001', $q$
  SELECT public.paper_sell_holding(
    (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'ADAUSDT',
    NULL, NULL, 3, 0.0005, 'cs-x3', (SELECT t_now FROM t))
$q$);
SELECT pg_temp.must_fail('매도 식별자 없음은 거부', 'P0001', $q$
  SELECT public.paper_sell_holding(
    (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'ADAUSDT',
    100, NULL, 3, 0.0005, '', (SELECT t_now FROM t))
$q$);
SELECT pg_temp.must_fail('청산가 0은 거부', 'P0001', $q$
  SELECT public.paper_sell_holding(
    (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'ADAUSDT',
    100, NULL, 0, 0.0005, 'cs-x4', (SELECT t_now FROM t))
$q$);
SELECT pg_temp.must_fail('비율 101은 거부', 'P0001', $q$
  SELECT public.paper_sell_holding(
    (SELECT uA FROM t), (SELECT v FROM h WHERE k='accA'), 'SPOT', 'ADAUSDT',
    101, NULL, 3, 0.0005, 'cs-x5', (SELECT t_now FROM t))
$q$);
SELECT pg_temp.must_fail('paper_floor_at 음수는 거부', 'P0001',
  $q$ SELECT public.paper_floor_at(-1, 18) $q$);

-- ══════════════════ 마지막: 모든 챌린지 불변식 ══════════════════
SELECT pg_temp.invariant('최종 A', (SELECT v FROM h WHERE k='chA'));
SELECT pg_temp.invariant('최종 B', (SELECT v FROM h WHERE k='chB'));
SELECT pg_temp.invariant('최종 C', (SELECT v FROM h WHERE k='chC'));


-- ══════════════════ 하루 손실: 날짜가 이동하지 않는다 ══════════════════
--
-- 어제 부분매도하고 오늘 잔량을 legacy로 닫는다. 어제 손익이 오늘로
-- 옮겨 오면 한도가 틀린 값을 본다.
--
-- 챌린지가 아닌 **기본 계좌**로 한다 — 챌린지 계좌에는 사건 시각 신선도
-- 검사가 걸려 있어서 어제 시각을 넣을 수 없다(그게 맞다).
INSERT INTO public.paper_accounts (id, user_id, is_default, balance, initial_balance)
VALUES ('cbaccd00-0000-0000-0000-0000000000dd'::uuid,
        'cb000000-0000-0000-0000-00000000000d'::uuid, TRUE, 10000, 10000);
INSERT INTO h VALUES ('accD', 'cbaccd00-0000-0000-0000-0000000000dd'::uuid);

INSERT INTO h SELECT 'pD1', pg_temp.buy(
  'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
  'dl-1', 'BTCUSDT', 60000, 0.01, 0.0005, (SELECT t_now FROM t) - INTERVAL '2 days');

-- 어제: 40% 부분매도 (손실이 나도록 낮은 가격)
SELECT pg_temp.want('DL 어제 부분매도: SOLD',
  (SELECT out_status FROM public.paper_sell_holding(
     'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
     'SPOT', 'BTCUSDT', 40, NULL, 50000, 0.0005, 'dl-sell-y',
     (SELECT t_now FROM t) - INTERVAL '1 day')), 'SOLD');

-- 오늘: 잔량을 legacy 경로로 닫는다
SELECT pg_temp.want('DL 오늘 legacy 청산: settled',
  (SELECT settled::TEXT FROM public.paper_settle_close(
     (SELECT v FROM h WHERE k='pD1'), 50000, 'MANUAL',
     (SELECT 50000 * pp.quantity * 0.0005 FROM public.paper_positions pp
        WHERE pp.id=(SELECT v FROM h WHERE k='pD1')),
     (SELECT (50000 - pp.fill_price) * pp.quantity FROM public.paper_positions pp
        WHERE pp.id=(SELECT v FROM h WHERE k='pD1')),
     (SELECT (50000 - pp.fill_price) * pp.quantity - pp.remaining_entry_fee_basis
             - 50000 * pp.quantity * 0.0005
        FROM public.paper_positions pp WHERE pp.id=(SELECT v FROM h WHERE k='pD1')),
     0, (SELECT t_now FROM t))), 'true');

SELECT pg_temp.want('DL 어제 창: 어제 부분매도 손익이 어제에 있다',
  (SELECT (r_realized = (SELECT SUM(l.lot_realized_pnl)
                           FROM public.paper_sell_events e
                           JOIN public.paper_sell_event_lots l ON l.sell_id=e.id
                          WHERE e.client_sell_id='dl-sell-y'))::TEXT
     FROM public.paper_realized_between(
       'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
       (SELECT t_now FROM t) - INTERVAL '2 days', (SELECT t_now FROM t) - INTERVAL '12 hours')),
  'true');

SELECT pg_temp.want('DL 어제 창에 오늘 청산분이 섞이지 않았다 (사건 1건)',
  (SELECT r_events::TEXT FROM public.paper_realized_between(
     'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
     (SELECT t_now FROM t) - INTERVAL '2 days', (SELECT t_now FROM t) - INTERVAL '12 hours')),
  '1');

SELECT pg_temp.want('DL 오늘 창: legacy 몫만 잡힌다 — 어제 손익이 안 옮겨 왔다',
  (SELECT (r_realized = (SELECT pp.realized_pnl
                           - COALESCE((SELECT SUM(l.lot_realized_pnl)
                                FROM public.paper_sell_event_lots l
                               WHERE l.position_id = pp.id), 0)
                           FROM public.paper_positions pp
                          WHERE pp.id=(SELECT v FROM h WHERE k='pD1')))::TEXT
     FROM public.paper_realized_between(
       'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
       (SELECT t_now FROM t) - INTERVAL '12 hours', (SELECT t_now FROM t) + INTERVAL '1 day')),
  'true');

SELECT pg_temp.want('DL 전 기간 합 = 두 창의 합 (빠뜨리거나 두 번 세지 않는다)',
  (SELECT (
     (SELECT r_realized FROM public.paper_realized_between(
        'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
        (SELECT t_now FROM t) - INTERVAL '3 days', (SELECT t_now FROM t) + INTERVAL '1 day'))
     = (SELECT r_realized FROM public.paper_realized_between(
          'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
          (SELECT t_now FROM t) - INTERVAL '3 days', (SELECT t_now FROM t) - INTERVAL '12 hours'))
     + (SELECT r_realized FROM public.paper_realized_between(
          'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
          (SELECT t_now FROM t) - INTERVAL '12 hours', (SELECT t_now FROM t) + INTERVAL '1 day'))
   )::TEXT), 'true');

SELECT pg_temp.want('A2 legacy 청산 뒤 realized_pnl은 이 lot의 일생이다',
  (SELECT (pp.realized_pnl = (SELECT SUM(l.lot_realized_pnl)
                                FROM public.paper_sell_event_lots l
                               WHERE l.position_id = pp.id)
           + (SELECT r_realized FROM public.paper_realized_between(
                'cb000000-0000-0000-0000-00000000000d'::uuid, (SELECT v FROM h WHERE k='accD'),
                (SELECT t_now FROM t) - INTERVAL '12 hours',
                (SELECT t_now FROM t) + INTERVAL '1 day')))::TEXT
     FROM public.paper_positions pp WHERE pp.id=(SELECT v FROM h WHERE k='pD1')), 'true');


-- ══════════════════ 불변 칸: 처음 채우기 ≠ 고치기 ══════════════════
--
-- 이 계약이 빠져서 CI 재생이 빨갛게 됐었다. 이 파일을 두 번째 세울 때,
-- 그 사이에 옛 버전 `paper_open_position`이 만든 줄은 `open_*`가 비어 있다.
-- backfill이 그것을 채우는데 트리거가 `NULL → 값`을 증거 변경으로 읽으면
-- **마이그레이션 자신이 자기 트리거에 막힌다.**
--
-- 비어 있던 칸을 처음 채우는 것은 고치는 것이 아니다. 한 번 적힌 뒤로만 잠근다.
INSERT INTO public.paper_positions
  (id, user_id, paper_account_id, symbol, market, side, status,
   entry_price, fill_price, quantity, notional, leverage, margin, entry_fee)
VALUES
  ('cbf1ee00-0000-0000-0000-0000000000f1'::uuid,
   'cb000000-0000-0000-0000-00000000000d'::uuid,
   (SELECT v FROM h WHERE k='accD'), 'BTCUSDT', 'SPOT', 'LONG', 'open',
   100, 100, 1, 100, 1, 100, 0.05);

SELECT pg_temp.want('freeze: 옛 경로로 만든 줄은 증거 칸이 비어 있다',
  (SELECT (pp.open_quantity IS NULL)::TEXT FROM public.paper_positions pp
    WHERE pp.id='cbf1ee00-0000-0000-0000-0000000000f1'::uuid), 'true');

-- 처음 채우기는 통과해야 한다 (= backfill이 하는 일).
UPDATE public.paper_positions
   SET open_quantity = quantity, open_notional = notional,
       open_margin = margin, remaining_entry_fee_basis = entry_fee
 WHERE id='cbf1ee00-0000-0000-0000-0000000000f1'::uuid;

SELECT pg_temp.want('★ freeze: 비어 있던 증거를 처음 채우는 것은 막지 않는다',
  (SELECT (pp.open_quantity = pp.quantity AND pp.open_margin = pp.margin)::TEXT
     FROM public.paper_positions pp
    WHERE pp.id='cbf1ee00-0000-0000-0000-0000000000f1'::uuid), 'true');

-- 한 번 적힌 뒤에는 막아야 한다.
SELECT pg_temp.must_fail('★ freeze: 한 번 적힌 증거를 고치는 것은 거부', '23514', $q$
  UPDATE public.paper_positions SET open_quantity = open_quantity + 1
   WHERE id='cbf1ee00-0000-0000-0000-0000000000f1'::uuid
$q$);
SELECT pg_temp.must_fail('★ freeze: 채워진 증거를 NULL로 지우는 것도 거부', '23514', $q$
  UPDATE public.paper_positions SET open_margin = NULL
   WHERE id='cbf1ee00-0000-0000-0000-0000000000f1'::uuid
$q$);

\echo '현물 분할매도 회계 실행 증명 전부 통과'

ROLLBACK;
