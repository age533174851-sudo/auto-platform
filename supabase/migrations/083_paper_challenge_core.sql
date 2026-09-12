-- 083_paper_challenge_core.sql
--
-- **모의투자 챌린지의 자리만 만든다.**
--
-- 이 파일이 하지 않는 것
-- ──────────────────────
-- 돈을 움직이지 않는다. 계좌를 만들지 않는다. INITIAL_DEPOSIT을 적용하지
-- 않는다. 생성 트랜잭션도, finalizer도, 만료 스위퍼도 여기 없다.
-- 그것들은 PR2·PR3이다. 여기는 **표와 제약**뿐이다.
--
-- 돈의 정본은 여기가 아니다
-- ─────────────────────────
-- **Money Authority는 `paper_accounts.balance` 하나다.** 챌린지 표는 규칙과
-- 상태와 통계만 갖는다. 잔고를 복제하면 두 숫자가 생기고, 두 숫자는 언젠가
-- 갈린다 — 이 저장소가 반복해서 겪은 고장이다.
--
-- `paper_challenge_cashflows`는 잔고를 **설명**한다. 잔고 자체가 아니다.
-- 불변식은 `SUM(cashflows.amount) = paper_accounts.balance`이고, 그것을
-- 유지하는 책임은 PR2의 회계 경로에 있다.
--
-- 소유권은 DB가 강제한다
-- ──────────────────────
-- `(paper_account_id, user_id) → paper_accounts (id, user_id)` 복합 외래키다.
-- 서비스 계층 검사 하나에 기대지 않는다 — `081`이 포지션에 대해 한 것과 같다.
-- 그래서 챌린지 표도 `(id, user_id)`로 유니크를 하나 둔다. 하위 표가 가리킬
-- 정본이 필요하기 때문이다.
--
-- 상태와 의도를 분리한다
-- ──────────────────────
-- `status`는 지금 어디에 있는가이고, `close_intent`는 **왜 끝나는가**다.
-- 둘을 한 칸에 섞으면 "목표를 달성했는데 강제청산 손실로 목표 아래로
-- 내려간" 경우를 표현할 수 없다.
--
--   READY    starts_at 이전. 아직 시작 안 함
--   RUNNING  활성 기간. **첫 주문 여부와 무관하다** — 주문이 한 번도 없어도
--            기간은 흐르고 만료될 수 있어야 한다
--   CLOSING  끝내기로 정해졌고, 포지션을 정리하는 중
--   CLOSED   끝났다
--
-- **TARGET_REACHED는 되돌릴 수 없다**
-- ────────────────────────────────────
-- 유효기간 안에서 목표에 처음 닿는 순간 `close_intent`가 고정된다. 그 뒤
-- CLOSING 중 강제청산 손실로 최종 잔고가 목표 아래로 내려가도 **달성을
-- 취소하지 않는다.** 최종 잔고와 통계는 실제 결과를 적는다.
--
-- 이 계약을 코드 규율이 아니라 **DB가 강제**한다:
--
--   CHECK (terminal_status IS NULL OR terminal_status = close_intent)
--
-- finalizer가 마지막 잔고를 보고 사유를 다시 판단하면 이 제약이 거부한다.
--
-- 시각의 정본
-- ───────────
-- `event_effective_at`에는 **DEFAULT를 두지 않는다.** 기본값을 두면 "이 일이
-- 실제로 언제 일어났는가"를 아무도 적지 않게 되고, 행이 기록된 시각이 슬그머니
-- 판정 기준이 된다. 만료와 목표 도달이 그 값으로 갈리므로 그건 조용한 거짓이다.
--
-- 부르는 쪽이 반드시 넣는다:
--   · 체결·시세 계열   판정에 실제로 쓴 **서버가 관측한 market timestamp**
--   · 순수 서버 동작   (챌린지 생성·취소처럼 market 시각 개념이 없는 것)
--                      서버가 **명시적으로 만든** event time
--   · 클라이언트 시각  절대 금지
--
-- 기록 시각은 따로 `recorded_at`에 남긴다. 그 칸은 판정에 쓰지 않는다.

