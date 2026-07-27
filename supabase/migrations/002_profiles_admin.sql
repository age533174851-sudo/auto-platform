-- ═══════════════════════════════════════════════════════════════════════
-- 002_profiles_admin.sql — Profiles 테이블 + RLS + Auth 트리거 (idempotent)
--
-- 이 migration은 schema.sql과 schema_v2.sql이 이미 실행됐는지에 관계없이
-- 안전하게 다시 실행할 수 있도록 작성되었습니다.
--
-- 실행 방법:
--   Supabase Dashboard → SQL Editor → New Query →
--   이 파일 전체 붙여넣기 → Run
-- ═══════════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── 1. profiles 테이블 (없으면 생성) ───────────────────────────────────
create table if not exists profiles (
  id             uuid        primary key references auth.users(id) on delete cascade,
  email          text        unique not null,
  display_name   text,
  avatar_url     text,
  role           text        not null default 'user',
  plan           text        not null default 'free',
  status         text        not null default 'active',
  badges         text[]      not null default '{}',
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ── 2. role check (기존 컬럼에 안전하게 추가) ─────────────────────────
-- 이미 check가 있으면 무시
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'profiles' and constraint_name = 'profiles_role_check'
  ) then
    alter table profiles
      add constraint profiles_role_check
      check (role in ('user','vip','lifetime','founder','admin','developer','super_admin'));
  end if;
end $$;

-- ── 3. 가입 시 profiles 자동 생성 트리거 ──────────────────────────────
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'display_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── 4. updated_at 자동 갱신 트리거 ─────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- ── 5. RLS 활성화 ──────────────────────────────────────────────────────
alter table profiles enable row level security;

-- 기존 policy 안전하게 제거 후 재생성
drop policy if exists "profiles_self_read"    on profiles;
drop policy if exists "profiles_self_update"  on profiles;
drop policy if exists "profiles_admin_read"   on profiles;
drop policy if exists "profiles_admin_update" on profiles;
drop policy if exists "본인 프로필 읽기"      on profiles;
drop policy if exists "관리자 전체 프로필 읽기" on profiles;
drop policy if exists "본인 프로필 수정"      on profiles;
drop policy if exists "관리자 프로필 수정"    on profiles;

-- 본인은 자기 프로필 읽기/수정 가능 (role/plan/status 같은 권한 필드는 column policy로 별도 보호 권장)
create policy "profiles_self_read"
  on profiles for select
  using (auth.uid() = id);

create policy "profiles_self_update"
  on profiles for update
  using (auth.uid() = id);

-- 서비스 키 (server-side)는 RLS 우회. role은 절대 클라이언트가 수정 못 함.

-- ── 6. 인덱스 ──────────────────────────────────────────────────────────
create index if not exists idx_profiles_email on profiles(email);
create index if not exists idx_profiles_role  on profiles(role);

-- ── 7. ADMIN 부트스트랩 헬퍼 함수 ───────────────────────────────────────
-- 백엔드에서 ADMIN_EMAILS 환경변수를 기준으로 호출합니다.
-- 환경변수를 DB에서 직접 읽지는 않고, 서버 코드가 이메일 리스트를 인자로 전달합니다.
-- 안전: 이 함수는 SECURITY DEFINER로 실행되지만 서비스 키로만 호출됩니다.
create or replace function bootstrap_admin_by_email(p_email text)
returns table (id uuid, email text, role text)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 이미 admin/super_admin/developer면 그대로 둠
  update profiles
    set role = 'admin'
    where email = p_email
      and role not in ('admin','super_admin','developer');

  return query
    select p.id, p.email, p.role
    from profiles p
    where p.email = p_email;
end;
$$;

-- ── 8. 권한 ────────────────────────────────────────────────────────────
revoke all on function bootstrap_admin_by_email(text) from public, anon, authenticated;
-- service_role만 호출 가능
grant execute on function bootstrap_admin_by_email(text) to service_role;

-- ── 완료 ───────────────────────────────────────────────────────────────
-- 운영자 부트스트랩 방법:
-- 1) Vercel 환경변수 ADMIN_EMAILS=you@example.com 설정
-- 2) 해당 이메일로 가입 → handle_new_user 트리거가 profiles row 자동 생성 (role='user')
-- 3) 첫 로그인 시 백엔드의 ensureAdminFromEmails 헬퍼가 bootstrap_admin_by_email 호출
-- 4) 즉시 admin 권한 부여됨
--
-- 수동 부트스트랩 (Vercel 환경변수 없을 때):
--   update profiles set role = 'admin' where email = 'you@example.com';
