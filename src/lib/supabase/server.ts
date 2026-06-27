// src/lib/supabase/server.ts
// Server-only — service role key. Import ONLY from /api/... routes.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

/** Fresh service-role client per request (never cached). */
export function getSupabaseAdmin(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** SUPABASE_SERVICE_ROLE_KEY가 진짜 service_role 키인지 JWT role로 진단.
 *  anon 키를 잘못 넣으면 RLS에 막히므로, 이를 빨리 잡기 위함. */
export function serviceRoleKeyRole(): 'service_role' | 'anon' | 'unknown' | 'missing' {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return 'missing';
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64').toString('utf8'));
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

/** Resolve user ID: prefer JWT auth, fallback to x-user-id header (dev/demo). */
export async function resolveUserId(
  authHeader: string | null,
  fallbackHeader: string | null
): Promise<string | null> {
  const fromJwt = await getUserIdFromRequest(authHeader);
  return fromJwt ?? fallbackHeader ?? null;
}
