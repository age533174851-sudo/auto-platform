// src/lib/supabase/admin.ts
// Re-exports for server-side API routes. Import only from /api/...
export { getSupabaseAdmin, getUserIdFromRequest, resolveUserId, serviceRoleKeyRole } from './server';

export function apiError(msg: string, status = 400): Response {
  return Response.json({ error: msg }, { status });
}
export function apiOk(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
