-- ═══════════════════════════════════════════════════════════════
-- TRAIGO — 아직 적용하지 않은 마이그레이션 모음
--
-- Supabase 대시보드 → SQL Editor에 **통째로 붙여넣고 Run** 하면 됩니다.
--
-- 여러 번 실행해도 안전합니다
-- ───────────────────────────
-- 모든 문장이 IF NOT EXISTS / DROP ... IF EXISTS로 되어 있어, 이미 있는
-- 표는 건드리지 않고 없는 것만 만듭니다. 중간에 한 번 실패해서 다시
-- 돌려도 앞부분이 두 번 만들어지지 않습니다.
--
-- 원본은 supabase/migrations/ 아래 각 파일입니다. 이 파일은 그것들을
-- 순서대로 이어 붙인 것이고, 정책(policy)만 재실행 가능하도록
-- DROP POLICY IF EXISTS를 앞에 붙였습니다.
-- ═══════════════════════════════════════════════════════════════


-- ─── supabase/migrations/015_econ_events.sql ───────────────────────────────────
-- 015_econ_events.sql
-- 경제 캘린더 (Risk Veto가 사용하는 실제 일정).
--
-- 왜 필요한가: 정적 ECON_EVENTS는 연도가 없고 시간대가 정의되지 않아
-- 실제 발표 시각과 최대 9시간, 최대 1년까지 어긋난다.
-- 100배 레버리지에서 FOMC 회피가 어긋나면 Veto가 없는 것과 같다.
--
-- 이 테이블은 UTC 타임스탬프만 저장한다.

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

-- ─── supabase/migrations/017_ladder_cycles.sql ───────────────────────────────────
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

-- ─── supabase/migrations/018_live_orders_recovery.sql ───────────────────────────────────
-- 018_live_orders_recovery.sql
-- UNKNOWN 주문을 거래소 조회로 확정하기 위한 근거 컬럼.
--
-- 왜 필요한가
-- ───────────
-- 기존 대조 로직은 "거래소에 주문이 안 보이면 전송되지 않은 것"으로 즉시
-- 확정했다. 그런데 거래소가 아직 반영하지 못했거나 조회가 실패했을 수도
-- 있다. 그 상태에서 FAILED로 찍으면 재시도가 열리고, 그 재시도가 그대로
-- 중복 체결이 된다.
--
-- 확정하려면 두 가지가 더 필요하다:
--   1) 전송 후 얼마나 지났는가        → sent_at (이미 있음)
--   2) 그 사이 포지션이 변했는가      → pos_qty_before (여기서 추가)
-- 주문이 안 보이는데 포지션이 변했다면 모순이므로 자동 확정하면 안 된다.

ALTER TABLE live_orders
  -- 주문 전송 직전에 읽은 해당 심볼의 포지션 수량 (부호 있음).
  -- 조회에 실패하면 NULL — 그 경우 교차 확인 없이 판단한다는 뜻이므로
  -- 확정 사유 문구에도 그 사실이 남는다.
  ADD COLUMN IF NOT EXISTS pos_qty_before  NUMERIC,
  -- 자동 조회를 몇 번 시도했는가. 일정 횟수를 넘으면 사람에게 넘긴다.
  ADD COLUMN IF NOT EXISTS resolve_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_resolve_at  TIMESTAMPTZ,
  -- 자동 확정이 불가능하다고 판단된 주문. 화면에서 눈에 띄게 띄워야 한다.
  ADD COLUMN IF NOT EXISTS needs_attention  BOOLEAN NOT NULL DEFAULT FALSE;

-- 사람 확인이 필요한 주문을 빠르게 찾기 위한 인덱스
CREATE INDEX IF NOT EXISTS live_orders_attention_idx
  ON live_orders (needs_attention, created_at DESC)
  WHERE needs_attention = TRUE;

