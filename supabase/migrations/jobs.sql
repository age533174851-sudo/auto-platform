-- ── Job Queue: Vercel은 명령 적재만, Railway Worker가 유일 실행자 ──
-- Supabase SQL Editor에서 1회 실행
create table if not exists jobs (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid,
  connection_id text,
  exchange      text default 'binance',
  mode          text,                  -- TESTNET | LIVE
  action        text,                  -- CLOSE_POSITION | CLOSE_ALL_POSITIONS | CANCEL_ALL_ORDERS | PLACE_ORDER | SET_TPSL | REVERSE_POSITION | KILL_SWITCH_EXECUTE
  symbol        text,
  side          text,
  quantity      numeric,
  percent       numeric,
  payload       jsonb default '{}'::jsonb,
  status        text default 'PENDING', -- PENDING | PROCESSING | COMPLETED | FAILED | CANCELLED
  priority      integer default 5,      -- 낮을수록 먼저 (킬스위치=0)
  attempts      integer default 0,
  max_attempts  integer default 5,
  locked_by     text,
  locked_until  timestamptz,
  result        jsonb,
  error         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  completed_at  timestamptz
);
create index if not exists idx_jobs_pending on jobs (status, priority, created_at) where status = 'PENDING';
create index if not exists idx_jobs_conn on jobs (connection_id, status);

alter table jobs enable row level security;
drop policy if exists jobs_owner on jobs;
create policy jobs_owner on jobs for select using (auth.uid() = user_id);
