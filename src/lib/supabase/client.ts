// ─────────────────────────────────────────────────────────────
// src/lib/supabase/client.ts
// Browser-side client — anon key ONLY, never service role key
// ─────────────────────────────────────────────────────────────
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const isSupabaseConfigured = !!(SUPABASE_URL && SUPABASE_ANON);

let supabaseClientSingleton: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> | null {
  if (!isSupabaseConfigured) return null;
  if (supabaseClientSingleton) return supabaseClientSingleton;
  supabaseClientSingleton = createClient<Database>(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return supabaseClientSingleton;
}

/** Get the currently logged-in user ID, or null */
export async function getClientUserId(): Promise<string | null> {
  const sb = getSupabaseClient();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data?.user?.id ?? null;
}

/** Typed shorthand */
export function supabase() {
  return getSupabaseClient();
}
