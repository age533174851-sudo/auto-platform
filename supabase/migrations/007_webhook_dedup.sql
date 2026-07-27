-- supabase/migrations/007_webhook_dedup.sql
-- 웹훅 중복 주문 방지용 dedup 테이블. UNIQUE(key)로 원자적 멱등성 보장.
create table if not exists webhook_dedup (
  key         text primary key,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '15 seconds')
);

-- 만료 레코드 조회/정리용 인덱스
create index if not exists webhook_dedup_expires_idx on webhook_dedup (expires_at);

-- RLS: 서비스 롤(서버)만 접근. 클라이언트 직접 접근 차단.
alter table webhook_dedup enable row level security;
-- (정책 없음 = service_role 키만 접근 가능. anon/authenticated는 접근 불가)
