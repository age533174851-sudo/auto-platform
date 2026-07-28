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
