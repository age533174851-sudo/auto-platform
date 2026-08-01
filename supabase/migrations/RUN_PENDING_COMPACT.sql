CREATE TABLE IF NOT EXISTS econ_events (
  id              TEXT PRIMARY KEY,
  timestamp_utc   TIMESTAMPTZ NOT NULL,      -- UTC 필수. 로컬 시각 저장 금지.
  event           TEXT NOT NULL,
  impact          TEXT NOT NULL DEFAULT 'low',   -- low | medium | high
  country         TEXT,
  affected_assets TEXT[],
  actual          TEXT,
  forecast        TEXT,
  previous        TEXT,
  source          TEXT NOT NULL DEFAULT 'manual', -- api | manual
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS econ_events_time_idx   ON econ_events (timestamp_utc);
CREATE INDEX IF NOT EXISTS econ_events_impact_idx ON econ_events (impact, timestamp_utc)
  WHERE impact = 'high';
ALTER TABLE econ_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS econ_events_service ON econ_events;
CREATE POLICY econ_events_service ON econ_events FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS econ_events_read ON econ_events;
CREATE POLICY econ_events_read ON econ_events FOR SELECT TO authenticated USING (true);
create table if not exists public.ladder_cycles (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users(id) on delete cascade,
  strategy_id        text        not null default 'daily-ladder',
  cycle_number       int         not null default 1,
  current_tier_index int         not null default 0,
  strategy_capital   numeric     not null,
  realized_equity    numeric     not null,
  protected_profit   numeric     not null default 0,
  cycle_locked       boolean     not null default false,
  lock_reason        text,
  cycle_start_at     timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, strategy_id)
);
create index if not exists ladder_cycles_user_idx on public.ladder_cycles (user_id);
alter table public.ladder_cycles enable row level security;
drop policy if exists ladder_cycles_owner on public.ladder_cycles;
create policy ladder_cycles_owner
  on public.ladder_cycles for select
  using (user_id = auth.uid());
drop policy if exists ladder_cycles_service on public.ladder_cycles;
create policy ladder_cycles_service
  on public.ladder_cycles for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
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
ALTER TABLE live_orders
  ADD COLUMN IF NOT EXISTS pos_qty_before  NUMERIC,
  ADD COLUMN IF NOT EXISTS resolve_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_resolve_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS needs_attention  BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS live_orders_attention_idx
  ON live_orders (needs_attention, created_at DESC)
  WHERE needs_attention = TRUE;
create table if not exists news_articles (
  hash          text        primary key,           -- lib/news/schema contentHash
  title         text        not null,
  body          text        not null default '',
  url           text        not null,
  published_at  timestamptz not null,
  source        text        not null default '',
  provider      text        not null default '',   -- 어느 수집처에서 왔는가
  created_at    timestamptz not null default now(),
  analyzed_at    timestamptz,
  ai_provider    text,
  ai_model       text,
  title_ko       text,
  summary        text,
  direction      text,        -- bullish | neutral | bearish | uncertain
  confidence     int,         -- 0~100
  horizon        text,
  reasons        jsonb,
  risks          jsonb,
  affected_assets jsonb,
  repaired       jsonb,
  analysis_attempts int not null default 0,
  analysis_error    text,
  last_attempt_at   timestamptz
);
create index if not exists news_articles_published_idx
  on news_articles (published_at desc);
create index if not exists news_articles_unanalyzed_idx
  on news_articles (analyzed_at) where analyzed_at is null;
alter table news_articles enable row level security;
drop policy if exists news_articles_read on news_articles;
create policy news_articles_read on news_articles
  for select using (true);
alter table ai_usage add column if not exists provider    text;
alter table ai_usage add column if not exists model       text;
alter table ai_usage add column if not exists latency_ms  int;
alter table ai_usage add column if not exists ok          boolean;
alter table ai_usage add column if not exists error_text  text;
create index if not exists ai_usage_provider_created_idx
  on ai_usage (provider, created_at desc);
create index if not exists ai_usage_errors_idx
  on ai_usage (created_at desc) where ok = false;
CREATE TABLE IF NOT EXISTS ai_predictions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID,
  symbol         TEXT NOT NULL,
  source         TEXT NOT NULL,              -- 'consensus' | 'openai' | 'anthropic' | …
  direction      TEXT,                       -- bullish | bearish | neutral | uncertain
  confidence     NUMERIC,                    -- 0~100. 모르면 NULL (0이 아니다)
  level          TEXT,                       -- UNANIMOUS | MAJORITY | SPLIT | INSUFFICIENT
  responded      INT,                        -- 실제로 답한 공급자 수
  asked          INT,                        -- 물어본 공급자 수
  reasons        JSONB,                      -- 근거. 나중에 왜 틀렸는지 되짚는 데 쓴다
  applied        TEXT,
  side           TEXT,                       -- 그때 하려던 방향 LONG | SHORT
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_price    NUMERIC,                    -- 판단 시점 가격 — 정답지의 기준
  horizon_min    INT,                        -- 몇 분 뒤로 채점할 것인가
  outcome        TEXT,                       -- bullish | bearish | neutral. 모르면 NULL
  outcome_price  NUMERIC,
  scored_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_pred_symbol_idx
  ON ai_predictions (user_id, symbol, decided_at DESC);
CREATE INDEX IF NOT EXISTS ai_pred_unscored_idx
  ON ai_predictions (decided_at) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS ai_pred_scored_idx
  ON ai_predictions (user_id, decided_at DESC) WHERE outcome IS NOT NULL;
ALTER TABLE ai_predictions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_pred_service ON ai_predictions;
CREATE POLICY ai_pred_service ON ai_predictions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS ai_pred_owner ON ai_predictions;
CREATE POLICY ai_pred_owner ON ai_predictions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TABLE IF NOT EXISTS sub_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  name           TEXT NOT NULL,                 -- '성장' · '안정' · '실험'
  allocated_usd  NUMERIC,                       -- NULL = 미설정 (0과 다르다)
  markets         TEXT[],                       -- {'SPOT','USDM','COINM'}
  symbol_prefixes TEXT[],                       -- {'BTC','ETH'}
  note           TEXT,
  sort_order     INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sub_acct_user_idx
  ON sub_accounts (user_id, sort_order, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS sub_acct_name_uniq
  ON sub_accounts (user_id, name);
ALTER TABLE sub_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sub_acct_service ON sub_accounts;
CREATE POLICY sub_acct_service ON sub_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sub_acct_owner ON sub_accounts;
CREATE POLICY sub_acct_owner ON sub_accounts
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'USDM';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'paper_pos_market_chk'
  ) THEN
    ALTER TABLE paper_positions
      ADD CONSTRAINT paper_pos_market_chk CHECK (market IN ('SPOT', 'USDM', 'COINM'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS paper_pos_market_idx
  ON paper_positions (user_id, market, status);

CREATE TABLE IF NOT EXISTS safety_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID,
  kind         TEXT NOT NULL,
  label        TEXT,
  status       TEXT NOT NULL,
  market       TEXT,
  symbol       TEXT,
  reason       TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS safety_events_user_kind_idx
  ON safety_events (user_id, kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS safety_events_recent_idx
  ON safety_events (occurred_at DESC);
ALTER TABLE safety_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS safety_events_service ON safety_events;
CREATE POLICY safety_events_service ON safety_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS safety_events_owner ON safety_events;
CREATE POLICY safety_events_owner ON safety_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

ALTER TABLE econ_events
  ADD COLUMN IF NOT EXISTS time_known BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS econ_events_dayonly_idx
  ON econ_events (timestamp_utc) WHERE time_known = FALSE;
