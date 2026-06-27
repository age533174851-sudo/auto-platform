-- ════════════════════════════════════════════════════════════════
-- TRAIGO Job Queue  (public.jobs)
-- Vercel = 명령 적재만 / Railway Worker = 유일 실행자
-- Supabase → SQL Editor 에 전체 붙여넣고 RUN (1회)
-- ════════════════════════════════════════════════════════════════

create table if not exists public.jobs (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid,
  connection_id text,
  exchange      text        default 'binance',
  mode          text,                                  -- TESTNET | LIVE
  action        text        not null,
  symbol        text,
  side          text,
  quantity      numeric,
  percent       numeric,
  payload       jsonb       default '{}'::jsonb,
  status        text        default 'PENDING',
  priority      integer     default 5,                 -- 낮을수록 먼저 (킬스위치=0)
  attempts      integer     default 0,
  max_attempts  integer     default 5,
  locked_by     text,
  locked_until  timestamptz,
  result        jsonb,
  error         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  completed_at  timestamptz,

  -- status / action 값 제약 (잘못된 값 방지)
  constraint jobs_status_chk check (status in ('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED')),
  constraint jobs_action_chk check (action in (
    'CLOSE_POSITION','CLOSE_ALL_POSITIONS','CANCEL_ALL_ORDERS',
    'PLACE_ORDER','SET_TPSL','REVERSE_POSITION','KILL_SWITCH_EXECUTE'
  ))
);

-- 인덱스: Worker가 PENDING을 priority/created_at 순으로 빠르게 조회
create index if not exists idx_jobs_pending on public.jobs (status, priority, created_at) where status = 'PENDING';
create index if not exists idx_jobs_conn    on public.jobs (connection_id, status);

-- RLS: 클라이언트는 본인 job만 조회(polling). 적재/실행은 service_role(Vercel·Worker)이 RLS 우회.
alter table public.jobs enable row level security;
drop policy if exists jobs_owner on public.jobs;
create policy jobs_owner on public.jobs
  for select using (auth.uid() = user_id);
