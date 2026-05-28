-- ═══════════════════════════════════════════════════════════════════════
-- 004_exchange_connections.sql — 거래소 API 키 저장 (idempotent)
--
-- v10 추가 컬럼: api_key, perm_read, perm_trading, auto_trading_enabled, is_paper
-- 이미 v9에서 일부 컬럼이 만들어졌을 수 있으므로 IF NOT EXISTS로 안전하게 추가.
--
-- 실행: Supabase Dashboard → SQL Editor → 붙여넣기 → Run
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- ── 기본 테이블 ────────────────────────────────────────────────────────
create table if not exists exchange_connections (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  exchange_id         text        not null,
  label               text        not null default '',
  api_key             text        not null default '',
  api_key_masked      text        not null default '****',
  api_secret_enc      text        not null default '',
  api_passphrase_enc  text,
  has_withdrawal      boolean     not null default false,
  is_active           boolean     not null default true,
  last_tested_at      timestamptz,
  test_status         text,
  created_at          timestamptz not null default now(),
  unique (user_id, exchange_id)
);

-- ── v10 추가 컬럼 ──────────────────────────────────────────────────────
alter table exchange_connections add column if not exists api_key              text not null default '';
alter table exchange_connections add column if not exists perm_read            boolean not null default false;
alter table exchange_connections add column if not exists perm_trading         boolean not null default false;
alter table exchange_connections add column if not exists auto_trading_enabled boolean not null default false;
alter table exchange_connections add column if not exists is_paper             boolean not null default true;

-- ── 인덱스 ─────────────────────────────────────────────────────────────
create index if not exists idx_exchange_conn_user on exchange_connections(user_id);

-- ── RLS ───────────────────────────────────────────────────────────────
alter table exchange_connections enable row level security;

drop policy if exists "exchange_conn_self_read"   on exchange_connections;
drop policy if exists "exchange_conn_self_update" on exchange_connections;
drop policy if exists "exchange_conn_self_delete" on exchange_connections;

create policy "exchange_conn_self_read"
  on exchange_connections for select
  using (auth.uid() = user_id);

create policy "exchange_conn_self_update"
  on exchange_connections for update
  using (auth.uid() = user_id);

create policy "exchange_conn_self_delete"
  on exchange_connections for delete
  using (auth.uid() = user_id);

-- INSERT는 service_role을 통해서만 (서버 API가 암호화 후 insert)

-- ── 환경변수 (Vercel) ─────────────────────────────────────────────────
-- EXCHANGE_ENCRYPTION_KEY=<32 byte hex>
-- 생성:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
-- 미설정 시 SUPABASE_SERVICE_ROLE_KEY로 폴백 (lib/exchanges/crypto.ts 참고)
