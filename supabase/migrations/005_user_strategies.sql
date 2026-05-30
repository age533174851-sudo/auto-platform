-- ═══════════════════════════════════════════════════════════════════════
-- 005_user_strategies.sql — 사용자 전략 클라우드 동기화 (idempotent)
--
-- localStorage가 기본 저장소.
-- 로그인 유저는 best-effort로 Supabase에 미러링.
-- 다른 기기에서 로그인 시 자동으로 가져올 수 있음.
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

create table if not exists user_strategies (
  id            text          primary key,            -- UserStrategy.id (UUID)
  user_id       uuid          not null references auth.users(id) on delete cascade,
  name          text          not null,
  asset         text          not null,
  market        text          not null,
  timeframe     text          not null,
  mode          text          not null default 'paper',
  action        text          not null default 'buy',
  conditions    jsonb         not null default '[]'::jsonb,
  order_spec    jsonb         not null default '{}'::jsonb,
  risk          jsonb         not null default '{}'::jsonb,
  enabled       boolean       not null default false,
  source        text          default 'manual',
  prompt        text,
  created_at    timestamptz   not null default now(),
  updated_at    timestamptz   not null default now()
);

create index if not exists idx_user_strategies_user on user_strategies(user_id);
create index if not exists idx_user_strategies_updated on user_strategies(user_id, updated_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────
alter table user_strategies enable row level security;

drop policy if exists "user_strategies_self_read"   on user_strategies;
drop policy if exists "user_strategies_self_write"  on user_strategies;
drop policy if exists "user_strategies_self_update" on user_strategies;
drop policy if exists "user_strategies_self_delete" on user_strategies;

create policy "user_strategies_self_read"   on user_strategies for select using (auth.uid() = user_id);
create policy "user_strategies_self_write"  on user_strategies for insert with check (auth.uid() = user_id);
create policy "user_strategies_self_update" on user_strategies for update using (auth.uid() = user_id);
create policy "user_strategies_self_delete" on user_strategies for delete using (auth.uid() = user_id);
