-- 022_rls_worker_tables.sql
--
-- RLS가 꺼진 표 넷을 잠근다.
--
-- 무엇이 문제였나
-- ───────────────
-- Supabase는 `public` 스키마의 표를 PostgREST로 **인터넷에 노출한다.**
-- 접근에는 anon 키가 필요한데, 그 키는 브라우저 번들에 들어 있다
-- (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) — 즉 공개된 값이다.
--
-- RLS(행 수준 보안)를 켜지 않으면 그 키만으로 **누구나 읽고 쓸 수 있다.**
-- Supabase Advisors가 CRITICAL로 잡은 것이 이것이다.
--
-- 넷 중 `worker_lock`이 가장 위험하다
-- ──────────────────────────────────
--   worker_lock       분산 잠금. 남이 쓸 수 있으면 **잠금을 뺏거나 풀 수
--                     있다.** 청산 감시가 두 번 돌거나(중복 청산), 잠금을
--                     영원히 잡아 두면 아예 안 돈다
--   worker_heartbeat  실행기 생존 신호. 위조하면 죽은 실행기가 살아 있는
--                     것으로 보이고, 주문이 조용히 쌓인다
--   telegram_alert_log  알림 기록. 읽으면 이 계정의 매매 알림이 다 보인다
--   kill_switch_log   킬스위치 발동 이력
--
-- 앱이 깨지지 않는 이유
-- ─────────────────────
-- 이 넷은 전부 **service_role 키로만** 접근한다 (`getSupabaseAdmin()`,
-- 워커의 `SUPABASE_SERVICE_ROLE_KEY`). service_role은 RLS를 통째로
-- 우회하므로, RLS를 켜도 서버 코드는 그대로 돈다.
--
-- 정책을 안 만들고 RLS만 켜면 어떻게 되나: anon·authenticated는 아무것도
-- 못 하게 된다. **그게 맞다** — 이 넷은 사용자가 직접 볼 표가 아니다.
-- 필요한 값은 이미 `/api/worker/status` 같은 라우트가 서버에서 읽어 준다.

-- 표가 없을 수도 있다(워커를 안 쓰는 배포). 없으면 조용히 넘어간다 —
-- 여기서 에러가 나면 뒤의 표까지 안 잠긴다.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'worker_lock', 'worker_heartbeat', 'telegram_alert_log', 'kill_switch_log'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

      -- 서버(service_role)만 전부 할 수 있다.
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service', t);
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        t || '_service', t);

      RAISE NOTICE 'RLS 적용: %', t;
    ELSE
      RAISE NOTICE '표 없음(건너뜀): %', t;
    END IF;
  END LOOP;
END $$;
