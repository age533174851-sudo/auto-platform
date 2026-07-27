-- Daily MDD Kill Switch 테이블
-- Supabase SQL Editor에서 1회 실행

create table if not exists kill_switch_state (
  user_id            uuid        not null,
  connection_id      text        not null,
  enabled            boolean     default true,
  daily_limit_pct    numeric     default 5,
  weekly_limit_pct   numeric     default 10,
  monthly_limit_pct  numeric     default 20,
  abs_limit_usdt     numeric     default 0,      -- 0 = 미사용
  action_mode        text        default 'BC',   -- A신규차단 B봇정지 C주문취소 D포지션종료 조합
  active             boolean     default false,
  triggered_at       timestamptz,
  trigger_reason     text,
  daily_start_equity   numeric,  daily_start_at   timestamptz,
  weekly_start_equity  numeric,  weekly_start_at  timestamptz,
  monthly_start_equity numeric,  monthly_start_at timestamptz,
  updated_at         timestamptz default now(),
  primary key (user_id, connection_id)
);

-- webhook이 connection_id로 빠르게 active 확인하므로 인덱스
create index if not exists idx_kill_switch_conn on kill_switch_state (connection_id);

create table if not exists kill_switch_log (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid,
  connection_id text,
  at            timestamptz default now(),
  reason        text,
  equity        numeric,
  drawdown_pct  numeric,
  action        text,
  mode          text
);

-- RLS (서비스롤은 우회). 사용자 본인 행만 읽기 허용하려면:
alter table kill_switch_state enable row level security;
alter table kill_switch_log   enable row level security;

drop policy if exists ks_state_owner on kill_switch_state;
create policy ks_state_owner on kill_switch_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists ks_log_owner on kill_switch_log;
create policy ks_log_owner on kill_switch_log
  for select using (auth.uid() = user_id);

-- 텔레그램 알림 로그 (감사용 — 모든 이벤트 저장: sent/throttled/aggregated/escalated/failed)
create table if not exists telegram_alert_log (
  id               uuid        default gen_random_uuid() primary key,
  created_at       timestamptz default now(),
  severity         text,         -- critical | warning | info
  channel          text,         -- money | system
  event_type       text,
  exchange         text,
  symbol           text,
  dedup_key        text,
  message          text,
  sent             boolean default false,
  throttled        boolean default false,
  escalated        boolean default false,
  aggregated_count integer default 0,
  error            text
);
create index if not exists idx_tg_dedup on telegram_alert_log (dedup_key, created_at desc);

-- ── Railway Worker: heartbeat + lock ──────────────────────────
create table if not exists worker_heartbeat (
  worker_id    text primary key,
  last_seen    timestamptz default now(),
  status       text,            -- running | degraded | stopped
  current_task text,
  error_count  integer default 0,
  updated_at   timestamptz default now()
);

-- 분산 lock (중복 실행/Close All 이중 실행 방지). lease 방식: expires_at 지나면 탈취 가능
create table if not exists worker_lock (
  name        text primary key,   -- 'main' | 'ks:{connectionId}'
  holder      text,
  expires_at  timestamptz,
  acquired_at timestamptz default now()
);

