-- ═══════════════════════════════════════════════════════════════════════
-- 006_admin_notices.sql — 관리자 공지 시스템 + 통계 뷰 (idempotent)
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── 공지 테이블 ──────────────────────────────────────────────
create table if not exists admin_notices (
  id            uuid          primary key default gen_random_uuid(),
  title         text          not null,
  body          text          not null,
  level         text          not null default 'info',  -- 'info' | 'warning' | 'critical'
  active        boolean       not null default true,
  show_to       text          not null default 'all',   -- 'all' | 'pro' | 'admin'
  starts_at     timestamptz   not null default now(),
  ends_at       timestamptz,
  created_by    uuid          references auth.users(id) on delete set null,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create index if not exists idx_admin_notices_active on admin_notices(active, starts_at desc);
create index if not exists idx_admin_notices_dates  on admin_notices(starts_at, ends_at) where active = true;

-- ── RLS ─────────────────────────────────────────────────────
alter table admin_notices enable row level security;

drop policy if exists "notices_read_active"  on admin_notices;
drop policy if exists "notices_admin_write"  on admin_notices;
drop policy if exists "notices_admin_update" on admin_notices;
drop policy if exists "notices_admin_delete" on admin_notices;

-- 모든 사용자: 활성 + 기간 내 공지만 읽기
create policy "notices_read_active" on admin_notices for select using (
  active = true
  and starts_at <= now()
  and (ends_at is null or ends_at >= now())
);
-- 관리자만 쓰기 (실제 검증은 API에서 더 함)
create policy "notices_admin_write"  on admin_notices for insert with check (
  exists (select 1 from profiles where id = auth.uid() and role in ('admin','founder'))
);
create policy "notices_admin_update" on admin_notices for update using (
  exists (select 1 from profiles where id = auth.uid() and role in ('admin','founder'))
);
create policy "notices_admin_delete" on admin_notices for delete using (
  exists (select 1 from profiles where id = auth.uid() and role in ('admin','founder'))
);


-- ── 푸시 구독 테이블 ──────────────────────────────────────────
create table if not exists push_subscriptions (
  endpoint    text          primary key,
  user_id     uuid          references auth.users(id) on delete cascade,
  keys        jsonb         not null default '{}'::jsonb,
  expiration  bigint,
  created_at  timestamptz   not null default now()
);

create index if not exists idx_push_subs_user on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

drop policy if exists "push_subs_self" on push_subscriptions;
-- 본인 구독만 (서버는 service_role로 우회)
create policy "push_subs_self" on push_subscriptions for all using (
  auth.uid() = user_id or user_id is null
);