-- ─── supabase/migrations/019_news_articles.sql ───────────────────────────────────
-- 019_news_articles.sql
--
-- 수집한 뉴스 원문과 AI 분석을 **따로** 저장한다.
--
-- 왜 한 행에 섞지 않는가
-- ─────────────────────
-- 원문은 사실이고 분석은 의견이다. 한 컬럼에 섞으면 나중에 "이 요약이
-- 원문에 있던 문장인가, AI가 쓴 것인가"를 되짚을 수 없다. 모델을 바꾸면
-- 분석만 다시 만들면 되지만, 섞여 있으면 원문까지 다시 받아야 한다.
--
-- 중복 방지는 hash로 한다. URL만으로는 추적 파라미터(utm_*)가 붙은 같은
-- 기사를 걸러내지 못하고, 제목만으로는 다른 기사가 같은 제목을 쓴다.

create table if not exists news_articles (
  hash          text        primary key,           -- lib/news/schema contentHash
  title         text        not null,
  body          text        not null default '',
  url           text        not null,
  published_at  timestamptz not null,
  source        text        not null default '',
  provider      text        not null default '',   -- 어느 수집처에서 왔는가
  created_at    timestamptz not null default now(),

  -- ── AI 분석 (없을 수 있다) ──
  -- analyzed_at이 null이면 '아직 분석 안 함'이다. direction이 null인 것과
  -- 다르다 — 후자는 분석했는데 판단을 보류한 경우일 수 있다.
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
  -- 검증이 고친 항목. 모델 품질이 나빠지면 여기가 먼저 늘어난다.
  repaired       jsonb,

  -- ── 재시도 제어 ──
  -- 이게 없으면 실패한 기사를 크론이 돌 때마다 다시 분석한다. 15분마다
  -- 돌면 실패 하나가 하루 96번 과금된다. 본문이 깨진 기사 하나가
  -- 조용히 요금을 태우는 것이라, 실패도 세어야 한다.
  analysis_attempts int not null default 0,
  analysis_error    text,
  last_attempt_at   timestamptz
);

-- 목록은 최신순으로만 읽는다
create index if not exists news_articles_published_idx
  on news_articles (published_at desc);

-- 미분석 기사를 골라내는 크론용
create index if not exists news_articles_unanalyzed_idx
  on news_articles (analyzed_at) where analyzed_at is null;

-- 뉴스는 공개 데이터다. 사용자별 소유가 없으므로 RLS는 읽기 전체 허용,
-- 쓰기는 service_role만 (크론이 쓴다).
alter table news_articles enable row level security;

drop policy if exists news_articles_read on news_articles;
create policy news_articles_read on news_articles
  for select using (true);

-- ─── supabase/migrations/020_ai_usage_detail.sql ───────────────────────────────────
-- 020_ai_usage_detail.sql
--
-- ai_usage에 공급자·모델·응답시간·성공 여부를 더한다.
--
-- 왜 필요한가
-- ───────────
-- 지금은 크레딧과 토큰 수만 남는다. 그래서 "OpenAI가 느린가 Gemini가
-- 느린가", "어제부터 실패가 늘었는가", "어느 모델이 돈을 먹는가"를
-- 답할 수 없다. 셋 다 화면에서 필요한 질문이다.
--
-- 오류 문구를 남기는 이유
-- ───────────────────────
-- 실패 횟수만 세면 '왜'를 모른다. 키가 만료된 것과 한도를 넘긴 것은
-- 대응이 완전히 다른데, 화면에서는 둘 다 '실패 3건'으로 보인다.

alter table ai_usage add column if not exists provider    text;
alter table ai_usage add column if not exists model       text;
-- 응답시간. null이면 '측정 못 함'이지 0ms가 아니다.
alter table ai_usage add column if not exists latency_ms  int;
alter table ai_usage add column if not exists ok          boolean;
alter table ai_usage add column if not exists error_text  text;

-- 화면은 공급자별·최근순으로 읽는다
create index if not exists ai_usage_provider_created_idx
  on ai_usage (provider, created_at desc);

-- 최근 오류만 골라내는 용도
create index if not exists ai_usage_errors_idx
  on ai_usage (created_at desc) where ok = false;

