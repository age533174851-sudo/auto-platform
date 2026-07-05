-- ════════════════════════════════════════════════════════════════
-- strategy_profiles — 전략 프로필 프리셋 (Scalp/Swing) DB 영속화
-- 지금은 앱 내부 config + localStorage로 동작하지만, 사용자별 커스텀
-- 프로필을 저장하려면 이 테이블 사용. Supabase SQL Editor에 실행.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.strategy_profiles (
  id                uuid default gen_random_uuid() primary key,
  user_id           uuid,
  strategy_type     text not null,          -- SCALP_HIGH_LEV | SWING_LOW_LEV
  label             text,
  leverage          numeric default 1,
  max_leverage      numeric default 5,
  margin_mode       text default 'isolated',-- isolated | cross
  max_portfolio_pct numeric default 10,
  risk_percent      numeric default 1,
  take_profit_pct   numeric default 1,
  stop_loss_pct     numeric default 0.5,
  order_type        text default 'limit',   -- post_only_limit | limit | market
  timeout_sec       integer default 0,
  daily_loss_limit_pct numeric default 5,
  max_hold_sec      integer default 0,
  max_open_positions integer default 3,
  enabled           boolean default true,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),

  constraint sp_type_chk  check (strategy_type in ('SCALP_HIGH_LEV','SWING_LOW_LEV')),
  constraint sp_margin_chk check (margin_mode in ('isolated','cross')),
  constraint sp_order_chk  check (order_type in ('post_only_limit','limit','market')),
  constraint sp_sl_chk     check (stop_loss_pct > 0)   -- 손절 필수 (0 금지)
);

create index if not exists idx_sp_user on public.strategy_profiles (user_id, strategy_type);

alter table public.strategy_profiles enable row level security;
drop policy if exists sp_owner on public.strategy_profiles;
create policy sp_owner on public.strategy_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
