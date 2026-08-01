-- 021_grant_owner_role.sql
--
-- 운영자 계정 승급 — **손으로 한 번 실행하는 스크립트**다.
--
-- 왜 자동 마이그레이션이 아니라 수동인가
-- ──────────────────────────────────────
-- 이 파일에 이메일을 박아 두면 이 저장소를 배포하는 누구나 그 계정을
-- 관리자로 만들게 된다. 권한을 주는 규칙이 코드에 상수로 남으면 그건
-- 뒷문이다. 그래서 이메일 자리를 비워 두고, 실행할 때 채워 넣는다.
--
-- 평소에는 환경변수 쪽이 낫다 (.env.example의 '운영자 승급' 항목):
--   SUPER_ADMIN_EMAILS=you@example.com  →  첫 로그인 때 자동으로 올라간다
-- 이 SQL은 그게 안 될 때(아직 배포 전, 환경변수 반영 대기 중) 쓰는 즉시 수단이다.
--
-- ── 쓰는 법 ────────────────────────────────────────────────
-- Supabase 대시보드 → SQL Editor에 붙여넣고 이메일만 바꿔 실행.

-- 1) 먼저 **확인한다.** 행이 안 나오면 그 이메일로 가입한 적이 없는 것이다.
--    (가입 전에 UPDATE를 돌리면 0 rows가 조용히 지나간다 — 그게 성공처럼 보인다)
select id, email, role, created_at
from profiles
where lower(email) = lower('여기에@이메일.com');

-- 2) 승급. **올리기만 한다.**
--    이미 더 높은 등급이면 건드리지 않는다 — 잘못 실행해서 super_admin이
--    admin으로 내려가는 일이 없게. 등급 순서는 lib/auth.ts의 ROLE_RANK와 같다:
--      user < vip < lifetime < founder < admin < developer < super_admin
--
--    'super_admin' 자리에 원하는 등급을 넣는다:
--      admin        → /admin 만
--      developer    → /admin + /developer
--      super_admin  → 전부
update profiles p
set    role = 'super_admin'
where  lower(p.email) = lower('여기에@이메일.com')
  and  coalesce(
         array_position(
           array['user','vip','lifetime','founder','admin','developer','super_admin'],
           p.role),
         1)
       < array_position(
           array['user','vip','lifetime','founder','admin','developer','super_admin'],
           'super_admin');

-- 3) 결과 확인. 2)가 0 rows였다면 이미 그 등급이거나 더 높다는 뜻이다.
select id, email, role
from profiles
where lower(email) = lower('여기에@이메일.com');
