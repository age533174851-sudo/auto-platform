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