-- ─── supabase/migrations/023_ai_predictions.sql ───────────────────────────────────
-- 023_ai_predictions.sql
--
-- AI가 한 말과 **그래서 어떻게 됐는지**를 같이 남긴다.
--
-- 왜 필요한가
-- ───────────
-- "TRAIGO AI Score : 96/100"은 그 자체로는 아무 뜻이 없다. 96%라고 말한
-- 판단이 실제로 96% 맞았는지 재 본 적이 없으면, 그 숫자는 확신의 표현이지
-- 정보가 아니다. 이 표가 그 검증의 원장이다.
--
-- 한 행이 답하는 것 셋:
--   1. AI가 뭐라고 했나            direction · confidence · level
--   2. **몇이 답했나**             responded / asked
--   3. 그래서 어떻게 됐나          outcome · outcome_price (나중에 채운다)
--
-- 커버리지를 왜 열로 두는가
-- ─────────────────────────
-- 다섯에게 물어 둘이 답했는데 그 둘이 같은 말을 하면 level은 'UNANIMOUS'다.
-- 숫자만 보면 가장 강한 합의처럼 보이는데 실제로는 가장 적게 확인된 판단이다.
-- responded와 asked를 따로 남기지 않으면 이 구분이 영원히 사라진다.
--
-- outcome이 왜 NULL을 허용하는가
-- ──────────────────────────────
-- 결과는 예측보다 나중에 나온다. 그 사이를 '보합'이나 '맞음'으로 채우면
-- 적중률이 시간이 갈수록 좋아지는 것처럼 보인다. **모르는 것은 NULL이고,
-- 채점(lib/ai/calibration)은 NULL을 분자에도 분모에도 넣지 않는다.**

CREATE TABLE IF NOT EXISTS ai_predictions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID,

  -- 무엇에 대한 판단인가
  symbol         TEXT NOT NULL,
  source         TEXT NOT NULL,              -- 'consensus' | 'openai' | 'anthropic' | …

  -- AI가 한 말
  direction      TEXT,                       -- bullish | bearish | neutral | uncertain
  confidence     NUMERIC,                    -- 0~100. 모르면 NULL (0이 아니다)
  level          TEXT,                       -- UNANIMOUS | MAJORITY | SPLIT | INSUFFICIENT
  responded      INT,                        -- 실제로 답한 공급자 수
  asked          INT,                        -- 물어본 공급자 수
  reasons        JSONB,                      -- 근거. 나중에 왜 틀렸는지 되짚는 데 쓴다

  -- 이 판단이 실제 주문에 쓰였는가
  --   'INFO' 기록만 함 · 'VETO' 진입을 막음 · 'PASS' 반대하지 않아 통과
  -- 쓰이지 않은 판단까지 같이 채점해야 "막았을 때만 맞더라" 같은 착시를 피한다.
  applied        TEXT,
  side           TEXT,                       -- 그때 하려던 방향 LONG | SHORT

  decided_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_price    NUMERIC,                    -- 판단 시점 가격 — 정답지의 기준
  horizon_min    INT,                        -- 몇 분 뒤로 채점할 것인가

  -- 채점 결과. **나중에** 채운다
  outcome        TEXT,                       -- bullish | bearish | neutral. 모르면 NULL
  outcome_price  NUMERIC,
  scored_at      TIMESTAMPTZ,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 최신 판단 조회 — 거부권은 "이 종목의 가장 최근 합의"를 본다
CREATE INDEX IF NOT EXISTS ai_pred_symbol_idx
  ON ai_predictions (user_id, symbol, decided_at DESC);

-- 채점 대상 찾기. 아직 결과가 없는 것만 훑는다
CREATE INDEX IF NOT EXISTS ai_pred_unscored_idx
  ON ai_predictions (decided_at) WHERE outcome IS NULL;

-- 캘리브레이션 조회
CREATE INDEX IF NOT EXISTS ai_pred_scored_idx
  ON ai_predictions (user_id, decided_at DESC) WHERE outcome IS NOT NULL;

