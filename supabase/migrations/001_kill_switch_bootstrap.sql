-- 001_kill_switch_bootstrap.sql
--
-- 번호 없는 `kill_switch.sql`이 지고 있던 canonical 책임을 번호 체계로 옮긴다.
--
-- 왜 001인가
-- ──────────
-- 054·057·066·073은 `worker_heartbeat`에, 067은 `kill_switch_state`에
-- ALTER를 건다. 022는 `worker_lock`·`worker_heartbeat`·`telegram_alert_log`·
-- `kill_switch_log` 넷에 RLS와 service 정책을 건다. 그 표들을 만드는 파일이
-- 번호 목록에 없어서, 번호만으로 빈 DB를 재생하면 그 다섯 개가 42P01로
-- 실패하고 022는 표가 없다며 조용히 건너뛴다. **표가 없는데 replay가
-- 0으로 끝나는 것이 가장 위험하다** — RLS가 안 걸린 채로 통과한다.
--
-- 그래서 이 파일은 022보다, 그리고 그 표를 건드리는 모든 번호보다 먼저
-- 실행돼야 한다. 001은 역사적으로 비어 있던 번호다.
--
-- production에서는 이 SQL이 실행되지 않는다
-- ─────────────────────────────────────────
-- 운영 DB에는 이 아홉 개가 이미 전부 있다(2026-08-31 read-only audit로
-- 카탈로그에서 확인). runner는 그것을 보고 실행 없이 BASELINE으로 채택한다.
-- 아래 `drop policy if exists`가 운영 정책을 지우는 일은 그래서 없다.
--
-- 의미를 바꾸지 않는다
-- ────────────────────
-- 이것은 canonicalization이다. legacy가 만들던 것과 **같은 것만** 만든다.
-- 022가 만드는 `*_service` 정책 네 개는 여기에 넣지 않는다 — 그것은 022의
-- 책임이고, 여기로 끌어오면 같은 판단이 두 곳에 생긴다.

-- `kill_switch_log`·`telegram_alert_log`의 기본값이 gen_random_uuid()다.
-- 빈 DB에서 앞 단계가 확장을 깔아 줬다고 가정하지 않는다.
create extension if not exists pgcrypto;

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
