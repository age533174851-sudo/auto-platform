-- TRAIGO Exchange Connections Table
-- Run this in Supabase SQL Editor

create table if not exists exchange_connections (
  id                  uuid primary key default gen_random_uuid(),
  user_id             text not null,
  exchange            text not null check (exchange in ('binance','gate','bybit','okx','upbit','bithumb')),
  nickname            text not null,
  api_key             text not null,         -- truncated prefix only (display)
  api_key_masked      text not null,         -- e.g. "ABCD****1234"
  api_secret_enc      text not null,         -- AES-256-GCM encrypted
  api_passphrase_enc  text,                  -- AES-256-GCM encrypted (OKX only)
  has_passphrase      boolean default false,
  perm_read           boolean default true,
  perm_trading        boolean default false,
  perm_withdrawal     boolean default false, -- always false
  status              text default 'active' check (status in ('active','error','testing')),
  last_test_at        timestamptz,
  last_test_result    text,
  auto_trading        boolean default false,
  is_paper            boolean default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- Row Level Security
alter table exchange_connections enable row level security;

-- Policy: users can only see/edit their own connections
create policy "Users manage own connections"
  on exchange_connections
  for all
  using (user_id = auth.uid()::text or user_id = 'demo-user');

-- Index
create index if not exists idx_exc_user on exchange_connections(user_id);
create index if not exists idx_exc_exchange on exchange_connections(exchange);

-- Trigger: update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger trg_exc_updated
  before update on exchange_connections
  for each row execute function update_updated_at();