-- ══════════════════ ① 챌린지 ══════════════════
CREATE TABLE IF NOT EXISTS public.paper_challenges (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL,

  -- 이 챌린지 전용 모의 계좌. 1:1이다(아래 UNIQUE).
  paper_account_id      UUID NOT NULL,

  status                TEXT NOT NULL DEFAULT 'READY',

  -- **왜 끝나는가.** 한 번 정해지면 바뀌지 않는다.
  close_intent          TEXT,
  -- 의도가 고정된 시각(기록 시각). 판정 기준이 아니다.
  close_intent_at       TIMESTAMPTZ,
  -- 그 판정을 유발한 사건의 event_effective_at. **이쪽이 판정 기준이다.**
  close_intent_event_at TIMESTAMPTZ,

  -- finalizer만 쓴다. close_intent와 같아야 한다(아래 CHECK).
  terminal_status       TEXT,

  initial_equity        NUMERIC NOT NULL,
  target_equity         NUMERIC NOT NULL,
  failure_equity        NUMERIC,

  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ NOT NULL,

  -- **통계 전용.** 목표·실패 판정에 쓰지 않는다 — 그건 realized balance로만 한다.
  peak_nav              NUMERIC NOT NULL DEFAULT 0,
  max_drawdown_pct      NUMERIC NOT NULL DEFAULT 0,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at             TIMESTAMPTZ
);

-- 하위 표가 소유권을 가리킬 정본. `(id, user_id)`가 유니크여야 복합 외래키를
-- 걸 수 있다 — `081`이 `paper_accounts`에 한 것과 같은 이유다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_id_owner_key') THEN
    ALTER TABLE public.paper_challenges
      ADD CONSTRAINT paper_challenges_id_owner_key UNIQUE (id, user_id);
  END IF;
END $$;

-- 챌린지 ↔ 전용 계좌는 1:1. 한 계좌가 두 챌린지에 붙을 수 없다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_account_key') THEN
    ALTER TABLE public.paper_challenges
      ADD CONSTRAINT paper_challenges_account_key UNIQUE (paper_account_id);
  END IF;
END $$;

-- 하위 표가 **"이 챌린지의 계좌"**를 가리킬 정본.
--
-- 돈 사건은 챌린지의 전용 계좌에만 붙어야 한다. 소유자만 맞춰 두면 같은
-- 사용자의 **다른** 계좌를 챌린지 원장에 적을 수 있고, 그러면
-- `SUM(cashflows.amount) = paper_accounts.balance` 불변식이 조용히 깨진다 —
-- 원장은 이 챌린지 것인데 잔고는 다른 계좌에 있게 된다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_id_account_key') THEN
    ALTER TABLE public.paper_challenges
      ADD CONSTRAINT paper_challenges_id_account_key UNIQUE (id, paper_account_id);
  END IF;
END $$;

-- **소유권을 DB가 강제한다.** 남의 계좌를 챌린지에 붙일 수 없다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_account_owner_fk') THEN
    ALTER TABLE public.paper_challenges
      ADD CONSTRAINT paper_challenges_account_owner_fk
      FOREIGN KEY (paper_account_id, user_id)
      REFERENCES public.paper_accounts (id, user_id);
  END IF;
END $$;

