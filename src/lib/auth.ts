// ─────────────────────────────────────────────────────────────
// TRAIGO Auth System — Supabase-ready architecture
// ─────────────────────────────────────────────────────────────

export type UserRole =
  | 'user'
  | 'vip'
  | 'lifetime'
  | 'founder'
  | 'admin'
  | 'developer'
  | 'super_admin';

export type PlanType =
  | 'free'
  | 'pro'
  | 'premium'
  | 'lifetime'
  | 'founder'
  | 'admin';

export type UserStatus = 'active' | 'banned' | 'suspended' | 'pending';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  plan: PlanType;
  status: UserStatus;
  badges: string[];
  createdAt: string;
  lastSignIn?: string;
  grantedBy?: string;
  expiresAt?: string | null; // null = lifetime
  avatarUrl?: string;
}

export interface AuthSession {
  user: UserProfile | null;
  isLoading: boolean;
}

export interface InviteCode {
  id: string;
  code: string;
  plan: PlanType;
  role: UserRole;
  usesMax: number | null;
  usesCount: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  note: string;
}

export interface AuditLog {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetId?: string;
  targetEmail?: string;
  details: string;
  createdAt: string;
}

// ── Role hierarchy ────────────────────────────────────────────
export const ROLE_RANK: Record<UserRole, number> = {
  user: 0,
  vip: 1,
  lifetime: 2,
  founder: 3,
  admin: 4,
  developer: 5,
  super_admin: 6,
};

export const ROLE_INFO: Record<UserRole, { label: string; icon: string; color: string; badge: string }> = {
  user:        { label: '일반 사용자', icon: '👤', color: '#94A3B8', badge: '' },
  vip:         { label: 'VIP',         icon: '⭐', color: '#F59E0B', badge: 'VIP' },
  lifetime:    { label: '평생회원',    icon: '♾️', color: '#F59E0B', badge: '평생' },
  founder:     { label: '창업멤버',    icon: '🚀', color: '#EF4444', badge: '창업멤버' },
  admin:       { label: '관리자',      icon: '🛡️', color: '#10B981', badge: '관리자' },
  developer:   { label: '개발자',      icon: '⚙️', color: '#7C3AED', badge: 'DEV' },
  super_admin: { label: '슈퍼관리자',  icon: '👑', color: '#F59E0B', badge: 'SUPER' },
};

// ── Access helpers ────────────────────────────────────────────
export const canAccessAdmin = (role?: UserRole): boolean =>
  !!role && ROLE_RANK[role] >= ROLE_RANK['admin'];

export const canAccessDeveloper = (role?: UserRole): boolean =>
  !!role && (role === 'developer' || role === 'super_admin');

export const canAccessSuperAdmin = (role?: UserRole): boolean =>
  role === 'super_admin';

export const hasLifetimeAccess = (profile?: UserProfile | null): boolean =>
  !!profile && (
    profile.plan === 'lifetime' ||
    profile.plan === 'founder' ||
    profile.role === 'admin' ||
    profile.role === 'developer' ||
    profile.role === 'super_admin'
  );

// ── Mock session (localStorage-based, Supabase-replaceable) ──
const SESSION_KEY = 'tg_session_v2';

export function getMockSession(): UserProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Validate structure
    if (!parsed.id || !parsed.email || !parsed.role) return null;
    return parsed as UserProfile;
  } catch {
    return null;
  }
}

export function setMockSession(user: UserProfile): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch {}
}

