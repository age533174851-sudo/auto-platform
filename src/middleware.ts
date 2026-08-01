// ─────────────────────────────────────────────────────────────
// TRAIGO Next.js Middleware — /admin · /developer 접근 차단
// ─────────────────────────────────────────────────────────────
//
// 예전에 이 파일은 아무것도 막지 않았다. 이유는 사실이었다: Supabase 세션이
// localStorage에 있어 미들웨어가 볼 수 없었다. 그런데 그 상태로 두면 두 가지가
// 남는다.
//   1. /developer는 localStorage JSON 하나로 문을 지켰다 — 콘솔 한 줄로 뚫린다
//   2. 화면은 열리고 데이터만 403이라, "잠긴 줄 알았는데 안 잠긴" 상태가 된다
//
// 그래서 세션 전체를 쿠키로 옮기는 대신(로그인 흐름 전체를 건드린다) access
// token만 쿠키로 **복사**했다. 원본은 그대로 localStorage에 있고, 로그인·로그아웃
// 코드는 손대지 않았다. 복사는 SessionCookieSync가 한다.
//
// 판단은 여기 없다 — lib/auth/adminGate.ts에 있고 테스트가 붙어 있다.
// 이 파일은 쿠키를 꺼내고 리다이렉트하는 일만 한다.
//
// 알아둘 한 가지: 미들웨어는 페이지 요청만 막는다. JS 번들 파일 자체는
// 여전히 공개 URL이다. 즉 이건 '코드를 숨기는 장치'가 아니라 '화면에 들어가지
// 못하게 하는 장치'다. 데이터의 방어선은 계속 API의 requireAdmin()이다.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  gateRequest,
  needsLogin,
  SESSION_COOKIE,
  type GateArea,
  type DenyReason,
} from '@/lib/auth/adminGate';

function areaOf(pathname: string): GateArea | null {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return 'admin';
  if (pathname === '/developer' || pathname.startsWith('/developer/')) return 'developer';
  return null;
}

function deny(request: NextRequest, area: GateArea, reason: DenyReason): NextResponse {
  const url = request.nextUrl.clone();

  if (needsLogin(reason)) {
    // 로그인하면 해결되는 경우. 돌아올 곳을 들고 간다.
    //
    // 이 경로는 로그인한 관리자에게도 한 번 걸릴 수 있다 — 쿠키가 아직
    // 안 써진 첫 방문(배포 직후 등)이다. /auth를 열면 레이아웃에 있는
    // SessionCookieSync가 돌아 쿠키가 생기고, 그 화면이 next로 되돌려
    // 보낸다. 한 번 튕기고 스스로 낫는다.
    url.pathname = '/auth';
    url.search = '';
    url.searchParams.set('next', request.nextUrl.pathname);
    url.searchParams.set('reason', reason);
  } else {
    // 권한이 부족하거나 확인을 못 한 경우. 다시 로그인해도 달라지지 않는다.
    url.pathname = '/unauthorized';
    url.search = '';
    url.searchParams.set('area', area);
    url.searchParams.set('reason', reason);
  }

  const res = NextResponse.redirect(url);
  // 권한 판정 결과가 캐시되면 로그아웃한 뒤에도 통과하거나, 승급한 뒤에도
  // 계속 막힌다. 둘 다 사용자는 원인을 짐작할 수 없다.
  res.headers.set('Cache-Control', 'no-store, must-revalidate');
  return res;
}

export async function middleware(request: NextRequest) {
  const area = areaOf(request.nextUrl.pathname);
  if (!area) return NextResponse.next();

  const decision = await gateRequest({
    area,
    token: request.cookies.get(SESSION_COOKIE)?.value ?? null,
    nowSec: Math.floor(Date.now() / 1000),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  });

  if (!decision.allow) return deny(request, area, decision.reason);

  const res = NextResponse.next();
  res.headers.set('Cache-Control', 'no-store, must-revalidate');
  return res;
}

export const config = {
  // '/admin/:path*'만 적으면 됐는지 헷갈릴 자리다. 두 형태를 모두 적어
  // /admin 자체와 그 아래를 확실히 잡는다 — 여기서 하나 빠지면 그 경로만
  // 조용히 열린다.
  matcher: ['/admin', '/admin/:path*', '/developer', '/developer/:path*'],
};
