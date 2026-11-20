-- 106 · 피드백 게시판 — 사용자가 신고하고, 같은 글 안에서 대화한다 (#618)
--
-- 왜 필요한가
-- ───────────
-- 지금 TRAIGO에는 사용자가 문제를 알릴 길이 **하나도 없다.** API도 화면도
-- 테이블도 없다(조사: `support|feedback|inquiry|ticket` 전부 0건). 친구에게
-- 써 보라고 하면 문제를 카카오톡으로 받아 사람이 옮겨 적어야 한다.
--
-- 왜 글 하나가 아니라 글 + 메시지인가
-- ───────────────────────────────────
-- 요구사항의 핵심이 "같은 문의 안에서 계속 대화한다"이다. 답변이 한 번이면
-- 글에 칸 하나로 충분하지만, 사용자가 "아니요 다른 방식이 좋아요"라고
-- 답장하고 그 맥락이 이어져야 하므로 **메시지가 줄줄이 쌓이는 모양**이
-- 맞다. 나중에 AI가 답하더라도 같은 표에 한 줄 더 쌓으면 된다.
--
-- 이름은 #618의 명세를 따른다
-- ────────────────────────────
-- 소유자가 2026-11-13에 `feedback_reports` · `feedback_comments` ·
-- `feedback_votes` · `feedback_events`로 적어 두었다. 운영에 표가 생기면
-- 이름을 바꾸는 데 데이터 이전이 필요하므로 **생기기 전에** 맞춘다.
--
-- 세 가지를 일부러 안 넣었다
-- ──────────────────────────
-- ⓪ **`feedback_votes` · `feedback_events`** — 공감과 감사 이력을 쓰는
--    코드가 아직 없다. 아무도 쓰지 않는 표를 먼저 만들면 그것이 이
--    저장소가 "만들어 놓고 배선을 안 함"이라 부르는 고장이다. 공개
--    게시판과 관리자 심사를 만들 때 함께 넣는다.
-- ① **첨부파일 표** — 이 저장소에는 아직 파일 업로드 경로가 한 곳도 없다
--    (`storage.from` 0건). 저장 위치·크기 제한·검증을 정하지 않고 표만
--    만들면 아무도 쓰지 않는 칸이 남는다. 다음 단위에서 함께 넣는다.
-- ② **AI 작업 상태 칸** — 'AI 분석 중' 같은 상태를 지금 넣으면 아무도
--    돌리지 않는 상태가 화면에 뜬다. 그 파이프라인이 생긴 뒤에 더한다.
--    `src/lib/support/ticket.ts`의 `STATUS_NOT_YET`이 같은 약속을 적어 둔다.
--
-- 권한 모델은 집 규칙 그대로
-- ──────────────────────────
-- RLS를 켜고 **소유자 SELECT 정책 하나**만 둔다. 쓰기는 service_role이
-- RLS를 우회해서 한다(API가 `getSupabaseAdmin()`으로 돌고 `user_id`를
-- 코드에서 확인한다). 099·076이 쓰는 것과 같은 모델이다.
--
-- **공개 글도 소유자만 SELECT한다.** 공개 제안 게시판은 아직 없고, 읽기
-- 경로가 생기기 전에 정책을 먼저 열면 그 사이에 남의 글이 보인다.
-- 정책은 읽기 화면과 같은 회차에 연다.
--
-- 재적용 가능하다
-- ───────────────
-- 전부 `IF NOT EXISTS`이고 정책은 `DROP POLICY IF EXISTS` 뒤에 만든다.
-- 두 번 올려도 같은 결과다.

CREATE TABLE IF NOT EXISTS public.feedback_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  -- 사람이 부르는 번호. uuid를 읽어 주기는 어렵다.
  ref         bigint GENERATED ALWAYS AS IDENTITY,
  category    text NOT NULL CHECK (category IN
                ('BUG','UX','FEATURE','ORDER','AUTOTRADE','CONNECTION',
                 'ACCOUNT','PAPER','SECURITY','GENERAL','OTHER')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- #618의 상태: 접수 → 확인 중 → 수정 중 → **검증 중** → 해결,
  -- 그리고 보류 · 중복 · 재현 불가. `NEEDS_INFO`(추가 정보 요청)는 사용자가
  -- 같은 글에 답장하는 흐름에 필요해 함께 둔다.
  status      text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN
                ('RECEIVED','REVIEWING','NEEDS_INFO','IN_PROGRESS','VERIFYING',
                 'RESOLVED','ON_HOLD','DUPLICATE','CANNOT_REPRODUCE','CLOSED')),
  severity    text NOT NULL DEFAULT 'NORMAL' CHECK (severity IN ('URGENT','HIGH','NORMAL','LOW')),
  visibility  text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','PUBLIC')),
  -- 거래·계정·보안 문의는 **DB에서도** 공개가 될 수 없다. 앱이 틀려도 막힌다.
  CONSTRAINT feedback_reports_private_categories CHECK (
    visibility = 'PRIVATE' OR category NOT IN
      ('BUG','ORDER','AUTOTRADE','CONNECTION','ACCOUNT','PAPER','SECURITY')),
  -- #618이 요구한 세 칸. **비워 둘 수 있다** — 버그가 아닌 문의에는 해당이
  -- 없고, 억지로 채우게 하면 사용자가 아무 글자나 넣는다.
  steps       text CHECK (steps IS NULL OR length(steps) <= 4000),
  expected    text CHECK (expected IS NULL OR length(expected) <= 2000),
  actual      text CHECK (actual IS NULL OR length(actual) <= 2000),
  -- 자동 수집한 화면·기기 정보. **허용 목록으로 만들어 넣는다**(앱이 고른다).
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 비밀을 몇 건 지웠는가. **값은 담지 않는다** — 종류와 개수뿐이다.
  redactions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feedback_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES public.feedback_reports(id) ON DELETE CASCADE,
  -- 누가 적었는가. USER는 작성자, STAFF는 관리자, AGENT는 나중에 올 자동 개발.
  author      text NOT NULL CHECK (author IN ('USER','STAFF','AGENT')),
  -- 관리자 내부 메모는 작성자에게 보이지 않는다. **같은 표에 두되 칸으로 가른다** —
  -- 표를 나누면 "메모를 답변 표에 잘못 넣는" 실수가 한 번은 난다.
  internal    boolean NOT NULL DEFAULT false,
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  redactions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 사용자가 쓴 글은 내부 메모일 수 없다.
  CONSTRAINT feedback_comments_user_not_internal CHECK (author <> 'USER' OR internal = false)
);