export function clearMockSession(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ── Mock user database ────────────────────────────────────────
export const MOCK_USERS: UserProfile[] = [
  {
    id: 'usr_super', email: 'super@traigo.app', displayName: '슈퍼관리자',
    role: 'super_admin', plan: 'lifetime', status: 'active',
    badges: ['lifetime', 'founder'], createdAt: '2024-01-01',
    lastSignIn: '2025-05-13', expiresAt: null,
  },
  {
    id: 'usr_dev', email: 'dev@traigo.app', displayName: '개발자',
    role: 'developer', plan: 'lifetime', status: 'active',
    badges: ['lifetime'], createdAt: '2024-01-05',
    lastSignIn: '2025-05-13', expiresAt: null,
  },
  {
    id: 'usr_admin', email: 'admin@traigo.app', displayName: '관리자',
    role: 'admin', plan: 'lifetime', status: 'active',
    badges: ['lifetime'], createdAt: '2024-02-01',
    lastSignIn: '2025-05-12', expiresAt: null,
  },
  {
    id: 'usr_founder', email: 'founder@test.com', displayName: '창업멤버',
    role: 'founder', plan: 'founder', status: 'active',
    badges: ['founder', 'vip'], createdAt: '2024-03-01',
    lastSignIn: '2025-05-10', expiresAt: null,
  },
  {
    id: 'usr_vip', email: 'vip@test.com', displayName: 'VIP유저',
    role: 'vip', plan: 'premium', status: 'active',
    badges: ['vip'], createdAt: '2024-06-01',
    lastSignIn: '2025-05-09', expiresAt: '2025-12-31',
  },
  {
    id: 'usr_1', email: 'user1@test.com', displayName: '홍길동',
    role: 'user', plan: 'pro', status: 'active',
    badges: [], createdAt: '2025-01-15',
    lastSignIn: '2025-05-11', expiresAt: '2025-08-31',
  },
  {
    id: 'usr_2', email: 'user2@test.com', displayName: '이영희',
    role: 'user', plan: 'free', status: 'active',
    badges: [], createdAt: '2025-03-20',
    lastSignIn: '2025-05-08',
  },
  {
    id: 'usr_ban', email: 'banned@test.com', displayName: '차단된유저',
    role: 'user', plan: 'free', status: 'banned',
    badges: [], createdAt: '2025-02-01',
    lastSignIn: '2025-04-01',
  },
];

// ── Invite codes ──────────────────────────────────────────────
export const MOCK_INVITE_CODES: InviteCode[] = [
  {
    id: 'ic_founder', code: 'FOUNDER-2026', plan: 'founder', role: 'founder',
    usesMax: 10, usesCount: 1, active: true,
    createdBy: 'usr_super', createdAt: '2025-01-01', expiresAt: null,
    note: '창업멤버 초대 코드',
  },
  {
    id: 'ic_lifetime', code: 'FRIEND-LIFETIME', plan: 'lifetime', role: 'lifetime',
    usesMax: null, usesCount: 5, active: true,
    createdBy: 'usr_super', createdAt: '2025-01-01', expiresAt: null,
    note: '지인 평생회원 코드 (무제한)',
  },
  {
    id: 'ic_dev', code: 'DEV-ACCESS-2025', plan: 'lifetime', role: 'developer',
    usesMax: 5, usesCount: 2, active: true,
    createdBy: 'usr_super', createdAt: '2025-01-01', expiresAt: '2025-12-31',
    note: '개발자 테스트 접근',
  },
  {
    id: 'ic_pro', code: 'PRO-FRIEND-XYZ', plan: 'pro', role: 'user',
    usesMax: null, usesCount: 23, active: true,
    createdBy: 'usr_admin', createdAt: '2025-02-01', expiresAt: null,
    note: '친구 초대 Pro 코드',
  },
];

// ── Audit logs ────────────────────────────────────────────────
export const MOCK_AUDIT_LOGS: AuditLog[] = [
  {
    id: 'log_1', actorId: 'usr_super', actorEmail: 'super@traigo.app',
    action: 'GRANT_LIFETIME', targetId: 'usr_founder', targetEmail: 'founder@test.com',
    details: '창업멤버 평생 권한 부여', createdAt: '2025-05-10T09:00:00Z',
  },
  {
    id: 'log_2', actorId: 'usr_admin', actorEmail: 'admin@traigo.app',
    action: 'CHANGE_PLAN', targetId: 'usr_1', targetEmail: 'user1@test.com',
    details: 'free → pro 플랜 변경', createdAt: '2025-05-09T14:30:00Z',
  },
  {
    id: 'log_3', actorId: 'usr_super', actorEmail: 'super@traigo.app',
    action: 'CREATE_INVITE_CODE', details: 'FOUNDER-2026 코드 생성', createdAt: '2025-05-08T11:00:00Z',
  },
  {
    id: 'log_4', actorId: 'usr_admin', actorEmail: 'admin@traigo.app',
    action: 'BAN_USER', targetId: 'usr_ban', targetEmail: 'banned@test.com',
    details: '약관 위반으로 차단', createdAt: '2025-04-01T16:00:00Z',
  },
];

// ── Mock auth functions (replace with Supabase) ───────────────
export async function mockSignIn(email: string, password: string): Promise<{ user: UserProfile | null; error: string | null }> {
  await new Promise(r => setTimeout(r, 800)); // simulate network
  const user = MOCK_USERS.find(u => u.email === email);
  if (!user) return { user: null, error: '이메일 또는 비밀번호가 올바르지 않습니다.' };
  if (user.status === 'banned') return { user: null, error: '차단된 계정입니다. 관리자에게 문의하세요.' };
  // In mock mode, any password works for demo
  if (password.length < 4) return { user: null, error: '비밀번호를 입력하세요.' };
  setMockSession({ ...user, lastSignIn: new Date().toISOString() });
  return { user, error: null };
}

export async function mockSignUp(email: string, password: string, displayName: string): Promise<{ user: UserProfile | null; error: string | null }> {
  await new Promise(r => setTimeout(r, 800));
  if (MOCK_USERS.find(u => u.email === email)) {
    return { user: null, error: '이미 가입된 이메일입니다.' };
  }
  if (password.length < 8) return { user: null, error: '비밀번호는 8자 이상이어야 합니다.' };
  const newUser: UserProfile = {
    id: 'usr_' + Date.now().toString(36),
    email, displayName,
    role: 'user', plan: 'free', status: 'active',
    badges: [], createdAt: new Date().toISOString().split('T')[0],
    lastSignIn: new Date().toISOString(),
  };
  setMockSession(newUser);
  return { user: newUser, error: null };
}

export async function mockRedeemCode(code: string, userId: string): Promise<{ success: boolean; plan?: PlanType; role?: UserRole; error?: string }> {
  await new Promise(r => setTimeout(r, 600));
  const found = MOCK_INVITE_CODES.find(c => c.code.toUpperCase() === code.toUpperCase() && c.active);
  if (!found) return { success: false, error: '유효하지 않은 코드입니다.' };
  if (found.usesMax !== null && found.usesCount >= found.usesMax) return { success: false, error: '사용 횟수가 초과된 코드입니다.' };
  if (found.expiresAt && new Date(found.expiresAt) < new Date()) return { success: false, error: '만료된 코드입니다.' };
  return { success: true, plan: found.plan, role: found.role };
}

// ── Supabase SQL schema (reference) ──────────────────────────
export const SUPABASE_AUTH_SCHEMA = `
-- profiles table (extends auth.users)
create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text unique not null,
  display_name text,
  role        text default 'user',
  plan        text default 'free',
  status      text default 'active',
  badges      text[] default '{}',
  expires_at  timestamptz,
  granted_by  uuid references profiles(id),
  avatar_url  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- invite_codes table
create table if not exists invite_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  plan        text not null,
  role        text default 'user',
  uses_max    int,
  uses_count  int default 0,
  active      boolean default true,
  created_by  uuid references profiles(id),
  created_at  timestamptz default now(),
  expires_at  timestamptz,
  note        text
);

-- audit_logs table
create table if not exists audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references profiles(id),
  action      text not null,
  target_id   uuid references profiles(id),
  details     text,
  metadata    jsonb,
  created_at  timestamptz default now()
);

-- RLS policies
alter table profiles enable row level security;

create policy "Users can read own profile"
  on profiles for select using (auth.uid() = id);

create policy "Admins can read all profiles"
  on profiles for select using (
    exists (select 1 from profiles where id = auth.uid() and role in ('admin','developer','super_admin'))
  );
`;
