// ─────────────────────────────────────────────────────────────
// TRAIGO — Supabase Client
// Uses env vars: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
// ─────────────────────────────────────────────────────────────

import type { UserRole, PlanType, UserStatus, UserProfile } from './auth';

// ── Env ──────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL  || '';
const SUPABASE_KEY  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const SUPABASE_CONFIGURED = !!(SUPABASE_URL && SUPABASE_KEY);

// ── Lazy Supabase client (only instantiated when env vars set) ─
let _client: any = null;

async function getClient() {
  if (!SUPABASE_CONFIGURED) return null;
  if (_client) return _client;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
    return _client;
  } catch {
    return null;
  }
}

// ── DB row → UserProfile ──────────────────────────────────────
function rowToProfile(row: any): UserProfile {
  return {
    id:          row.id,
    email:       row.email,
    displayName: row.display_name || row.email?.split('@')[0] || '사용자',
    role:        (row.role as UserRole) || 'user',
    plan:        (row.plan as PlanType) || 'free',
    status:      (row.status as UserStatus) || 'active',
    badges:      row.badges || [],
    createdAt:   row.created_at?.split('T')[0] || '',
    lastSignIn:  row.last_sign_in_at?.split('T')[0],
    grantedBy:   row.granted_by,
    expiresAt:   row.expires_at,
    avatarUrl:   row.avatar_url,
  };
}

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════

export async function sbSignUp(email: string, password: string, displayName: string) {
  const sb = await getClient();
  if (!sb) return { user: null, error: 'Supabase not configured' };
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) return { user: null, error: error.message };
  return { user: data.user, error: null };
}

export async function sbSignIn(email: string, password: string) {
  const sb = await getClient();
  if (!sb) return { user: null, profile: null, error: 'Supabase not configured' };
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return { user: null, profile: null, error: error.message };
  // Fetch profile
  const profile = await getProfile(data.user.id);
  if (profile?.status === 'banned') {
    await sb.auth.signOut();
    return { user: null, profile: null, error: '차단된 계정입니다. 관리자에게 문의하세요.' };
  }
  return { user: data.user, profile, error: null };
}

export async function sbSignOut() {
  const sb = await getClient();
  if (!sb) return;
  await sb.auth.signOut();
}

export async function sbGetSession() {
  const sb = await getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data?.session || null;
}

export async function sbResetPassword(email: string) {
  const sb = await getClient();
  if (!sb) return { error: 'Supabase not configured' };
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${SUPABASE_URL}/auth/callback`,
  });
  return { error: error?.message || null };
}

// ══════════════════════════════════════════════════════════════
// PROFILES
// ══════════════════════════════════════════════════════════════

export async function getProfile(userId: string): Promise<UserProfile | null> {
  const sb = await getClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error || !data) return null;
  return rowToProfile(data);
}

export async function updateProfile(userId: string, updates: Partial<{
  display_name: string;
  avatar_url: string;
}>) {
  const sb = await getClient();
  if (!sb) return { error: 'Supabase not configured' };
  const { error } = await sb
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId);
  return { error: error?.message || null };
}

// ══════════════════════════════════════════════════════════════
// ADMIN: User management
// ══════════════════════════════════════════════════════════════

export async function adminGetAllUsers(search?: string): Promise<UserProfile[]> {
  const sb = await getClient();
  if (!sb) return [];
  let query = sb.from('profiles').select('*').order('created_at', { ascending: false });
  if (search) {
    query = query.or(`email.ilike.%${search}%,display_name.ilike.%${search}%`);
  }
  const { data, error } = await query;
  if (error || !data) return [];
  return data.map(rowToProfile);
}

export async function adminChangePlan(
  targetUserId: string,
  plan: PlanType,
  role: UserRole,
  adminUserId: string
) {
  const sb = await getClient();
  if (!sb) return { error: 'Supabase not configured' };
  // Use DB function for lifetime grants
  if (plan === 'lifetime' || plan === 'founder') {
    const { error } = await sb.rpc('admin_grant_lifetime', {
      target_user_id: targetUserId,
      admin_user_id:  adminUserId,
      plan_type:      plan,
    });
    return { error: error?.message || null };
  }
  // Regular plan change
  const { error } = await sb
    .from('profiles')
    .update({
      plan,
      role,
      expires_at:  plan === 'free' ? null : new Date(Date.now() + 365*24*3600*1000).toISOString(),
      granted_by:  adminUserId,
      updated_at:  new Date().toISOString(),
    })
    .eq('id', targetUserId);
  // Audit log
  if (!error) {
    await sb.from('audit_logs').insert({
      actor_id:  adminUserId,
      action:    'CHANGE_PLAN',
      target_id: targetUserId,
      details:   `Plan changed to ${plan} / role ${role}`,
    });
  }
  return { error: error?.message || null };
}

export async function adminBanUser(targetUserId: string, ban: boolean, adminUserId: string) {
  const sb = await getClient();
  if (!sb) return { error: 'Supabase not configured' };
  const { error } = await sb
    .from('profiles')
    .update({ status: ban ? 'banned' : 'active', updated_at: new Date().toISOString() })
    .eq('id', targetUserId);
  if (!error) {
    await sb.from('audit_logs').insert({
      actor_id:  adminUserId,
      action:    ban ? 'BAN_USER' : 'UNBAN_USER',
      target_id: targetUserId,
      details:   ban ? '약관 위반으로 차단' : '차단 해제',
    });
  }
  return { error: error?.message || null };
}

// ══════════════════════════════════════════════════════════════
// INVITE CODES
// ══════════════════════════════════════════════════════════════

export async function redeemCode(code: string, userId: string) {
  const sb = await getClient();
  if (!sb) return { success: false, error: 'Supabase not configured' };
  const { data, error } = await sb.rpc('redeem_invite_code', {
    p_code: code,
    p_user_id: userId,
  });
  if (error) return { success: false, error: error.message };
  const d = data as any;
  return { success: d.success, plan: d.plan as PlanType | undefined, role: d.role as UserRole | undefined, error: d.error as string | undefined };
}

export async function adminGetCodes() {
  const sb = await getClient();
  if (!sb) return [];
  const { data } = await sb.from('invite_codes').select('*').order('created_at', { ascending: false });
  return data || [];
}

export async function adminCreateCode(code: {
  code: string; plan: PlanType; role: UserRole;
  uses_max: number | null; note: string; expires_at: string | null;
}, adminUserId: string) {
  const sb = await getClient();
  if (!sb) return { error: 'Supabase not configured' };
  const { error } = await sb.from('invite_codes').insert({
    ...code, created_by: adminUserId,
  });
  if (!error) {
    await sb.from('audit_logs').insert({
      actor_id: adminUserId, action: 'CREATE_INVITE_CODE',
      details: `Created code: ${code.code}`,
    });
  }
  return { error: error?.message || null };
}

export async function adminToggleCode(codeId: string, active: boolean, adminUserId: string) {
  const sb = await getClient();
  if (!sb) return { error: 'Supabase not configured' };
  const { error } = await sb.from('invite_codes').update({ active }).eq('id', codeId);
  return { error: error?.message || null };
}

// ══════════════════════════════════════════════════════════════
// AUDIT LOGS
// ══════════════════════════════════════════════════════════════

export async function getAuditLogs(limit = 50) {
  const sb = await getClient();
  if (!sb) return [];
  const { data } = await sb
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}
