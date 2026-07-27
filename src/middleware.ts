// ─────────────────────────────────────────────────────────────
// TRAIGO Next.js Middleware
// Protects /admin and /developer routes
// ─────────────────────────────────────────────────────────────
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protected routes — actual auth check is done client-side
  // (Supabase SSR middleware requires @supabase/ssr which is optional)
  // For now, allow all routes — client pages do their own role checks
  
  // Future: add Supabase server-side session check here
  // const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, ...)
  
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/developer/:path*', '/auth/:path*'],
};