-- RLS. `public` 스키마의 표는 PostgREST로 인터넷에 노출되고, anon 키는
-- 브라우저 번들에 들어 있는 공개 값이다 (022 마이그레이션 참조).
ALTER TABLE ai_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_pred_service ON ai_predictions;
CREATE POLICY ai_pred_service ON ai_predictions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 것만 읽는다. 쓰기는 서버(service_role)만 — 사용자가 직접 넣을 수
-- 있으면 성적표를 스스로 고칠 수 있고, 그러면 채점의 의미가 없다.
DROP POLICY IF EXISTS ai_pred_owner ON ai_predictions;
CREATE POLICY ai_pred_owner ON ai_predictions
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ─── supabase/migrations/024_sub_accounts.sql ───────────────────────────────────
-- 024_sub_accounts.sql
--
-- 가상 서브계좌 — 한 거래소 계좌를 앱 안에서 **장부로** 나눈다.
--
-- 왜 진짜 계좌를 여러 개 만들지 않는가
-- ────────────────────────────────────
-- 거래소 계좌를 쪼개면 이체가 필요하고, 이체는 시간이 걸리고 실패한다.
-- 실험 계정이 기회를 봤는데 자금이 성장 계정에 묶여 있으면 그 사이에 기회가
-- 사라진다. 장부로만 나누면 자금은 한 곳에 있고 한도만 갈린다.
--
-- 대신 장부가 거래소보다 느슨해서는 안 된다 — 이 표의 값은
-- `lib/portfolio/subAccount.ts`가 읽어 **주문을 실제로 막는 데** 쓴다.
-- (체크리스트 항목 SUBACCOUNT_LIMIT)
--
-- allocated_usd가 NULL을 허용하는 이유
-- ────────────────────────────────────
-- '한도 없음'이 아니라 **'아직 안 정했다'**를 표현해야 하기 때문이다.
-- 0으로 두면 "이 바구니는 안 쓴다"가 되고, 그건 완전히 다른 뜻이다.
-- 판정 함수도 NULL을 unknown으로, 0을 '한도 0'으로 다르게 다룬다.

CREATE TABLE IF NOT EXISTS sub_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,

  name           TEXT NOT NULL,                 -- '성장' · '안정' · '실험'
  allocated_usd  NUMERIC,                       -- NULL = 미설정 (0과 다르다)

  -- 이 바구니가 맡는 범위. 비어 있으면 '전부'.
  -- 종목까지 지정한 바구니가 시장만 지정한 바구니보다 우선한다
  -- (subAccount.ts의 pickAccount).
  markets         TEXT[],                       -- {'SPOT','USDM','COINM'}
  symbol_prefixes TEXT[],                       -- {'BTC','ETH'}

  note           TEXT,
  -- 같은 조건이 겹칠 때 **먼저 정의한 것**을 쓴다. 순서가 우선순위다.
  sort_order     INT NOT NULL DEFAULT 0,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sub_acct_user_idx
  ON sub_accounts (user_id, sort_order, created_at);

-- 같은 사용자가 같은 이름을 두 번 만들면 화면에서 구분이 안 된다.
CREATE UNIQUE INDEX IF NOT EXISTS sub_acct_name_uniq
  ON sub_accounts (user_id, name);