CREATE INDEX IF NOT EXISTS feedback_reports_mine ON public.feedback_reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_reports_queue ON public.feedback_reports(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_comments_thread ON public.feedback_comments(report_id, created_at);

ALTER TABLE public.feedback_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feedback_reports_owner   ON public.feedback_reports;
DROP POLICY IF EXISTS feedback_reports_service ON public.feedback_reports;
DROP POLICY IF EXISTS feedback_comments_owner  ON public.feedback_comments;
DROP POLICY IF EXISTS feedback_comments_service ON public.feedback_comments;

CREATE POLICY feedback_reports_owner ON public.feedback_reports
  FOR SELECT TO authenticated USING (user_id = auth.uid());
-- **내부 메모는 소유자에게도 보이지 않는다.** 정책 자체가 거른다 —
-- 앱에서 거르면 한 곳만 고치고 다른 곳이 새는 일이 생긴다.
CREATE POLICY feedback_comments_owner ON public.feedback_comments
  FOR SELECT TO authenticated USING (
    internal = false
    AND EXISTS (SELECT 1 FROM public.feedback_reports t
                WHERE t.id = feedback_comments.report_id AND t.user_id = auth.uid()));

CREATE POLICY feedback_reports_service  ON public.feedback_reports  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY feedback_comments_service ON public.feedback_comments FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.feedback_reports, public.feedback_comments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.feedback_reports, public.feedback_comments TO authenticated;
GRANT ALL    ON public.feedback_reports, public.feedback_comments TO service_role;
