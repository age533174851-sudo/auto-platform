-- ════════════════════════════════════════════════════════════════
-- exchange_connections RLS 정책
-- 로그인 사용자가 본인(user_id = auth.uid()) 행만 접근하도록 제한
-- Supabase → SQL Editor 에 붙여넣고 RUN (idempotent)
--
-- ⚠️ 참고: 서버(Vercel /api/exchange)는 service_role 키로 INSERT 하므로
--    원래 RLS를 "우회"합니다. 지금 RLS에 막혔다면 SERVICE_ROLE_KEY에
--    anon 키가 들어갔을 가능성이 큽니다 — 진짜 service_role secret으로 교체하세요.
--    아래 정책은 클라이언트(브라우저 JWT) 직접 접근용 + 보안 하이진입니다.
-- ════════════════════════════════════════════════════════════════

alter table public.exchange_connections enable row level security;

-- 기존 정책 제거 (재실행 안전)
drop policy if exists ec_select on public.exchange_connections;
drop policy if exists ec_insert on public.exchange_connections;
drop policy if exists ec_update on public.exchange_connections;
drop policy if exists ec_delete on public.exchange_connections;

-- SELECT: 본인 행만 조회
create policy ec_select on public.exchange_connections
  for select using (auth.uid() = user_id);

-- INSERT: 본인 user_id로만 생성
create policy ec_insert on public.exchange_connections
  for insert with check (auth.uid() = user_id);

-- UPDATE: 본인 행만 수정 (수정 후에도 본인 소유 유지)
create policy ec_update on public.exchange_connections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- DELETE: 본인 행만 삭제
create policy ec_delete on public.exchange_connections
  for delete using (auth.uid() = user_id);