-- RLS. `public` 스키마의 표는 PostgREST로 인터넷에 노출되고, anon 키는
-- 브라우저 번들에 들어 있는 공개 값이다 (022 마이그레이션 참조).
ALTER TABLE sub_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sub_acct_service ON sub_accounts;
CREATE POLICY sub_acct_service ON sub_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 것만 읽고 쓴다. 이건 **사용자가 직접 정하는 설정**이라 쓰기도 연다 —
-- 성적표(ai_predictions)와 달리 스스로 고칠 수 있어야 하는 값이다.
DROP POLICY IF EXISTS sub_acct_owner ON sub_accounts;
CREATE POLICY sub_acct_owner ON sub_accounts
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─── supabase/migrations/025_paper_market.sql ───────────────────────────────────
-- 025_paper_market.sql
--
-- 모의 포지션에 **어느 시장인지**를 적는다.
--
-- 왜 필요한가
-- ───────────
-- 지금까지 모의는 USDT 선물만 있었다. 현물을 넣으면 두 종류가 한 표에
-- 섞이는데, 둘은 화면에 보여야 하는 것이 다르다:
--
--   선물  배율 · 청산가 · 증거금
--   현물  **셋 다 없다** (배율 1, 청산 없음, 산 만큼 돈이 나간다)
--
-- 칸이 없으면 현물 포지션에도 '1배 · 청산가 —'가 뜨고, 사용자는 그것을
-- "청산가를 못 읽었다"로 읽는다. 없는 것과 못 읽은 것은 다르다.
--
-- 기본값을 USDM으로 두는 이유
-- ───────────────────────────
-- 이미 들어 있는 행은 전부 선물이다. NULL로 두면 기존 포지션이 '시장 모름'이
-- 되고, 그러면 서브계좌 한도(SUBACCOUNT_LIMIT)가 그것들을 어느 바구니로도
-- 세지 못한다 — 없던 unknown이 생긴다.

ALTER TABLE paper_positions
  ADD COLUMN IF NOT EXISTS market TEXT NOT NULL DEFAULT 'USDM';

-- 'SPOT' | 'USDM' | 'COINM' 외의 값이 들어가면 판정 함수들이 조용히
-- '해당 없음'으로 흘려보낸다. 그럴 바에 쓰기를 막는다.
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

-- ─── supabase/migrations/026_safety_events.sql ───────────────
-- 026_safety_events.sql
--
-- **안전장치가 실제로 발동한 기록.**
--
-- 왜 필요한가
-- ───────────
-- 지금까지 주문이 막히면 409를 돌려주고 끝이었다. 어디에도 남지 않는다.
-- 그래서 화면은 설정값만 보여줄 수 있었다 — "오늘 손실 한도 5%".
--
-- 설정값만 보이면 사람은 그것이 **돌고 있다고 믿는다.** 오늘 하루에만
-- 켜져 있다고 믿었는데 실제로는 한 번도 안 돈 안전장치를 여섯 개 찾았다
-- (지표 회피·실전 분류·연결 테스트·선물 잔고·백테스트 청산·캘린더 크론).
-- 전부 에러가 안 나고 화면이 멀쩡한 종류였다.
--
-- 한 번도 발동한 적 없는 안전장치는 **작동한다고 말할 수 없다.**
-- 이 표는 그 차이를 화면에 드러내기 위한 것이다.
--
-- 무엇을 적는가
-- ─────────────
-- 막은 항목 하나당 한 줄이다. 한 주문이 세 항목에 걸리면 세 줄이 남는다 —
-- "무엇이 막았나"를 항목별로 세야 하기 때문이다. 합쳐서 한 줄로 적으면
-- 어느 안전장치가 실제로 일하는지 알 수 없다.
--
-- 통과는 적지 않는다. 통과까지 적으면 이 표가 주문 로그가 되고, 그러면
-- 정작 보고 싶은 '발동'이 묻힌다.

CREATE TABLE IF NOT EXISTS safety_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID,

  -- 체크리스트의 항목 id (DAILY_LOSS_LIMIT · AI_VETO · SUBACCOUNT_LIMIT …)
  kind         TEXT NOT NULL,
  label        TEXT,

  -- **왜 막았나.** 'fail'과 'unknown'은 다른 문제고 대응도 다르다:
  -- 앞은 한도에 걸린 것이고, 뒤는 확인을 못 한 것이다. 합치면 안 된다.
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

-- 읽기만 연다. 이건 **자기가 못 고쳐야 하는 기록**이다 —
-- 발동 이력을 지울 수 있으면 "한 번도 안 걸렸다"를 만들 수 있고,
-- 그러면 이 표의 존재 이유가 사라진다.
DROP POLICY IF EXISTS safety_events_owner ON safety_events;
CREATE POLICY safety_events_owner ON safety_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());
