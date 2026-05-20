// ─────────────────────────────────────────────────────────────
// src/lib/supabase/admin.ts
// Thin server-side helpers built on getSupabaseAdmin()
// Import only from /api/... routes
// ─────────────────────────────────────────────────────────────
export { getSupabaseAdmin, getUserIdFromRequest } from './server';

/** Build a standard JSON error response */
export function apiError(msg: string, status = 400) {
  return Response.json({ error: msg }, { status });
}

/** Build a standard JSON success response */
export function apiOk(data: unknown, status = 200) {
  return Response.json(data, { status });
}
