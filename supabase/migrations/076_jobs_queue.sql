-- 076_jobs_queue.sql
--
-- 번호 없는 `jobs.sql`이 지고 있던 canonical 책임을 번호 체계로 옮긴다.
--
-- 왜 tail(076)인가
-- ────────────────
-- 001과 사정이 다르다. 001은 054·057·066·067·073이 그 표에 ALTER를 걸고
-- 022가 RLS를 걸어서 **앞자리여야만** 했다. `public.jobs`는 그렇지 않다 —
-- 번호 마이그레이션 중 이 표를 참조하는 것이 하나도 없다. 실제로 001을
-- 넣은 뒤 빈 DB 번호 replay가 `OK 73 / FAIL 0`으로 통과했고, 그때 `jobs`는
-- 아예 만들어지지 않은 상태였다. 즉 순서 제약이 없다.
--
-- 순서 제약이 없으면 **앞자리를 쓰지 않는다.** 이미 적용된 번호들 사이에
-- 새 번호를 끼우면 "어느 시점의 스키마인가"가 파일 순서와 어긋난다.
-- 비어 있는 다음 자리에 붙이는 것이 기록으로도 정직하다. 075가 현재
-- 최댓값이고 076은 저장소에도 git 히스토리에도 존재한 적이 없다.
--
-- production에서는 이 SQL이 실행되지 않는다
-- ─────────────────────────────────────────
-- 운영 DB에는 target 네 개가 이미 전부 있다(2026-08-31 read-only audit:
-- JOBS_TABLE_EXISTS · COLUMNS · CONSTRAINTS · INDEXES · RLS · POLICY 모두
-- TRUE, JOBS_RUNNER_BASELINE_EXPECTED=TRUE, JOBS_SEMANTIC_MATCH=TRUE).
-- runner는 그것을 보고 실행 없이 BASELINE으로 채택한다. 아래
-- `drop policy if exists jobs_owner`가 운영 정책을 지우는 일은 그래서 없다.
--
-- 의미를 바꾸지 않는다
-- ────────────────────
-- canonicalization이다. legacy가 만들던 것과 같은 것만 만든다. 정책은
-- `jobs_owner` 하나뿐이고 SELECT뿐이다 — 적재와 실행은 service_role(Vercel ·
-- Worker)이 RLS를 우회해서 한다. 그 모델을 그대로 둔다. INSERT·UPDATE·
-- DELETE·service_role 정책도, FORCE RLS도 여기서 새로 만들지 않는다.
--
-- `gen_random_uuid()`가 필요한 pgcrypto는 001이 책임진다(001이 먼저 돈다).

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
