-- 095_exact100x_observation_acl_hardening.sql
--
-- Exact100X 관측 표는 server-side service role 전용이다.
-- Supabase 프로젝트의 legacy default privileges가 새 public table에
-- anon/authenticated 권한을 자동으로 부여할 수 있으므로, RLS에만 기대지 않고
-- table privilege 자체도 명시적으로 닫는다.
--
-- RLS와 GRANT는 다른 층이다:
--   GRANT/REVOKE = role이 table에 접근할 수 있는가
--   RLS          = 접근 가능한 role이 어느 row를 볼/쓸 수 있는가
--
-- service_role은 서버 전용이며 RLS를 우회할 수 있으므로, 이 migration의
-- 보호 경계는 anon/authenticated의 table privilege를 제거하고
-- service_role만 남기는 것이다.

REVOKE ALL PRIVILEGES ON TABLE public.exact100x_risk_observations
  FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.exact100x_exit_escape_observations
  FROM anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.exact100x_risk_observations
  TO service_role;

GRANT ALL PRIVILEGES ON TABLE public.exact100x_exit_escape_observations
  TO service_role;
