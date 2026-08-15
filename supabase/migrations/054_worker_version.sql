-- 054_worker_version.sql
--
-- **워커가 자기 커밋을 말하게 한다.**
--
-- 왜 필요한가
-- ───────────
-- 2026-08-13: fly-deploy가 안 돌아 Fly Worker가 8월 9일 코드로 돌았다.
--             예약 폴링 코드는 들어간 적이 없었고, 09:10~09:30 판단 창을
--             아무도 보지 않았다.
-- 2026-08-15: #128(고아 보호주문 정리)·#129(반복 스모크)가 main에 합쳐진
--             뒤에도 Fly에는 #127이 그대로 떠 있었다. fly-deploy의
--             workflow_run 실행은 남는데 job은 전부 skipped였다 —
--             **로그만 보면 배포가 도는 것처럼 보였다.**
--
-- 두 번 다 공통점이 하나다: **"지금 Fly에 무엇이 떠 있나"에 답할 수단이
-- 없었다.** 화면도, DB도, 로그도 그 질문에 답하지 못했다.
--
-- 이 칸이 그 답이다. 워커가 heartbeat마다 자기 GIT_SHA를 적고
-- `/api/system/deployment`가 Vercel의 SHA와 나란히 보여 준다.
--
-- **비어 있으면 "모름"이다.** 읽는 쪽은 빈 값을 "main과 같다"로 읽지
-- 않는다 — 확인하지 못한 것은 통과가 아니다.

ALTER TABLE worker_heartbeat
  ADD COLUMN IF NOT EXISTS version TEXT;

COMMENT ON COLUMN worker_heartbeat.version IS
  '이 워커가 빌드된 커밋 SHA (Dockerfile ARG GIT_SHA ← fly-deploy --build-arg). 비어 있으면 모름';
