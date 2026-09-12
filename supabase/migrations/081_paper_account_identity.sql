-- 081_paper_account_identity.sql
--
-- **모의 계좌에 정체를 준다 — 사용자당 하나라는 가정을 푼다.**
--
-- 왜 필요한가
-- ───────────
-- `paper_accounts`의 기본키가 `user_id`였다. 사용자당 계좌가 **구조적으로
-- 하나**라는 뜻이다. 그래서 "챌린지마다 독립된 시작금으로 시작한다"를
-- 만들 수 없다 — 두 번째 계좌를 넣을 자리가 없다.
--
-- 이 파일은 자리를 만들기만 한다. **챌린지 표도, 원장도, 입금도 만들지
-- 않는다.** 그건 다음 작업이다. 여기서 그것까지 하면 기존 모의투자 경로의
-- 회귀와 새 기능의 결함이 한 덩어리로 섞여서, 무엇이 깨졌는지 못 가른다.
--
-- 기본 계좌를 무엇으로 가리는가
-- ──────────────────────────────
-- "그 사용자의 첫 줄"로 정하면 나중에 반드시 모호해진다. 계좌가 여럿이
-- 되는 순간 "첫 줄"은 만든 순서·인덱스·플랜에 따라 달라지고, 그때는
-- 이미 잔고가 들어 있다.
--
-- 그래서 **명시 플래그**를 둔다. `is_default`가 정본이다.
--
-- 부분 유니크 인덱스가 보장하는 것과 못 하는 것
-- ─────────────────────────────────────────────
-- `UNIQUE (user_id) WHERE is_default`가 막는 것은 **두 개가 되는 것**뿐이다.
-- **0개는 막지 못한다** — 그 사용자의 모든 계좌가 `is_default = false`인
-- 상태를 DB는 정상으로 받아들인다.
--
-- 즉 이 인덱스는 "정확히 하나"가 아니라 **"최대 하나"**를 강제한다.
-- 그 차이를 적어 두는 이유는, "DB가 보장하니 코드는 안 봐도 된다"고
-- 읽히면 그 순간 0개 상태가 아무도 안 보는 구멍이 되기 때문이다.
--
-- 0개는 이렇게 막는다
-- ───────────────────
--   · 기존 사용자 — `user_id`가 기본키였으므로 사용자당 정확히 한 줄이고,
--     아래 backfill이 그 줄을 기본으로 표시한다 → 정확히 하나
--   · 새 사용자 — 계좌를 만드는 두 자리가 모두 `is_default: true`로 넣는다
--   · **낮추거나 지우는 경로가 없다** — 제품 코드에 `is_default`를 false로
--     바꾸거나 계좌를 지우는 곳이 0곳이다. 그런 경로가 생기면
--     `check-paper-account-identity`가 CI에서 막는다
--   · 그래도 0개가 되면 **모든 경로가 fail-closed다** — 임의 계좌를 고르지
--     않고 "계좌 없음"으로 멈춘다(RPC는 NO_ACCOUNT 또는 예외)
--
-- 트리거로 "최소 하나"까지 DB에서 강제하지 않은 이유는, 낮추거나 지우는
-- 경로가 아예 없는 지금은 막을 대상이 없고, 트리거는 대신 "마지막 계좌를
-- 영영 못 지운다"는 새 실패 모드를 만들기 때문이다. 그 경로가 생기는 날
-- 함께 넣는 것이 맞다.
--
-- 다른 사용자의 계좌에 붙는 것을 막는 방법
-- ────────────────────────────────────────
-- `paper_positions.paper_account_id` 하나만 두면, 계좌 id만 알면 남의
-- 계좌에 포지션을 붙일 수 있다. 그래서 **복합 외래키**를 쓴다:
--
--     (paper_account_id, user_id) → paper_accounts (id, user_id)
--
-- 소유자가 다르면 DB가 거부한다. 서비스 계층의 검사 하나에 기대지 않는다.
--
-- 정산은 포지션을 따라간다
-- ────────────────────────
-- `paper_settle_close`는 포지션의 `user_id`로 계좌를 찾고 있었다. 계좌가
-- 여럿이 되면 그 방식은 어느 계좌인지 말해 주지 못한다. 포지션이 자기
-- 계좌를 들고 있으면 정산이 그것을 따라가면 된다 — 새 인자가 필요 없다.
--
-- 기존 행에 미치는 영향
-- ─────────────────────
-- 지금은 사용자당 계좌가 하나뿐이므로, 그 하나가 곧 기본 계좌다. 기존
-- 포지션도 전부 그 계좌에 속한다. 둘 다 아래에서 채운다 — 값이 바뀌는
-- 것이 아니라 지금까지 암묵이던 사실을 적는 것이다.

