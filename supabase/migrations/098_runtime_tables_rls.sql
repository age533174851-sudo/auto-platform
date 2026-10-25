-- 098_runtime_tables_rls.sql
--
-- **runtime_* 세 표가 브라우저 키로 열려 있다.**
--
-- 운영 `traigo` 프로젝트에서 직접 확인된 상태:
--
--   runtime_jobs    RLS OFF · anon/authenticated SELECT·INSERT·UPDATE 허용
--   runtime_leases  RLS OFF · anon/authenticated SELECT·INSERT·UPDATE 허용
--   runtime_ticks   RLS OFF · anon/authenticated SELECT·INSERT·UPDATE 허용
--
-- 왜 이렇게 됐나
-- ──────────────
-- `044_runtime_jobs.sql`이 세 표를 만들면서 RLS도 정책도 GRANT도 적지
-- 않았다. Supabase에서 `public` 스키마에 표를 만들면 `anon`·`authenticated`
-- 역할이 기본 권한을 물려받으므로, **아무것도 안 적으면 열린다.**
-- 잠그는 문장을 빠뜨린 것이 곧 여는 것이다.
--
-- 무엇이 가능했나
-- ───────────────
-- 이 표들은 "무엇을 돌릴 것인가(desired_state)"와 "누가 그것을 잡고
-- 있는가(임차)"를 담는다. 브라우저 키로 쓸 수 있으면:
--
--   · 남의 `runtime_jobs.desired_state`를 RUNNING으로 바꿔 자동매매를 켠다
--   · `runtime_leases`를 빼앗아 남의 작업을 가로채거나 멈춘다
--   · `runtime_ticks`에 일어나지 않은 실행을 적는다
--
-- 지금 이 표를 쓰는 코드는 없다
-- ─────────────────────────────
-- 저장소 전수 검색 결과 `runtime_jobs`·`runtime_leases`·`runtime_ticks`를
-- 읽거나 쓰는 코드가 **한 줄도 없다**(매니페스트 등록 한 줄 제외).
-- 044가 구조만 만들고 배선되지 않은 상태다.
--
-- 그래서 `service_role` 전용으로 잠가도 **끊기는 기능이 없다.** 나중에
-- 서버·워커가 쓰게 되면 그쪽은 `getSupabaseAdmin()`과 워커의
-- `SUPABASE_SERVICE_ROLE_KEY`를 쓰므로 그대로 동작한다 — service_role은
-- RLS를 통째로 우회한다.
--
-- 지금 잠그는 이유도 그것이다. **쓰는 코드가 생긴 뒤에 잠그면**, 그때는
-- 무엇이 깨지는지 보면서 잠가야 하고 보통 그 단계에서 미뤄진다.
--
-- 왜 022와 같은 모양인가
-- ──────────────────────
-- `022_rls_worker_tables.sql`이 워커 표 넷에 대해 똑같은 일을 이미 했다.
-- 판단을 새로 만들지 않고 그 모양을 그대로 쓴다 — 같은 문제의 처리가
-- 두 가지면 언젠가 갈린다.
--
-- ⚠ 운영 적용은 **별도 승인**이 필요하다.
--    이 파일은 데이터를 지우지 않지만, 잘못 적용하면 나중에 배선될
--    서버 경로가 막힌다. 적용 전에 아래를 읽기 전용으로 확인할 것:
--
--      SELECT relname, relrowsecurity FROM pg_class
--       WHERE relname IN ('runtime_jobs','runtime_leases','runtime_ticks');
--
--      SELECT grantee, table_name, privilege_type
--        FROM information_schema.role_table_grants
--       WHERE table_name IN ('runtime_jobs','runtime_leases','runtime_ticks')
--         AND grantee IN ('anon','authenticated','PUBLIC');

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_jobs', 'runtime_leases', 'runtime_ticks']
  LOOP
    -- 표가 없는 환경(044 미적용)에서는 조용히 건너뛴다.
    IF to_regclass('public.' || quote_ident(t)) IS NULL THEN
      RAISE NOTICE '건너뜀: public.% 가 없습니다', t;
      CONTINUE;
    END IF;

    -- ① RLS를 켠다.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- ② 표 소유자에게도 RLS를 적용한다.
    --
    --    **이것을 빠뜨리면 ①이 반쪽이다.** 소유자는 기본적으로 RLS를
    --    건너뛰므로, 소유자 권한으로 연결하는 경로가 하나라도 생기면
    --    정책이 없는 것과 같아진다.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    -- ③ 브라우저 키에서 권한을 거둔다.
    --
    --    RLS만 켜고 GRANT를 남겨 두면 "정책이 없어 0줄"이 되는데, 그건
    --    권한이 없는 것과 **다르다** — 정책이 하나라도 잘못 붙는 순간
    --    열린다. 권한 자체를 거두는 쪽이 한 겹 더 두껍다.
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);

    -- ④ 서버·워커만 전부 할 수 있다.
    --
    --    service_role은 RLS를 우회하지만, 정책을 명시해 둔다. 나중에
    --    누군가 FORCE를 켠 채 다른 역할로 붙어도 의도가 코드에 남는다.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t || '_service_all', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);

    RAISE NOTICE '잠금: public.% — RLS ON · FORCE · anon/authenticated/PUBLIC 회수 · service_role 전용', t;
  END LOOP;
END $$;