-- ── 상태·의도 계약 ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_status_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_status_chk
      CHECK (status IN ('READY', 'RUNNING', 'CLOSING', 'CLOSED'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_intent_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_intent_chk
      CHECK (close_intent IS NULL
             OR close_intent IN ('TARGET_REACHED', 'EXPIRED', 'FAILED', 'CANCELLED'));
  END IF;

  -- CLOSING에 들어갔다는 것은 **왜 끝나는지 이미 정했다**는 뜻이다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_closing_needs_intent_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_closing_needs_intent_chk
      CHECK (status <> 'CLOSING' OR close_intent IS NOT NULL);
  END IF;

  -- 끝났다는 것과 최종 상태가 적혔다는 것은 **같은 사실**이다. 한쪽만 있으면
  -- "끝났는데 왜 끝났는지 모른다"거나 "안 끝났는데 결론이 적혀 있다"가 된다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_terminal_pair_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_terminal_pair_chk
      CHECK ((status = 'CLOSED') = (terminal_status IS NOT NULL));
  END IF;

  -- ★ **TARGET_REACHED 불가역의 DB 강제.**
  --
  -- finalizer는 저장된 의도를 그대로 복사할 뿐이다. 마지막 잔고를 보고 사유를
  -- 다시 판단하면 여기서 거부된다. 코드 규율이 아니라 제약으로 막는다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_terminal_matches_intent_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_terminal_matches_intent_chk
      CHECK (terminal_status IS NULL OR terminal_status = close_intent);
  END IF;

  -- 의도가 정해졌으면 언제 정해졌는지도 남는다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_intent_stamped_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_intent_stamped_chk
      CHECK ((close_intent IS NULL) = (close_intent_event_at IS NULL));
  END IF;

  -- ── 금액·기간 ──
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_equity_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_equity_chk
      CHECK (initial_equity > 0
             AND target_equity > initial_equity
             AND (failure_equity IS NULL OR failure_equity < initial_equity));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_period_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_period_chk
      CHECK (ends_at > starts_at);
  END IF;

  -- 통계는 음수가 될 수 없다. 낙폭은 퍼센트다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenges_stats_chk') THEN
    ALTER TABLE public.paper_challenges ADD CONSTRAINT paper_challenges_stats_chk
      CHECK (peak_nav >= 0 AND max_drawdown_pct >= 0 AND max_drawdown_pct <= 100);
  END IF;
END $$;

-- ══════════ 사유는 정해진 뒤 바뀌지 않는다 (DB 강제) ══════════
--
-- 왜 CHECK로는 부족한가
-- ─────────────────────
-- 행 단위 CHECK는 **이전 값을 볼 수 없다.** 위의
-- `terminal_status = close_intent`는 "마감할 때 결론이 사유와 같은가"만
-- 본다. 그래서 아직 `terminal_status IS NULL`인 CLOSING 중에는 이것이
-- 그냥 통과한다:
--
--   status='CLOSING' · close_intent='TARGET_REACHED' · terminal_status IS NULL
--   UPDATE ... SET close_intent='FAILED'        ← CHECK 넷 모두 통과한다
--
-- 그 뒤 같은 값으로 마감하면 `terminal_status='FAILED'`가 되고, 제약은
-- 아무 말도 하지 않는다. **달성이 조용히 실패로 바뀐다.** 최종 복사만
-- 강제했지 사유 자체의 불변은 강제하지 않았던 것이다.
--
-- PR2의 `WHERE close_intent IS NULL` CAS는 정상 경로를 지키는 장치지,
-- DB 보호를 대신하지 않는다. 운영 수리·수동 UPDATE·앞으로 생길 다른
-- 경로는 그 CAS를 지나가지 않는다.
--
-- 그래서 이전 값을 볼 수 있는 유일한 자리인 **BEFORE UPDATE 트리거**로
-- 막는다. 이것이 이 파일에 있는 유일한 함수·트리거이고, 회계는 하지
-- 않는다 — 값을 쓰지도, 다른 표를 읽지도 않는다.
--
-- 무엇을 허용하고 무엇을 막는가
-- ─────────────────────────────
--   NULL → 유효한 사유          허용 (처음 정하는 것)
--   같은 사유를 다시 기록        허용 (재시도는 변경이 아니다)
--   사유 → 다른 사유            **거부** (TARGET_REACHED → FAILED 포함)
--   사유 → NULL                 **거부** (지우고 다시 쓰는 우회로를 막는다)
--
-- 판정 시각(`close_intent_event_at`)도 같이 얼린다. 사유는 그대로 두고
-- 시각만 바꾸면 "언제 달성했는가"가 움직이고, 그것이 곧 만료 판정을
-- 뒤집는다.
--
-- SQLSTATE는 23514(check_violation)를 쓴다. 부르는 쪽에서 보면 위의
-- CHECK들과 같은 종류의 거부이고, 제약 시험이 **기대 사유까지** 맞춰
-- 확인할 수 있다.
CREATE OR REPLACE FUNCTION public.paper_challenges_freeze_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.close_intent IS NOT NULL
     AND NEW.close_intent IS DISTINCT FROM OLD.close_intent THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        '종료 사유는 이미 %s로 정해졌습니다 — %s로 바꿀 수 없습니다',
        OLD.close_intent, COALESCE(NEW.close_intent, 'NULL')),
      HINT = '사유는 처음 정해진 순간 고정됩니다. 최종 상태는 그 값을 그대로 옮기세요';
  END IF;

  IF OLD.close_intent_event_at IS NOT NULL
     AND NEW.close_intent_event_at IS DISTINCT FROM OLD.close_intent_event_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '사유가 정해진 시각은 바꿀 수 없습니다',
      HINT = '이 값이 움직이면 만료·목표 판정의 기준이 함께 움직입니다';
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.paper_challenges_freeze_intent() IS
  '종료 사유와 그 판정 시각을 처음 정해진 값으로 고정한다. 행 단위 CHECK는 '
  '이전 값을 볼 수 없어 CLOSING 중 close_intent 덮어쓰기를 막지 못한다. '
  '회계를 하지 않는다 — 값을 쓰지도 다른 표를 읽지도 않는다.';

DROP TRIGGER IF EXISTS paper_challenges_freeze_intent_trg ON public.paper_challenges;
CREATE TRIGGER paper_challenges_freeze_intent_trg
  BEFORE UPDATE ON public.paper_challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.paper_challenges_freeze_intent();

-- **사용자당 활성 챌린지는 최대 하나.**
--
-- READY·RUNNING·CLOSING을 합쳐 하나다. 끝난 것(CLOSED)은 몇 개든 남는다 —
-- 지난 기록을 지우지 않는다.
--
-- 부분 유니크 인덱스다. 이것이 보장하는 것은 **"둘이 될 수 없다"**이고,
-- "반드시 하나 있다"가 아니다 — `081`에서 배운 구분을 여기서도 지킨다.
CREATE UNIQUE INDEX IF NOT EXISTS paper_challenges_one_active_per_user
  ON public.paper_challenges (user_id)
  WHERE status IN ('READY', 'RUNNING', 'CLOSING');

-- 만료를 훑을 때 쓴다.
CREATE INDEX IF NOT EXISTS paper_challenges_due_idx
  ON public.paper_challenges (ends_at)
  WHERE status IN ('READY', 'RUNNING');

-- finalizer가 집을 것.
CREATE INDEX IF NOT EXISTS paper_challenges_closing_idx
  ON public.paper_challenges (id)
  WHERE status = 'CLOSING';

COMMENT ON TABLE public.paper_challenges IS
  '모의투자 챌린지의 규칙·상태·통계. **잔고를 갖지 않는다** — 돈의 정본은 '
  'paper_accounts.balance 하나다.';
COMMENT ON COLUMN public.paper_challenges.status IS
  'READY=starts_at 이전 · RUNNING=활성 기간(첫 주문 여부와 무관) · '
  'CLOSING=정리 중 · CLOSED=끝남';
COMMENT ON COLUMN public.paper_challenges.close_intent IS
  '왜 끝나는가. 한 번 정해지면 바뀌지 않는다. 유효기간 안에서 목표에 처음 '
  '닿으면 TARGET_REACHED로 고정되고, 이후 강제청산 손실로 잔고가 목표 아래로 '
  '내려가도 취소하지 않는다.';
COMMENT ON COLUMN public.paper_challenges.terminal_status IS
  'finalizer가 적는 최종 상태. close_intent와 반드시 같다(CHECK) — 마지막 '
  '잔고를 보고 사유를 다시 판단하지 않는다.';
COMMENT ON COLUMN public.paper_challenges.peak_nav IS
  '통계 전용. NAV(=잔고+미실현)로 목표·실패를 판정하지 않는다.';

-- ══════════════════ ② 돈 사건 원장 ══════════════════
--
-- 잔고를 **설명**하는 표다. 잔고 자체가 아니다.
--
--   balance = INITIAL_DEPOSIT + REALIZED_PNL + TRADING_FEE(음수) + FUNDING
--
-- 부호를 모두 amount에 담으므로 `SUM(amount) = balance`가 성립한다. 그 합을
-- 유지하는 책임은 PR2의 회계 경로에 있다(이 파일은 자리만 만든다).
CREATE TABLE IF NOT EXISTS public.paper_challenge_cashflows (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id       UUID NOT NULL,
  user_id            UUID NOT NULL,
  paper_account_id   UUID NOT NULL,

  cashflow_type      TEXT NOT NULL,
  -- **부호 있음.** 수수료는 음수다.
  amount             NUMERIC NOT NULL,

  source_event_type  TEXT NOT NULL,
  source_event_id    TEXT NOT NULL,

  -- ★ **DEFAULT 없음.** 부르는 쪽이 반드시 넣는다 (파일 머리말 참고).
  event_effective_at TIMESTAMPTZ NOT NULL,
  -- 행이 기록된 시각. **판정에 쓰지 않는다.**
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  -- ★ **멱등의 정본.**
  --
  -- 유니크에 `cashflow_type`이 들어 있으므로, **같은 체결 하나**에서
  -- REALIZED_PNL과 TRADING_FEE가 각각 한 줄씩 존재할 수 있다. 그래서
  -- fill_id나 order_id 하나를 전역 멱등 키로 쓰지 않는다 — 그러면 둘 중
  -- 하나가 사라진다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_idem_key') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_idem_key
      UNIQUE (challenge_id, cashflow_type, source_event_type, source_event_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_challenge_fk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_challenge_fk
      FOREIGN KEY (challenge_id, user_id)
      REFERENCES public.paper_challenges (id, user_id);
  END IF;

  -- 계좌 소유권도 DB가 본다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_account_owner_fk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_account_owner_fk
      FOREIGN KEY (paper_account_id, user_id)
      REFERENCES public.paper_accounts (id, user_id);
  END IF;

  -- ★ **이 챌린지의 전용 계좌여야 한다.**
  --
  -- 위의 두 외래키만으로는 부족하다. `(challenge_id, user_id)`는 챌린지가
  -- 내 것인지 보고 `(paper_account_id, user_id)`는 계좌가 내 것인지 볼
  -- 뿐이라, **같은 사용자의 다른 모의 계좌**를 이 챌린지 원장에 적는 것이
  -- 구조적으로 가능하다. 두 조건을 각각 만족해도 서로 묶이지는 않는다.
  --
  -- 그러면 원장은 이 챌린지 것인데 그 돈은 다른 계좌에 있게 되고,
  -- `SUM(cashflows.amount) = paper_accounts.balance` 불변식이 조용히
  -- 깨진다 — PR2의 회계가 무엇을 하든 이미 틀린 바닥 위에서 한다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_challenge_account_fk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_challenge_account_fk
      FOREIGN KEY (challenge_id, paper_account_id)
      REFERENCES public.paper_challenges (id, paper_account_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_type_chk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_type_chk
      CHECK (cashflow_type IN ('INITIAL_DEPOSIT', 'REALIZED_PNL', 'TRADING_FEE', 'FUNDING'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_source_chk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_source_chk
      CHECK (source_event_type IN
             ('CHALLENGE_CREATE', 'POSITION_OPEN', 'POSITION_CLOSE', 'FUNDING_ACCRUAL'));
  END IF;

  -- **시작금은 양수 하나뿐이다.** 이중 지급은 위의 유니크가 막는다
  -- (challenge_id + INITIAL_DEPOSIT + CHALLENGE_CREATE + 같은 source_event_id).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_deposit_sign_chk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_deposit_sign_chk
      CHECK (cashflow_type <> 'INITIAL_DEPOSIT' OR amount > 0);
  END IF;

  -- **수수료는 음수 계약이다.** 양수로 적으면 잔고가 늘어난다.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_cashflows_fee_sign_chk') THEN
    ALTER TABLE public.paper_challenge_cashflows
      ADD CONSTRAINT paper_challenge_cashflows_fee_sign_chk
      CHECK (cashflow_type <> 'TRADING_FEE' OR amount <= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS paper_challenge_cashflows_challenge_idx
  ON public.paper_challenge_cashflows (challenge_id, event_effective_at);
CREATE INDEX IF NOT EXISTS paper_challenge_cashflows_account_idx
  ON public.paper_challenge_cashflows (paper_account_id);

COMMENT ON TABLE public.paper_challenge_cashflows IS
  '챌린지 잔고를 설명하는 원장. 불변식: SUM(amount) = paper_accounts.balance. '
  '잔고 자체는 여기 없다 — 정본은 paper_accounts.balance다.';
COMMENT ON COLUMN public.paper_challenge_cashflows.cashflow_type IS
  'INITIAL_DEPOSIT(양수) · REALIZED_PNL · TRADING_FEE(음수) · FUNDING. '
  '★ REALIZED_PNL은 **수수료 차감 전 gross 실현손익**이다. 수수료는 같은 '
  '체결의 TRADING_FEE 줄에 따로 음수로 적는다 — 순액(net)을 REALIZED_PNL에 '
  '적으면 수수료가 두 번 빠져 SUM(amount) ≠ balance가 된다.';
COMMENT ON COLUMN public.paper_challenge_cashflows.event_effective_at IS
  '이 일이 실제로 일어난 서버 기준 시각. **DEFAULT가 없다** — 부르는 쪽이 '
  '반드시 넣는다. 체결·시세 계열은 판정에 쓴 서버 관측 market timestamp, '
  '순수 서버 동작은 서버가 명시적으로 만든 시각. 클라이언트 시각 금지. '
  '만료·목표 판정의 기준이다.';
COMMENT ON COLUMN public.paper_challenge_cashflows.recorded_at IS
  '행이 기록된 시각. **판정에 쓰지 않는다** — 기준은 event_effective_at이다.';

-- ══════════════════ ③ 상태 전이 기록 ══════════════════
--
-- **감사 기록이지 제품 상태의 정본이 아니다.**
--
-- 처음에는 `UNIQUE (challenge_id, to_status)`를 두려 했다. 그러면 finalizer
-- 중복 실행이 막히긴 한다 — 그런데 그건 **감사 로그에 제품 정책("어떤 상태에
-- 한 번만 들어갈 수 있다")을 강제시키는 것**이라 결합도가 너무 높다. 상태
-- 머신이 조금만 바뀌어도 로그 제약이 제품을 막는다.
--
-- finalizer 멱등은 챌린지 행 자체의 CAS로 보장한다:
--
--   UPDATE paper_challenges SET status='CLOSED', ...
--    WHERE id = ? AND status = 'CLOSING'      -- 0행이면 남이 이미 했다
--
-- 여기서는 **사건 멱등 키**만 따로 둔다. 같은 전이 시도가 두 번 도착해도
-- 로그가 두 줄이 되지 않게 하는 용도다.
CREATE TABLE IF NOT EXISTS public.paper_challenge_transitions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id       UUID NOT NULL,
  user_id            UUID NOT NULL,

  from_status        TEXT,
  to_status          TEXT NOT NULL,
  reason             TEXT,

  -- 이 전이를 일으킨 사건의 식별자. 같은 사건은 한 줄이다.
  transition_key     TEXT NOT NULL,

  -- ★ DEFAULT 없음 (cashflows와 같은 이유).
  event_effective_at TIMESTAMPTZ NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  -- **사건 단위 멱등.** `(challenge_id, to_status)`가 아니다 — 그건 감사 로그에
  -- 제품 정책을 강제시키는 것이다(위 주석 참고).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_transitions_idem_key') THEN
    ALTER TABLE public.paper_challenge_transitions
      ADD CONSTRAINT paper_challenge_transitions_idem_key
      UNIQUE (challenge_id, transition_key);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_transitions_challenge_fk') THEN
    ALTER TABLE public.paper_challenge_transitions
      ADD CONSTRAINT paper_challenge_transitions_challenge_fk
      FOREIGN KEY (challenge_id, user_id)
      REFERENCES public.paper_challenges (id, user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'paper_challenge_transitions_status_chk') THEN
    ALTER TABLE public.paper_challenge_transitions
      ADD CONSTRAINT paper_challenge_transitions_status_chk
      CHECK (to_status IN ('READY', 'RUNNING', 'CLOSING', 'CLOSED')
             AND (from_status IS NULL
                  OR from_status IN ('READY', 'RUNNING', 'CLOSING', 'CLOSED')));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS paper_challenge_transitions_challenge_idx
  ON public.paper_challenge_transitions (challenge_id, event_effective_at);

COMMENT ON TABLE public.paper_challenge_transitions IS
  '상태 전이 감사 기록. **제품 상태의 정본이 아니다** — 정본은 '
  'paper_challenges.status다. finalizer 멱등은 챌린지 행의 CAS'
  '(WHERE status=''CLOSING'')로 보장하고, 여기서는 사건 멱등 키'
  '(challenge_id, transition_key)만 둔다.';

-- ══════════════════ RLS ══════════════════
--
-- 읽기는 소유자만. 쓰기는 service_role만 — 돈에 닿는 표라 브라우저가 직접
-- 쓰는 길을 만들지 않는다.
ALTER TABLE public.paper_challenges             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_challenge_cashflows    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_challenge_transitions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_challenges_service ON public.paper_challenges;
CREATE POLICY paper_challenges_service ON public.paper_challenges
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS paper_challenges_owner ON public.paper_challenges;
CREATE POLICY paper_challenges_owner ON public.paper_challenges
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS paper_challenge_cashflows_service ON public.paper_challenge_cashflows;
CREATE POLICY paper_challenge_cashflows_service ON public.paper_challenge_cashflows
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS paper_challenge_cashflows_owner ON public.paper_challenge_cashflows;
CREATE POLICY paper_challenge_cashflows_owner ON public.paper_challenge_cashflows
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS paper_challenge_transitions_service ON public.paper_challenge_transitions;
CREATE POLICY paper_challenge_transitions_service ON public.paper_challenge_transitions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS paper_challenge_transitions_owner ON public.paper_challenge_transitions;
CREATE POLICY paper_challenge_transitions_owner ON public.paper_challenge_transitions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
