-- ═══════════════════════════════════════════════════════════════════════
-- 017_ladder_cycles.sql
-- 계단식 사이클 상태 + 하루 1회 거래 강제
--
-- 배경
-- ────
-- ladderSizing.ts(계단 판정)와 dailyBattle.ts(5v5 판정)는 작성돼 있지만
-- 상태를 저장할 곳이 없어 백테스트에서만 돌았다. 실주문에 쓰려면
--   1) 사이클 상태(현재 단계·전략자본·보호수익·잠금)가 재시작 후에도 남고
--   2) "하루 최대 1회"가 프로세스 재시작·동시 요청에도 깨지지 않아야 한다.
--
-- 왜 daily_slot_days를 재사용하지 않는가
-- ──────────────────────────────────────
-- 그 테이블은 "하루 10슬롯 순차 사용" 해석으로 만들어졌다.
-- slotManager.ts 상단에도 그 해석은 폐기됐고 신규 배선에 쓰지 말라고
-- 적혀 있다. 두 모델을 한 테이블에 섞으면 어느 쪽이 진실인지 알 수 없다.
--
-- 하루 1회를 코드가 아니라 제약으로 거는 이유
-- ────────────────────────────────────────
-- "오늘 거래했나?"를 select로 확인하고 insert하면, 웹훅 두 건이 동시에
-- 들어올 때 둘 다 통과한다. unique 제약이 있으면 두 번째 insert가
-- 23505로 실패하므로 경쟁 조건에서도 하루 1회가 성립한다.
-- (webhook/signal이 signals.signal_id에 쓰는 멱등 방식과 같다)
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. 사이클 상태 ─────────────────────────────────────────────────────
create table if not exists public.ladder_cycles (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users(id) on delete cascade,
  strategy_id        text        not null default 'daily-ladder',

  cycle_number       int         not null default 1,
  current_tier_index int         not null default 0,

  -- 이 전략에 배정된 자본. 계좌 전체 자산이 아니다.
  strategy_capital   numeric     not null,
  -- 확정 잔고 (미실현 제외) — 계단 판정의 기준
  realized_equity    numeric     not null,
  -- 사이클 완료로 빼놓은 수익 누적
  protected_profit   numeric     not null default 0,

  cycle_locked       boolean     not null default false,
  lock_reason        text,

  cycle_start_at     timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 사용자·전략당 활성 사이클은 하나
  unique (user_id, strategy_id)
);

create index if not exists ladder_cycles_user_idx on public.ladder_cycles (user_id);

alter table public.ladder_cycles enable row level security;

drop policy if exists ladder_cycles_owner on public.ladder_cycles;
create policy ladder_cycles_owner
  on public.ladder_cycles for select
  using (user_id = auth.uid());

-- 쓰기는 service_role(서버)만. 클라이언트가 전략자본을 고칠 수 있으면
-- 증거금 상한이 의미를 잃는다.
drop policy if exists ladder_cycles_service on public.ladder_cycles;
create policy ladder_cycles_service
  on public.ladder_cycles for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── 2. 하루 1회 거래 기록 ──────────────────────────────────────────────
create table if not exists public.ladder_daily_trades (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  strategy_id      text        not null default 'daily-ladder',
  trade_date       date        not null,

  cycle_id         uuid        references public.ladder_cycles(id) on delete set null,
  cycle_number     int,
  tier_index       int,
  allocated_margin numeric,

  signal_id        text,
  symbol           text,
  side             text,
  leverage         int,
  entry_price      numeric,
  stop_loss        numeric,
  take_profit      numeric,
  liquidation_price numeric,

  status           text        not null default 'OPEN',
  exit_price       numeric,
  exit_reason      text,
  realized_pnl     numeric,
  closed_at        timestamptz,
  created_at       timestamptz not null default now(),

  -- 핵심 제약: 하루 1회
  unique (user_id, strategy_id, trade_date)
);

create index if not exists ladder_daily_trades_user_date_idx
  on public.ladder_daily_trades (user_id, trade_date desc);

alter table public.ladder_daily_trades enable row level security;

drop policy if exists ladder_daily_trades_owner on public.ladder_daily_trades;
create policy ladder_daily_trades_owner
  on public.ladder_daily_trades for select
  using (user_id = auth.uid());

drop policy if exists ladder_daily_trades_service on public.ladder_daily_trades;
create policy ladder_daily_trades_service
  on public.ladder_daily_trades for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── 3. updated_at 자동 갱신 ────────────────────────────────────────────
create or replace function public.touch_ladder_cycles()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ladder_cycles_touch on public.ladder_cycles;
create trigger ladder_cycles_touch
  before update on public.ladder_cycles
  for each row execute function public.touch_ladder_cycles();
