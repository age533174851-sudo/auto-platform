-- ═══════════════════════════════════════════════════════════════════════
-- TRAIGO — Supabase SQL Schema v2.0
-- 실행: Supabase Dashboard → SQL Editor → 전체 붙여넣기 → Run
-- 기존 스키마가 있으면 이 파일은 새 테이블/컬럼만 추가 (idempotent)
-- ═══════════════════════════════════════════════════════════════════════

-- ── Extensions ──────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";
create extension if not exists "pg_net";    -- async HTTP (optional)

-- ── updated_at 자동 갱신 trigger ────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- ════════════════════════════════════════════════════════════════════════
-- 1. PROFILES  (auth.users 확장)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists profiles (
  id             uuid        primary key references auth.users(id) on delete cascade,
  email          text        unique not null,
  display_name   text,
  avatar_url     text,
  role           text        not null default 'user'
                               check (role in ('user','vip','lifetime','founder','admin','developer','super_admin')),
  plan           text        not null default 'free'
                               check (plan in ('free','pro','premium','lifetime','founder','admin')),
  status         text        not null default 'active'
                               check (status in ('active','banned','suspended','pending')),
  badges         text[]      not null default '{}',
  expires_at     timestamptz,
  granted_by     uuid        references profiles(id),
  invite_code    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_profiles_updated') then
    create trigger trg_profiles_updated
      before update on profiles
      for each row execute function set_updated_at();
  end if;
end $$;

-- 회원가입 시 profiles 자동 생성
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end; $$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

alter table profiles enable row level security;
drop policy if exists "profiles_select_own" on profiles;
drop policy if exists "profiles_update_own" on profiles;
drop policy if exists "profiles_service_role_all" on profiles;

create policy "profiles_select_own"       on profiles for select using (auth.uid() = id);
create policy "profiles_update_own"       on profiles for update using (auth.uid() = id);
create policy "profiles_service_role_all" on profiles for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 2. WATCHLISTS
-- ════════════════════════════════════════════════════════════════════════
create table if not exists watchlists (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references profiles(id) on delete cascade,
  symbol         text        not null,    -- unique asset ID (BTC, NVDA, 005930 …)
  name_kr        text        not null,
  symbol_ticker  text        not null,
  color          text        not null default '#3B82F6',
  category       text        not null default 'coin',
  exchange       text        not null default 'BINANCE',
  tv_symbol      text,                    -- TradingView symbol string
  added_at       timestamptz not null default now(),
  unique (user_id, symbol)
);

alter table watchlists enable row level security;
drop policy if exists "watchlists_own" on watchlists;
drop policy if exists "watchlists_service_role_all" on watchlists;

create policy "watchlists_own"            on watchlists for all using (auth.uid() = user_id);
create policy "watchlists_service_role_all" on watchlists for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 3. PORTFOLIOS
-- ════════════════════════════════════════════════════════════════════════
create table if not exists portfolios (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references profiles(id) on delete cascade,
  name           text        not null default '',
  type           text        not null default 'long'
                               check (type in ('long','short','cash','dca','etf','spot')),
  asset_id       text        not null,
  name_kr        text        not null,
  symbol         text        not null,
  color          text        not null default '#3B82F6',
  avg_price      numeric     not null default 0,
  quantity       numeric     not null default 0,
  invested       numeric     not null default 0,
  target_price   numeric     not null default 0,
  stop_price     numeric     not null default 0,
  leverage       integer     not null default 1,
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_portfolios_updated') then
    create trigger trg_portfolios_updated
      before update on portfolios
      for each row execute function set_updated_at();
  end if;
end $$;

alter table portfolios enable row level security;
drop policy if exists "portfolios_own" on portfolios;
drop policy if exists "portfolios_service_role_all" on portfolios;

create policy "portfolios_own"            on portfolios for all using (auth.uid() = user_id);
create policy "portfolios_service_role_all" on portfolios for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 4. TRADING STRATEGIES
-- ════════════════════════════════════════════════════════════════════════
create table if not exists trading_strategies (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references profiles(id) on delete cascade,
  name             text        not null,
  type             text        not null default 'ema_cross',
  asset            text        not null default 'BTC',
  asset_name_kr    text        not null default '비트코인',
  timeframe        text        not null default '4h',
  leverage         integer     not null default 1,
  max_leverage     integer     not null default 10,
  risk_level       text        not null default 'medium'
                                 check (risk_level in ('low','medium','high')),
  tp               numeric     not null default 5,
  sl               numeric     not null default 2.5,
  enabled          boolean     not null default false,
  status           text        not null default 'stopped'
                                 check (status in ('running','paused','stopped','error')),
  win_rate         numeric     not null default 0,
  total_pnl        numeric     not null default 0,
  trades           integer     not null default 0,
  max_daily_loss   numeric     not null default 500000,
  max_position_size numeric    not null default 3000000,
  cooldown_min     integer     not null default 60,
  params           jsonb       not null default '{}',
  description      text,
  exec_mode        text        not null default 'paper'
                                 check (exec_mode in ('paper','simulated','real')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_strategies_updated') then
    create trigger trg_strategies_updated
      before update on trading_strategies
      for each row execute function set_updated_at();
  end if;
end $$;

alter table trading_strategies enable row level security;
drop policy if exists "strategies_own" on trading_strategies;
drop policy if exists "strategies_service_role_all" on trading_strategies;

create policy "strategies_own"              on trading_strategies for all using (auth.uid() = user_id);
create policy "strategies_service_role_all" on trading_strategies for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 5. EXCHANGE CONNECTIONS
-- SECURITY: api_secret_enc NEVER returned to client via RLS
-- ════════════════════════════════════════════════════════════════════════
create table if not exists exchange_connections (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references profiles(id) on delete cascade,
  exchange_id      text        not null,
  label            text,
  api_key_masked   text        not null,    -- e.g. "AbCd...XyZ1"
  api_secret_enc   text        not null,    -- AES-256-GCM encrypted blob — server only
  has_withdrawal   boolean     not null default false,
  is_active        boolean     not null default true,
  last_tested_at   timestamptz,
  test_status      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, exchange_id)
);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_exchange_updated') then
    create trigger trg_exchange_updated
      before update on exchange_connections
      for each row execute function set_updated_at();
  end if;
end $$;

alter table exchange_connections enable row level security;
drop policy if exists "exchange_select_safe" on exchange_connections;
drop policy if exists "exchange_insert_own" on exchange_connections;
drop policy if exists "exchange_update_own" on exchange_connections;
drop policy if exists "exchange_delete_own" on exchange_connections;
drop policy if exists "exchange_service_role_all" on exchange_connections;

-- Client can read everything EXCEPT api_secret_enc (handled by view below)
create policy "exchange_select_safe"     on exchange_connections for select using (auth.uid() = user_id);
create policy "exchange_insert_own"      on exchange_connections for insert with check (auth.uid() = user_id);
create policy "exchange_update_own"      on exchange_connections for update using (auth.uid() = user_id);
create policy "exchange_delete_own"      on exchange_connections for delete using (auth.uid() = user_id);
create policy "exchange_service_role_all" on exchange_connections for all using (auth.role() = 'service_role');

-- Safe view that strips the encrypted secret
create or replace view exchange_connections_safe as
  select
    id, user_id, exchange_id, label,
    api_key_masked, has_withdrawal, is_active,
    last_tested_at, test_status, created_at
  from exchange_connections;

-- ════════════════════════════════════════════════════════════════════════
-- 6. TRADE ORDERS
-- ════════════════════════════════════════════════════════════════════════
create table if not exists trade_orders (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references profiles(id) on delete cascade,
  exchange_id    text,
  symbol         text        not null,
  name_kr        text        not null,
  side           text        not null check (side in ('buy','sell')),
  price          numeric     not null default 0,
  quantity       numeric     not null default 0,
  amount         numeric     not null default 0,
  leverage       integer     not null default 1,
  fee            numeric     not null default 0,
  slippage       numeric     not null default 0,
  status         text        not null default 'filled'
                               check (status in ('pending','filled','cancelled','failed')),
  pnl            numeric     not null default 0,
  pnl_pct        numeric     not null default 0,
  mode           text        not null default 'paper'
                               check (mode in ('paper','simulated','real')),
  note           text,
  emotion        text,
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz
);

alter table trade_orders enable row level security;
drop policy if exists "orders_own" on trade_orders;
drop policy if exists "orders_service_role_all" on trade_orders;

create policy "orders_own"              on trade_orders for all using (auth.uid() = user_id);
create policy "orders_service_role_all" on trade_orders for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 7. PNL REPORTS
-- ════════════════════════════════════════════════════════════════════════
create table if not exists pnl_reports (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references profiles(id) on delete cascade,
  period         text        not null,     -- 'YYYY-MM'
  realized_pnl   numeric     not null default 0,
  unrealized_pnl numeric     not null default 0,
  total_fee      numeric     not null default 0,
  trade_count    integer     not null default 0,
  win_count      integer     not null default 0,
  loss_count     integer     not null default 0,
  win_rate       numeric     not null default 0,
  best_trade     numeric     not null default 0,
  worst_trade    numeric     not null default 0,
  tax_estimate   numeric     not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, period)
);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_pnl_updated') then
    create trigger trg_pnl_updated
      before update on pnl_reports
      for each row execute function set_updated_at();
  end if;
end $$;

alter table pnl_reports enable row level security;
drop policy if exists "pnl_own" on pnl_reports;
drop policy if exists "pnl_service_role_all" on pnl_reports;

create policy "pnl_own"              on pnl_reports for all using (auth.uid() = user_id);
create policy "pnl_service_role_all" on pnl_reports for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 8. ALERTS
-- ════════════════════════════════════════════════════════════════════════
create table if not exists alerts (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references profiles(id) on delete cascade,
  asset_id       text        not null,
  name_kr        text        not null,
  condition      text        not null check (condition in ('above','below')),
  value          numeric     not null,
  active         boolean     not null default true,
  triggered_at   timestamptz,
  created_at     timestamptz not null default now()
);

alter table alerts enable row level security;
drop policy if exists "alerts_own" on alerts;
drop policy if exists "alerts_service_role_all" on alerts;

create policy "alerts_own"              on alerts for all using (auth.uid() = user_id);
create policy "alerts_service_role_all" on alerts for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 9. AUDIT LOGS (append-only, no user updates)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists audit_logs (
  id             uuid        primary key default gen_random_uuid(),
  actor_id       uuid        references profiles(id) on delete set null,
  action         text        not null,
  target_id      uuid,
  resource       text,
  details        jsonb,
  result         text,
  created_at     timestamptz not null default now()
);

alter table audit_logs enable row level security;
drop policy if exists "audit_insert_own" on audit_logs;
drop policy if exists "audit_select_own" on audit_logs;
drop policy if exists "audit_service_role_all" on audit_logs;

-- Users can insert their own audit events; can read their own logs
create policy "audit_insert_own"       on audit_logs for insert with check (auth.uid() = actor_id);
create policy "audit_select_own"       on audit_logs for select using (auth.uid() = actor_id);
create policy "audit_service_role_all" on audit_logs for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 10. BACKTEST RESULTS
-- ════════════════════════════════════════════════════════════════════════
create table if not exists backtest_results (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references profiles(id) on delete cascade,
  strategy_id    uuid        references trading_strategies(id) on delete set null,
  strategy_name  text        not null,
  asset          text        not null,
  timeframe      text        not null,
  start_date     date        not null,
  end_date       date        not null,
  total_trades   integer     not null default 0,
  win_rate       numeric     not null default 0,
  total_pnl      numeric     not null default 0,
  max_drawdown   numeric     not null default 0,
  sharpe_ratio   numeric,
  params         jsonb       not null default '{}',
  equity_curve   jsonb       not null default '[]',
  created_at     timestamptz not null default now()
);

alter table backtest_results enable row level security;
drop policy if exists "backtest_own" on backtest_results;
drop policy if exists "backtest_service_role_all" on backtest_results;

create policy "backtest_own"              on backtest_results for all using (auth.uid() = user_id);
create policy "backtest_service_role_all" on backtest_results for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- INVITE CODES  (pre-existing, kept for compatibility)
-- ════════════════════════════════════════════════════════════════════════
create table if not exists invite_codes (
  id         uuid        primary key default gen_random_uuid(),
  code       text        unique not null,
  plan       text        not null,
  role       text        not null,
  uses_max   integer,
  uses_count integer     not null default 0,
  active     boolean     not null default true,
  note       text        not null default '',
  created_by uuid        references profiles(id),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table invite_codes enable row level security;
drop policy if exists "codes_admin_all" on invite_codes;
drop policy if exists "codes_service_role_all" on invite_codes;

create policy "codes_admin_all"       on invite_codes for all using (
  exists (select 1 from profiles where id = auth.uid() and role in ('admin','developer','super_admin'))
);
create policy "codes_service_role_all" on invite_codes for all using (auth.role() = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- FUNCTIONS: invite code redemption
-- ════════════════════════════════════════════════════════════════════════
create or replace function redeem_invite_code(p_code text, p_user_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  v_code invite_codes;
begin
  select * into v_code from invite_codes
  where upper(code) = upper(p_code)
    and active = true
    and (uses_max is null or uses_count < uses_max)
    and (expires_at is null or expires_at > now())
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', '유효하지 않거나 만료된 코드입니다.');
  end if;

  update profiles set
    plan = v_code.plan, role = v_code.role,
    expires_at = case when v_code.plan in ('lifetime','founder') then null
                      else now() + interval '365 days' end,
    updated_at = now()
  where id = p_user_id;

  update invite_codes set uses_count = uses_count + 1 where id = v_code.id;

  return jsonb_build_object('success', true, 'plan', v_code.plan, 'role', v_code.role);
end; $$;

-- ════════════════════════════════════════════════════════════════════════
-- INDEXES for performance
-- ════════════════════════════════════════════════════════════════════════
create index if not exists idx_watchlists_user     on watchlists (user_id);
create index if not exists idx_portfolios_user     on portfolios (user_id);
create index if not exists idx_strategies_user     on trading_strategies (user_id);
create index if not exists idx_exchange_user       on exchange_connections (user_id);
create index if not exists idx_orders_user         on trade_orders (user_id);
create index if not exists idx_orders_opened       on trade_orders (user_id, opened_at desc);
create index if not exists idx_pnl_user_period     on pnl_reports (user_id, period);
create index if not exists idx_alerts_user         on alerts (user_id);
create index if not exists idx_audit_actor         on audit_logs (actor_id, created_at desc);
create index if not exists idx_backtest_user       on backtest_results (user_id);
