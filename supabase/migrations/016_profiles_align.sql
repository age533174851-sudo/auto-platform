-- ═══════════════════════════════════════════════════════════════════════
-- 016_profiles_align.sql
-- profiles를 코드가 기대하는 컬럼 세트로 정렬 + invite_codes 생성
--
-- 배경
-- ────
-- schema.sql, schema_v2.sql, 002_profiles_admin.sql 세 파일이 모두
-- profiles를 `create table if not exists`로 정의한다. 그런데 실제 DB에는
-- 이미 다른 모양의 profiles(name, default_currency, risk_profile ...)가
-- 있었기 때문에 세 CREATE가 전부 통째로 건너뛰어졌다.
-- `create table if not exists`는 테이블이 있으면 컬럼 차이를 메우지 않는다.
--
-- 그 결과 display_name / plan / status / badges / expires_at /
-- granted_by / invite_code가 하나도 만들어지지 않았고, 코드가 이 컬럼을
-- 읽거나 쓰면 PostgREST가 요청 전체를 거부했다. 프로필 이름 변경,
-- 등급(VIP·평생회원·창업멤버), 초대 코드가 조용히 실패하고 있었다.
--
-- 이 마이그레이션은 add column if not exists로 부족분만 채운다.
-- 기존 컬럼(name, default_currency, risk_profile)은 건드리지 않는다 —
-- 다른 코드가 참조할 수 있으므로 제거는 별도 판단.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. 누락 컬럼 추가 ──────────────────────────────────────────────────
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists plan         text        not null default 'free';
alter table public.profiles add column if not exists status       text        not null default 'active';
alter table public.profiles add column if not exists badges       text[]      not null default '{}';
alter table public.profiles add column if not exists expires_at   timestamptz;
alter table public.profiles add column if not exists granted_by   uuid;
alter table public.profiles add column if not exists invite_code  text;

-- ── 2. 기존 name 값을 display_name으로 이관 ───────────────────────────
-- name은 남겨 둔다. 두 컬럼이 공존하는 동안 display_name이 정본이다.
update public.profiles
   set display_name = name
 where display_name is null
   and name is not null;

-- ── 3. 제약 조건 (이미 있으면 건너뜀) ─────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'profiles'
       and constraint_name = 'profiles_plan_check'
  ) then
    alter table public.profiles add constraint profiles_plan_check
      check (plan in ('free','pro','premium','lifetime','founder','admin'));
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'profiles'
       and constraint_name = 'profiles_status_check'
  ) then
    alter table public.profiles add constraint profiles_status_check
      check (status in ('active','banned','suspended','pending'));
  end if;

  -- profiles_role_check는 이미 존재한다 (테이블 최초 생성 시 부여됨).
  if not exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'profiles'
       and constraint_name = 'profiles_granted_by_fkey'
  ) then
    alter table public.profiles add constraint profiles_granted_by_fkey
      foreign key (granted_by) references public.profiles(id);
  end if;
end $$;

-- ── 4. invite_codes ───────────────────────────────────────────────────
-- src/lib/supabase.ts의 adminGetCodes / adminCreateCode / adminToggleCode가
-- 이 테이블을 쓰는데 실제 DB에 없었다.
create table if not exists public.invite_codes (
  id          uuid        primary key default gen_random_uuid(),
  code        text        unique not null,
  plan        text        not null default 'pro'
                            check (plan in ('free','pro','premium','lifetime','founder','admin')),
  role        text        not null default 'user'
                            check (role in ('user','vip','lifetime','founder','admin','developer','super_admin')),
  uses_max    int,          -- null = 무제한
  uses_count  int         not null default 0,
  active      boolean     not null default true,
  created_by  uuid        references public.profiles(id),
  expires_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now()
);

alter table public.invite_codes enable row level security;

drop policy if exists "invite_codes_admin_all" on public.invite_codes;
create policy "invite_codes_admin_all"
  on public.invite_codes for all
  using (
    exists (
      select 1 from public.profiles
       where id = auth.uid()
         and role in ('admin','developer','super_admin')
    )
  );

-- 주의: schema.sql에는 `using (active = true)`로 누구나 SELECT할 수 있는
-- "활성 코드 조회 (리딤용)" 정책이 있었다. 그 정책은 로그인만 하면(또는
-- anon 키만 있으면) 활성 초대 코드 전체를 읽을 수 있게 한다. 코드 하나가
-- founder/developer 등급을 주는 구조라 그대로 옮기지 않았다.
-- 코드 리딤은 service_role로 동작하는 서버 라우트에서 처리해야 한다.

-- 시드 코드는 넣지 않는다. README에 공개된 값(FOUNDER-2026,
-- DEV-ACCESS-2025 등)이라 실제 DB에 넣으면 문서를 읽은 누구나
-- 상위 등급을 받을 수 있다. 필요하면 관리자 화면에서 직접 생성할 것.
