-- scripts/sql/098_runtime_rls_proof.sql
--
-- **098이 실제로 막는가.** 진짜 PostgreSQL에서 anon·authenticated로
-- 붙어 SELECT·INSERT·UPDATE·DELETE를 시도한다.
--
-- RED→GREEN: 098을 적용하기 전에는 이 증명이 "뚫림"을 보고하고,
-- 적용한 뒤에는 네 가지가 전부 거부돼야 한다.
--
-- service_role은 그대로 전부 할 수 있어야 한다 — 잠그느라 서버·워커를
-- 끊으면 안 된다.

\set ON_ERROR_STOP on
\pset tuples_only on

DO $$
DECLARE
  t TEXT; n INT := 0;
BEGIN
  -- ── 기대 ①: 세 표 모두 RLS가 켜져 있고 FORCE까지 걸려 있다 ──
  FOREACH t IN ARRAY ARRAY['runtime_jobs','runtime_leases','runtime_ticks'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = t AND relnamespace = 'public'::regnamespace) THEN
      RAISE EXCEPTION 'FAIL 표가 없습니다: %', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE relname = t AND relnamespace = 'public'::regnamespace) THEN
      RAISE EXCEPTION 'FAIL RLS가 꺼져 있습니다: %', t;
    END IF;
    RAISE NOTICE 'ok  RLS 켜짐  → %', t;
    IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE relname = t AND relnamespace = 'public'::regnamespace) THEN
      RAISE EXCEPTION 'FAIL FORCE가 걸려 있지 않습니다 (소유자가 정책을 건너뜁니다): %', t;
    END IF;
    RAISE NOTICE 'ok  FORCE 걸림  → %', t;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'ok  표 3개 확인  → %', n;

  -- ── 기대 ②: anon·authenticated·PUBLIC에 남은 권한이 0이다 ──
  FOR t IN SELECT unnest(ARRAY['runtime_jobs','runtime_leases','runtime_ticks']) LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = t
         AND grantee IN ('anon','authenticated','PUBLIC')
    ) THEN
      RAISE EXCEPTION 'FAIL 브라우저 역할에 권한이 남아 있습니다: %', t;
    END IF;
    RAISE NOTICE 'ok  anon/authenticated/PUBLIC 권한 0  → %', t;
  END LOOP;

  -- ── 기대 ③: service_role 정책이 있다 ──
  FOR t IN SELECT unnest(ARRAY['runtime_jobs','runtime_leases','runtime_ticks']) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t AND 'service_role' = ANY(roles)
    ) THEN
      RAISE EXCEPTION 'FAIL service_role 정책이 없습니다: %', t;
    END IF;
    RAISE NOTICE 'ok  service_role 정책 있음  → %', t;
  END LOOP;
END $$;
