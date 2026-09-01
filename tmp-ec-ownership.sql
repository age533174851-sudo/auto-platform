\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

\set ua '11111111-1111-4111-8111-111111111111'
\set ub '22222222-2222-4222-8222-222222222222'

-- ── 준비: 테스트 사용자 둘과 각자 소유 행 하나씩 (superuser로 만든다) ──
DO $prep$
BEGIN
  FOR i IN 1..2 LOOP
    NULL;
  END LOOP;
END
$prep$;

DO $mkusers$
DECLARE ids uuid[] := ARRAY['11111111-1111-4111-8111-111111111111'::uuid,
                            '22222222-2222-4222-8222-222222222222'::uuid];
        u uuid;
BEGIN
  FOREACH u IN ARRAY ids LOOP
    BEGIN
      INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                              email_confirmed_at, created_at, updated_at,
                              raw_app_meta_data, raw_user_meta_data)
      VALUES ('00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
              u::text || '@example.test', '', now(), now(), now(), '{}', '{}')
      ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO auth.users (id) VALUES (u) ON CONFLICT (id) DO NOTHING;
    END;
  END LOOP;
END
$mkusers$;

DELETE FROM exchange_connections WHERE user_id IN (:'ua'::uuid, :'ub'::uuid);
INSERT INTO exchange_connections (id, user_id, exchange_id, label)
VALUES ('aaaaaaaa-0000-4000-8000-00000000000a', :'ua'::uuid, 'binance', 'A의 연결');
INSERT INTO exchange_connections (id, user_id, exchange_id, label)
VALUES ('bbbbbbbb-0000-4000-8000-00000000000b', :'ub'::uuid, 'bybit',   'B의 연결');

-- ── 현재 정책 상태 (with_check=NULL을 "검사 없음"으로 읽지 않는다) ──
SELECT 'POLICY_cmd=' || cmd || ' permissive=' || permissive
       || ' qual=' || coalesce(qual, '(없음)')
       || ' with_check=' || coalesce(with_check, 'NULL')
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'exchange_connections'
   AND policyname = 'exchange_conn_self_update';

-- authenticated가 표에 UPDATE 권한 자체는 갖고 있는가.
-- (없으면 A1도 42501로 실패하고, 그러면 "RLS가 막았다"와 구별되지 않는다)
SELECT 'GRANT_authenticated_update=' ||
       CASE WHEN has_table_privilege('authenticated', 'public.exchange_connections', 'UPDATE')
            THEN 'yes' ELSE 'NO' END;
SELECT 'ROLE_service_role_bypassrls=' ||
       CASE WHEN (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role')
            THEN 'yes' ELSE 'no' END;

-- ── 실행 도구: 오류를 값으로 돌려준다 ──
CREATE OR REPLACE FUNCTION pg_temp.try_sql(stmt text) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE n int; st text; msg text;
BEGIN
  EXECUTE stmt;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN 'OK rows=' || n;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  RETURN 'ERR sqlstate=' || st || ' msg=' || msg;
END
$fn$;

-- ── USER_A 문맥 ──
BEGIN;
SET LOCAL request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET LOCAL ROLE authenticated;

SELECT 'CTX_auth_uid=' || coalesce(auth.uid()::text, 'NULL');
SELECT 'CTX_current_user=' || current_user;

-- A1: 자기 행의 일반 칸 수정 → 성공해야 한다
SELECT 'A1=' || pg_temp.try_sql(
  $q$UPDATE exchange_connections SET label = 'A가 바꾼 이름'
      WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000a'$q$);

-- A2: 자기 행의 user_id를 B로 넘김 → 막혀야 한다
SELECT 'A2=' || pg_temp.try_sql(
  $q$UPDATE exchange_connections
        SET user_id = '22222222-2222-4222-8222-222222222222'
      WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000a'$q$);

-- A4: B 소유 행을 A가 수정 → 보이지도 않아야 한다
SELECT 'A4=' || pg_temp.try_sql(
  $q$UPDATE exchange_connections SET label = 'A가 남의 것을 건드림'
      WHERE id = 'bbbbbbbb-0000-4000-8000-00000000000b'$q$);
COMMIT;

-- A3: 위 시도 뒤 소유자가 그대로인가 (superuser로 확인)
SELECT 'A3_owner_is_A=' ||
       CASE WHEN user_id = :'ua'::uuid THEN 'yes' ELSE 'NO(' || user_id::text || ')' END
       || ' label=' || label
  FROM exchange_connections WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000a';

-- ── USER_B 문맥 ──
BEGIN;
SET LOCAL request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
SET LOCAL ROLE authenticated;
-- A5: A 소유 행을 B가 수정 → 보이지도 않아야 한다
SELECT 'A5=' || pg_temp.try_sql(
  $q$UPDATE exchange_connections SET label = 'B가 남의 것을 건드림'
      WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000a'$q$);
COMMIT;

-- ── service_role 문맥 (기존 서버 모델: RLS 우회) ──
BEGIN;
SET LOCAL ROLE service_role;
SELECT 'A6=' || pg_temp.try_sql(
  $q$UPDATE exchange_connections SET label = 'service_role이 바꿈'
      WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000a'$q$);
COMMIT;

SELECT 'A6_label_now=' || label FROM exchange_connections
 WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000a';
SELECT 'A6_owner_still_A=' ||
       CASE WHEN user_id = :'ua'::uuid THEN 'yes' ELSE 'NO' END
  FROM exchange_connections WHERE id = 'aaaaaaaa-0000-4000-8000-00000000000a';
