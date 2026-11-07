-- 096_exchange_connections_environment_identity.sql
--
-- **한 사용자가 같은 거래소의 실전과 테스트넷을 동시에 갖게 한다.**
--
-- 무엇이 틀려 있었나
-- ─────────────────
-- 지금까지 연결의 유일성은 이것이었다:
--
--     UNIQUE (user_id, exchange_id)
--
-- 그리고 연결 생성 API는 `onConflict: 'user_id,exchange_id'`로 upsert했다.
-- 그래서 Binance 실전 연결이 있는 사용자가 Binance **테스트넷**을 등록하면
-- 새 연결이 생기는 대신 **기존 실전 row가 갱신됐다.** 실전 키가 테스트넷
-- 키로 덮인다.
--
-- Exact100X 실측은 Binance TESTNET 연결을 요구하는데, 그 연결을 만들려면
-- 실전 연결을 잃어야 하는 상태였다. 그래서 환경을 identity에 넣는다.
--
--     user_id + exchange_id + is_testnet
--
-- `is_testnet`은 `not null default true`다(004). 그래서 nullable identity가
-- 되지 않는다 — NULL이 섞이면 Postgres에서 유일성이 무력해진다.
--
-- 이 마이그레이션이 하지 않는 것
-- ─────────────────────────────
-- ★ **데이터를 고치지 않는다.** duplicate가 있으면 합치거나 지우는 대신
--   RAISE로 멈춘다. 어느 연결이 맞는지는 사람이 정한다 — 잘못 합치면
--   어느 키가 사라졌는지 아무도 모른다.
--
-- ★ `UNIQUE (user_id, exchange, nickname)`(옛 제약)을 **건드리지 않는다.**
--   대신 새 연결의 기본 이름을 환경별로 다르게 만들어(코드 쪽) 애초에
--   부딪히지 않게 한다. 쓰고 있는 제약을 조용히 떨어뜨리지 않는다.
--
-- ★ 자동매매 설정을 바꾸지 않는다.

-- ── preflight: 새 identity로 유일한가 ──
--
--   먼저 센다. 어긋난 줄이 있으면 **제약을 걸기 전에** 멈춘다. 제약을
--   먼저 걸면 Postgres가 자기 메시지로 실패하고, 몇 그룹이 어떻게
--   어긋났는지는 남지 않는다.
DO $$
DECLARE
  bad_groups integer;
  sample text;
BEGIN
  SELECT count(*) INTO bad_groups FROM (
    SELECT user_id, exchange_id, is_testnet
      FROM public.exchange_connections
     GROUP BY user_id, exchange_id, is_testnet
    HAVING count(*) > 1
  ) d;

  IF bad_groups > 0 THEN
    SELECT string_agg(format('%s/%s/testnet=%s x%s', user_id, exchange_id, is_testnet, c), ', ')
      INTO sample
      FROM (
        SELECT user_id, exchange_id, is_testnet, count(*) AS c
          FROM public.exchange_connections
         GROUP BY user_id, exchange_id, is_testnet
        HAVING count(*) > 1
         LIMIT 5
      ) s;
    RAISE EXCEPTION
      '(user_id, exchange_id, is_testnet)가 겹치는 그룹이 % 개입니다: %. '
      ' 어느 연결이 맞는지는 사람이 정합니다 — 이 마이그레이션은 데이터를 고치지 않습니다.',
      bad_groups, sample;
  END IF;
END $$;

-- ── 환경을 보지 않던 옛 제약을 뗀다 ──
--
--   이 제약이 남아 있으면 새 제약을 걸어도 두 번째 환경을 등록할 수 없다.
--   이름이 다를 수 있으므로 IF EXISTS로 둔다.
ALTER TABLE public.exchange_connections
  DROP CONSTRAINT IF EXISTS exchange_connections_user_id_exchange_id_key;

-- ── 환경을 포함한 새 제약 ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'exchange_connections_user_exchange_env_key'
       AND conrelid = 'public.exchange_connections'::regclass
  ) THEN
    ALTER TABLE public.exchange_connections
      ADD CONSTRAINT exchange_connections_user_exchange_env_key
      UNIQUE (user_id, exchange_id, is_testnet);
  END IF;
END $$;

COMMENT ON CONSTRAINT exchange_connections_user_exchange_env_key
  ON public.exchange_connections IS
  '연결의 자리는 사용자+거래소+환경이다. 같은 거래소의 실전과 테스트넷은 서로 다른 연결이며, 한쪽을 등록해도 다른 쪽이 갱신되지 않는다.';
