-- 073_worker_scheduler.sql
--
-- **예약 주 경로가 도는지를 사람이 fly logs로 확인하는 일을 없앤다.**
--
-- 무엇이 있었나
-- ─────────────
-- 예약 평가의 주 실행자는 이미 Fly Worker다. GitHub `autotrade-tick`은
-- 예비다. 그런데 2026-08-29에 "그게 실제로 도는가"에 값으로 답할 수
-- 없었다 — 근거가 셋 다 사람 손을 탄다:
--
--   · `[schedules] …` 로그        `fly logs`를 사람이 연다
--   · `autotrade_schedules`        DB에 직접 붙어야 읽는다
--   · `/api/system/runtime-health` 로그인이 필요해 CI가 못 읽는다
--
-- 그래서 판정이 "확인 불가"로 끝났다. 확인하지 못한 것을 통과로 적지는
-- 않았지만, **확인할 방법이 없는 것 자체가 고장이다.**
--
-- 무엇을 하나
-- ───────────
-- 사실을 아는 쪽이 적는다. 워커는 자기가 APP_URL·ADMIN_SECRET을
-- 가졌는지, main 락을 쥐었는지, 예약을 마지막으로 언제 봤는지 전부
-- 알고 있다. 그걸 heartbeat에 같이 적으면, 인증이 필요 없는
-- `/api/system/deployment`가 그대로 보여 주고 `deployment-check`가
-- 배포마다 찍는다. **새로 눌러야 할 버튼이 없다.**
--
-- 값이 들어가지 않는가
-- ────────────────────
-- 들어가지 않는다. APP_URL도 ADMIN_SECRET도 **있다/없다(boolean)만**
-- 적는다. 주소도 시크릿도, 그 지문조차 이 칸에 들어가지 않는다.
-- 무엇이 들어가는지는 `src/lib/runtime/schedulerReport.ts`의
-- `SchedulerReport`가 정의하고, 시험이 붙어 있다.
--
-- 안전한가
-- ────────
-- 칸을 더하기만 한다. 지우지도, 이름을 바꾸지도, 타입을 바꾸지도 않는다.
-- 이 칸이 없는 배포에서도 워커는 그대로 돈다 — 칸이 없다는 오류가 나면
-- 이 값을 빼고 다시 적는 경로가 이미 있다(`runtimeColumnsMissing`).
-- 읽는 쪽도 칸이 없으면 빼고 다시 읽는다. **없는 것을 "안 돈다"로
-- 읽지 않는다 — INSUFFICIENT_EVIDENCE다.**

ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS scheduler JSONB;

COMMENT ON COLUMN worker_heartbeat.scheduler IS
  '예약 폴러가 스스로 적는 상태입니다. 환경변수는 있다/없다(boolean)만 적고 값·지문은 넣지 않습니다. 형식은 src/lib/runtime/schedulerReport.ts의 SchedulerReport이고, 판정은 schedulerVerdict() 한 곳에서만 합니다';
