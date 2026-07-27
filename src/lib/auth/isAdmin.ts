// src/lib/auth/isAdmin.ts
// Server-side ONLY — import only from /api/... route handlers.
// NEVER import from 'use client' components.
import { getSupabaseAdmin } from '@/lib/supabase/server';

// Roles that have admin access
// Promotion is ONLY possible via Supabase SQL — never via frontend
const ADMIN_ROLES = new Set(['admin', 'developer', 'super_admin']);

export type ProfileRole =
  | 'user'
  | 'vip'
  | 'lifetime'
  | 'founder'
  | 'admin'
  | 'developer'
  | 'super_admin';

export interface AdminCheckResult {
  userId: string | null;
  role:   ProfileRole | null;
  isAdmin: boolean;
}

/**
 * Verify a Bearer JWT and read role from profiles table.
 * - Role comes ONLY from Supabase DB — never from client-supplied data.
 * - Returns isAdmin=false for ANY failure (bad token, missing row, DB error).
 */
export async function checkAdminRole(
  authHeader: string | null
): Promise<AdminCheckResult> {
  const deny: AdminCheckResult = { userId: null, role: null, isAdmin: false };

  if (!authHeader?.startsWith('Bearer ')) return deny;
  const token = authHeader.slice(7);

  const sb = getSupabaseAdmin();
  if (!sb) return deny;

  // Step 1: verify JWT — fails fast on expired / forged tokens
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) return deny;
  const userId = userData.user.id;

  // Step 2: read role from DB — client cannot supply or spoof this
  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (profileErr || !profile) return { userId, role: null, isAdmin: false };

  const role = ((profile as { role?: string } | null)?.role ?? 'user') as ProfileRole;
  return { userId, role, isAdmin: ADMIN_ROLES.has(role) };
}

/**
 * Guard for admin-only API routes.
 * Returns { userId, role } if authorised, or a 403 Response otherwise.
 *
 * Usage in a route handler:
 *   const guard = await requireAdmin(req.headers.get('authorization'));
 *   if (guard instanceof Response) return guard;   // 403 — stop here
 *   const { userId } = guard;                      // authorised
 */
export async function requireAdmin(
  authHeader: string | null
): Promise<{ userId: string; role: ProfileRole } | Response> {
  const check = await checkAdminRole(authHeader);
  if (!check.isAdmin) {
    return Response.json(
      { error: '관리자 권한이 필요합니다.', code: 'FORBIDDEN' },
      { status: 403 }
    );
  }
  return { userId: check.userId!, role: check.role! };
}
