// src/lib/supabase/server.ts
// Server-only — service role key. Import ONLY from /api/... routes.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

/** Fresh service-role client per request (never cached). */
export function getSupabaseAdmin(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();   // 공백/줄바꿈 제거
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** SUPABASE_SERVICE_ROLE_KEY가 진짜 service_role 키인지 진단.
 *  레거시 JWT(role 클레임) + 신형 키(sb_secret_/sb_publishable_) 모두 인식.
 *  anon/publishable 키를 잘못 넣으면 RLS에 막히므로 빨리 잡기 위함. */
export function serviceRoleKeyRole(): 'service_role' | 'anon' | 'unknown' | 'missing' {
  const raw = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!raw) return 'missing';
  const key = raw.trim();
  if (!key) return 'missing';
  // 신형 키 (JWT 아님)
  if (key.startsWith('sb_secret_')) return 'service_role';
  if (key.startsWith('sb_publishable_')) return 'anon';
  // 레거시 JWT
  try {
    const parts = key.split('.');
    if (parts.length !== 3) return 'unknown';   // JWT 형식 아님 → 잘림/오타 의심
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (payload?.role === 'service_role') return 'service_role';
    if (payload?.role === 'anon') return 'anon';
    return 'unknown';
  } catch { return 'unknown'; }
}

/** Extract Supabase user ID from Bearer JWT in Authorization header. */
export async function getUserIdFromRequest(
  authHeader: string | null
): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  const { data, error } = await sb.auth.getUser(authHeader.slice(7));
  if (error || !data?.user) return null;
  return data.user.id;
}

/**
 * Resolve user ID.
 *
 * 보안: x-user-id 헤더는 누구나 조작할 수 있으므로 신뢰하지 않는다.
 * 운영 환경에서는 검증된 Supabase JWT의 user.id만 사용한다.
 * 개발 환경에서만, 그리고 DEV_AUTH_BYPASS_TOKEN이 일치할 때만 헤더 우회를 허용한다.
 */
export async function resolveUserId(
  authHeader: string | null,
  fallbackHeader: string | null,
  devToken?: string | null
): Promise<string | null> {
  const fromJwt = await getUserIdFromRequest(authHeader);
  if (fromJwt) return fromJwt;

  // 운영 환경: JWT 없으면 무조건 거부
  if (process.env.NODE_ENV === 'production') return null;

  // 개발 환경: 별도 토큰이 설정되어 있고 일치할 때만 허용
  const expected = process.env.DEV_AUTH_BYPASS_TOKEN;
  if (!expected) return null;
  if (!devToken || devToken !== expected) return null;

  return fallbackHeader ?? null;
}
