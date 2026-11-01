-- 099_ten_slot_role_acl_hardening.sql
--
-- **`REVOKE ... FROM PUBLIC`은 `anon`·`authenticated`를 막지 않는다.** (#537)
--
-- 무엇이 있었나
-- ─────────────
-- 097과 098은 함수마다 이렇게 닫았다:
--
--   REVOKE ALL ON FUNCTION public.ten_slot_claim(...) FROM PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.ten_slot_claim(...) TO service_role;
--
-- `PUBLIC`은 "아무 권한도 따로 받지 않은 모두"를 뜻하는 **가상의 수신자**다.
-- `anon`·`authenticated`가 **자기 이름으로 직접 받은 GRANT**는 그 REVOKE로
-- 지워지지 않는다. 그리고 Supabase 프로젝트에는 그 직접 GRANT를 자동으로
-- 붙이는 설정이 있다 — `pg_default_acl`의 기본 권한이다:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
--
-- 그래서 함수가 **생기는 순간** 두 역할에 EXECUTE가 붙고, 그 다음 줄의
-- `REVOKE ... FROM PUBLIC`은 그것을 건드리지 못한다. 격리된 PostgreSQL
-- 16에서 그대로 재현했다:
--
--   REVOKE ALL ON FUNCTION probe_fn() FROM PUBLIC;
--   GRANT  EXECUTE ON FUNCTION probe_fn() TO service_role;
--   → has_function_privilege('anon', 'probe_fn()', 'EXECUTE') = true   ← 남아 있다
--
--   REVOKE ALL ON FUNCTION probe_fn() FROM anon, authenticated;
--   → false. service_role만 true.
--
-- 표도 같다. 097·098은 네 표에 RLS를 켰지만 **GRANT 층은 닫지 않았다.**
-- 기본 권한이 `anon`·`authenticated`에 표 권한을 붙여 두면 남는 방어선은
-- RLS 하나뿐이다. 이 저장소는 그 판단을 이미 한 번 적어 뒀다 —
-- `095_exact100x_observation_acl_hardening.sql`:
--
--   "Supabase 프로젝트의 legacy default privileges가 새 public table에
--    anon/authenticated 권한을 자동으로 부여할 수 있으므로, RLS에만
--    기대지 않고 table privilege 자체도 명시적으로 닫는다."
--
-- 095는 표에 대해 그렇게 했고(`FROM anon, authenticated`), **097·098은
-- 그 교훈을 함수와 자기 표에 가져오지 않았다.** 같은 판단이 두 곳에 있고
-- 한쪽만 고쳐진 상태다 — `CLAUDE.md`의 상습 고장 ②다.
--
-- 왜 097·098을 고치지 않고 새 파일인가
-- ────────────────────────────────────
-- 두 파일은 이미 마이그레이션 장부에 올라가 있다. 적용된 뒤에 파일을
-- 바꾸면 체크섬이 달라져 "적용된 뒤에 파일이 바뀌었습니다"가 되고, 그건
-- 장부가 거짓이 되는 쪽이다. 뒤에 한 장을 더 쌓는다.
--
-- ■ 위험 분류: **권한 축소 — 사람 승인이 필요하다**
--
--   `classifyMigration`은 이 파일을 `UNKNOWN`으로 적는다. 이유는
--   "DO 블록 안에서 EXECUTE로 SQL을 조립해 실행합니다"다 — 분류기가
--   읽을 수 없는 문장이다. **그 판정이 맞다.** 자동 파이프라인이 권한을
--   줄이는 장을 사람 없이 적용하면 안 된다. 분류를 낮추려고 아래 DO
--   블록을 손으로 적은 서명 목록으로 바꾸지 않는다 — 그러면 함수 하나를
--   빠뜨렸을 때 아무 신호가 없다.
--
--   표·함수를 만들지도 지우지도 않는다. 바꾸는 것은 **권한뿐**이다.
--   그래도 자동 적용 대상이 아니다 — 지금 `anon`·`authenticated`로 그
--   함수를 부르거나 그 표를 읽는 코드가 있으면 **이 장이 그것을 끊는다.**
--
--   끊어도 되는 근거: `ten_slot_*`를 부르는 코드는 `src/`·`worker/`에
--   아직 **한 곳도 없다**(배선 전이다). 그리고 097이 설계로 남긴 읽기
--   경로 하나(`ten_slot_campaigns_owner`: authenticated가 자기 캠페인을
--   SELECT)는 **되살려 둔다** — 그 정책이 죽은 정책이 되지 않게.
--
--   되돌리기: 이 장은 권한만 줄이므로 역방향은 `GRANT`다. 자동으로
--   되돌리지 않는다 — 넓히는 것은 사람이 결정한다.

-- ── 함수: 카탈로그를 돌며 전수로 닫는다 ──
--
-- 서명을 손으로 적지 않는다. 097·098에 함수가 10개 있고 인자 목록이
-- 길어서, 손으로 적으면 **한 개를 빠뜨렸을 때 아무 신호가 없다.**
-- 오버로드가 생겨도 이 방식은 따라온다.
--
-- `oid::regprocedure`가 서명을 그대로 돌려주므로 인자 목록을 다시 적지
-- 않는다 — 다시 적으면 그게 바로 "같은 것을 두 곳에 적는" 자리다.
DO $$
DECLARE
  f RECORD;
  n INT := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig,
           p.prorettype = 'pg_catalog.trigger'::regtype AS is_trigger
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname LIKE 'ten\_slot\_%'
  LOOP
    -- `PUBLIC`과 두 역할을 **같이** 적는다. 하나만 적으면 다른 쪽이 남는다.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    -- 트리거 함수는 호출자가 부르는 것이 아니다 — EXECUTE를 주지 않는다.
    IF NOT f.is_trigger THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
    END IF;
    n := n + 1;
  END LOOP;

  -- **하나도 못 찾았으면 조용히 통과하지 않는다.** 097이 아직 안 깔린
  -- DB에서 이 장이 "다 닫았다"로 끝나면, 나중에 함수가 생길 때 권한은
  -- 열린 채로 남고 장부에는 닫은 것으로 적힌다.
  IF n = 0 THEN
    RAISE EXCEPTION 'ten_slot_* 함수를 하나도 찾지 못했습니다 — 097/098보다 먼저 적용되었습니까?';
  END IF;
  RAISE NOTICE 'ten_slot 함수 %개의 권한을 닫았습니다', n;
END $$;

-- ── 표: 095와 같은 방식으로 닫는다 ──
REVOKE ALL PRIVILEGES ON TABLE
  public.ten_slot_campaigns,
  public.ten_slot_slots,
  public.ten_slot_claims,
  public.ten_slot_events
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE
  public.ten_slot_campaigns,
  public.ten_slot_slots,
  public.ten_slot_claims,
  public.ten_slot_events
  TO service_role;

-- 097이 설계로 남긴 읽기 경로. 정책(`ten_slot_campaigns_owner`)은
-- `user_id = auth.uid()`로 줄을 좁히고, 이 GRANT가 그 정책이 **닿을 수
-- 있게** 한다. 권한이 없으면 정책은 평가되지도 않는 죽은 정책이 된다.
-- 나머지 세 표에는 authenticated 정책이 없으므로 권한도 주지 않는다.
GRANT SELECT ON TABLE public.ten_slot_campaigns TO authenticated;
