-- ═══════════════════════════════════════════════════════════════════════
-- 003_login_sessions.sql — 사용자 로그인 세션 기록 (idempotent)
--
-- 실행 방법:
--   Supabase Dashboard → SQL Editor → New Query →
--   이 파일 전체 붙여넣기 → Run
-- ═══════════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── user_login_sessions 테이블 ─────────────────────────────────────────
create table if not exists user_login_sessions (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users(id) on delete cascade,
  email         text        not null,
  session_token text,                       -- 세션 식별용 (cookies hash 또는 uuid)
  device_name   text,                       -- 'iPhone 15', 'MacBook Pro', 'Galaxy S24' 등
  device_type   text,                       -- 'mobile', 'desktop', 'tablet'
  browser       text,                       -- 'Chrome', 'Safari', 'Edge'
  os            text,                       -- 'iOS', 'Android', 'macOS', 'Windows'
  ip_address    text,
  country       text,
  city          text,
  user_agent    text,
  is_current    boolean     not null default true,
  revoked       boolean     not null default false,
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- ── 인덱스 ──────────────────────────────────────────────────────────────
create index if not exists idx_login_sessions_user      on user_login_sessions(user_id);
create index if not exists idx_login_sessions_user_seen on user_login_sessions(user_id, last_seen_at desc);
create index if not exists idx_login_sessions_token     on user_login_sessions(session_token);

-- ── RLS ────────────────────────────────────────────────────────────────
alter table user_login_sessions enable row level security;

drop policy if exists "login_sessions_self_read"   on user_login_sessions;
drop policy if exists "login_sessions_self_update" on user_login_sessions;
drop policy if exists "login_sessions_self_delete" on user_login_sessions;

create policy "login_sessions_self_read"
  on user_login_sessions for select
  using (auth.uid() = user_id);

create policy "login_sessions_self_update"
  on user_login_sessions for update
  using (auth.uid() = user_id);

create policy "login_sessions_self_delete"
  on user_login_sessions for delete
  using (auth.uid() = user_id);

-- 신규 row insert는 service_role(서버 API)을 통해서만 가능 — 클라이언트가 임의로 만들 수 없음

-- ── 자동 정리 함수 (옵션) ─────────────────────────────────────────────
-- 90일 이상 last_seen_at이 없는 세션 자동 삭제
create or replace function cleanup_old_login_sessions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count int;
begin
  delete from user_login_sessions
    where last_seen_at < now() - interval '90 days'
       or (revoked = true and last_seen_at < now() - interval '7 days');
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function cleanup_old_login_sessions() from public, anon, authenticated;
grant execute on function cleanup_old_login_sessions() to service_role;

-- ── 완료 ───────────────────────────────────────────────────────────────
-- 사용 흐름:
-- 1) 사용자 로그인/세션 확인 시 → POST /api/auth/session-log → row upsert
-- 2) 설정 페이지에서 → GET /api/auth/session-log → 본인 기록 조회
-- 3) "종료" 버튼 → DELETE /api/auth/session-log?id=xxx → revoked=true
