// ─────────────────────────────────────────────────────────────
// TRAIGO Next.js Middleware
// Protects /admin and /developer routes
// ─────────────────────────────────────────────────────────────
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// 현재 이 미들웨어는 아무것도 막지 않는다. 이유를 남겨 둔다.
//
// src/lib/supabase/client.ts가 @supabase/supabase-js의 createClient를 기본
// 설정으로 쓰기 때문에 세션이 localStorage에 저장된다. 미들웨어는 요청
// 쿠키만 볼 수 있고 localStorage에 접근할 수 없으므로, 여기서 로그인 여부를
// 판별할 방법이 없다. 조건문을 넣어 봐야 항상 "비로그인"으로 보인다.
//
// 실제 방어선은 두 곳이다:
//   - /api/* 라우트: requireAdmin()이 Bearer JWT를 검증하고 profiles.role을
//     DB에서 직접 읽는다 (src/lib/auth/isAdmin.ts). 데이터는 여기서 막힌다.
//   - 페이지 컴포넌트: 클라이언트 측 역할 검사로 UI를 가린다.
//
// 따라서 미인증 사용자가 /admin의 HTML 껍데기는 받을 수 있지만 데이터는
// 전부 403이다. 그래도 페이지 단계에서 막으려면 쿠키 기반 세션으로 옮겨야
// 한다: @supabase/ssr 추가 → createBrowserClient/createServerClient로 교체
// → 미들웨어에서 세션 갱신. 로그인 흐름 전체를 건드리는 작업이라 별도로
// 진행해야 한다.
export function middleware(request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/developer/:path*', '/auth/:path*'],
};