-- ── ① 계좌에 id와 기본 여부 ──
ALTER TABLE public.paper_accounts
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.paper_accounts
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- 기존 줄은 전부 그 사용자의 기본 계좌다. 하나뿐이었으므로 다툼이 없다.
UPDATE public.paper_accounts SET is_default = TRUE WHERE is_default IS NOT TRUE;

-- ── ② 기본키를 id로 옮긴다 ──
--
-- 제약 이름을 못박지 않는다. 표가 다른 경로로 만들어졌으면 이름이 다를 수
-- 있고, 그때 이 파일이 "없는 제약을 지운다"며 멈추면 안 된다.
DO $$
DECLARE v_pk TEXT;
BEGIN
  SELECT conname INTO v_pk
    FROM pg_constraint
   WHERE conrelid = 'public.paper_accounts'::regclass
     AND contype = 'p';

  IF v_pk IS NOT NULL THEN
    -- 이미 id가 기본키면 아무것도 하지 않는다 (재실행 안전).
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'public.paper_accounts'::regclass
         AND i.indisprimary
         AND i.indnatts = 1
         AND i.indkey[0] = (
           SELECT attnum FROM pg_attribute
            WHERE attrelid = 'public.paper_accounts'::regclass AND attname = 'id')
    ) THEN
      EXECUTE format('ALTER TABLE public.paper_accounts DROP CONSTRAINT %I', v_pk);
      ALTER TABLE public.paper_accounts ADD CONSTRAINT paper_accounts_pkey PRIMARY KEY (id);
    END IF;
  ELSE
    ALTER TABLE public.paper_accounts ADD CONSTRAINT paper_accounts_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- ── ③ 복합 외래키가 가리킬 정본 ──
--
-- `(id, user_id)`가 유니크해야 아래 포지션의 복합 FK를 걸 수 있다.
-- id가 이미 기본키라 논리적으로는 당연하지만, FK는 **선언된 유니크 제약**을
-- 요구한다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'paper_accounts_id_owner_key'
  ) THEN
    ALTER TABLE public.paper_accounts
      ADD CONSTRAINT paper_accounts_id_owner_key UNIQUE (id, user_id);
  END IF;
END $$;

-- ── ④ 사용자당 기본 계좌는 최대 하나 ──
--
-- 부분 유니크 인덱스다. 기본이 아닌 계좌는 몇 개든 가질 수 있고, 기본은
-- **최대 하나**다. 코드가 실수해도 두 개가 될 수 없다 — 다만 0개는 이
-- 인덱스가 막지 못한다(파일 머리말 참고).
CREATE UNIQUE INDEX IF NOT EXISTS paper_accounts_one_default_per_user
  ON public.paper_accounts (user_id) WHERE is_default;

COMMENT ON COLUMN public.paper_accounts.id IS
  '계좌의 정체. 사용자당 여러 계좌를 가질 수 있다.';
COMMENT ON COLUMN public.paper_accounts.is_default IS
  '이 사용자의 기본 모의 계좌인가. 부분 유니크 인덱스가 최대 하나를 보장한다 '
  '(0개는 막지 못한다 — 낮추는 경로가 없고, 0개면 모든 경로가 fail-closed다). '
  '계좌를 지정하지 않은 기존 경로는 이 계좌로 간다.';

-- ── ⑤ 포지션이 자기 계좌를 든다 ──
ALTER TABLE public.paper_positions
  ADD COLUMN IF NOT EXISTS paper_account_id UUID;

-- 기존 포지션은 전부 그 사용자의 기본 계좌 소속이다.
UPDATE public.paper_positions p
   SET paper_account_id = a.id
  FROM public.paper_accounts a
 WHERE p.paper_account_id IS NULL
   AND a.user_id = p.user_id
   AND a.is_default;

-- **소유자가 다르면 DB가 거부한다.**
--
-- 둘 중 하나라도 NULL이면 이 제약은 검사하지 않는다(MATCH SIMPLE). 주인을
-- 모르는 옛 줄까지 여기서 막지는 않는다 — 그건 이 작업의 범위가 아니고,
-- 막으면 기존 데이터가 마이그레이션에서 걸린다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'paper_positions_account_owner_fk'
  ) THEN
    ALTER TABLE public.paper_positions
      ADD CONSTRAINT paper_positions_account_owner_fk
      FOREIGN KEY (paper_account_id, user_id)
      REFERENCES public.paper_accounts (id, user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS paper_positions_account_idx
  ON public.paper_positions (paper_account_id) WHERE paper_account_id IS NOT NULL;

COMMENT ON COLUMN public.paper_positions.paper_account_id IS
  '이 포지션이 속한 모의 계좌. 정산이 이 값을 따라간다. '
  '(paper_account_id, user_id) 복합 FK로 남의 계좌에 붙일 수 없다.';
