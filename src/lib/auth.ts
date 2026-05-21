// ─────────────────────────────────────────────────────────────
// TRAIGO Auth System  (auth.ts)
// Types, roles, mock session, invite codes
// ─────────────────────────────────────────────────────────────

export type UserRole = 'user' | 'vip' | 'lifetime' | 'founder' | 'admin' | 'developer' | 'super_admin';
export type PlanType = 'free' | 'pro' | 'premium' | 'lifetime' | 'founder' | 'admin';
export type UserStatus = 'active' | 'banned' | 'suspended' | 'pending';
export type BadgeType = 'vip' | 'founder' | 'supporter' | 'lifetime' | 'admin' | 'early_bird';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  plan: PlanType;
  status: UserStatus;
  badges: BadgeType[];
  expiresAt: string | null;   // null = never
  grantedBy?: string | null;
  createdAt: string;
  lastSignIn?: string;
  avatarUrl?: string;
  inviteCode?: string;
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

// ── Password validation ───────────────────────────────────────
export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: '약함' | '보통' | '강함' | '매우 강함' | '';
  color: string;
  hints: string[];
  isValid: boolean;
}

export function checkPasswordStrength(password: string): PasswordStrength {
  const hints: string[] = [];
  let score = 0;

  if (password.length < 8) {
    hints.push('8자 이상 입력하세요');
  } else {
    score++;
  }
  if (!/[A-Z]/.test(password)) {
    hints.push('대문자를 포함하세요');
  } else {
    score++;
  }
  if (!/[a-z]/.test(password)) {
    hints.push('소문자를 포함하세요');
  } else {
    score++;
  }
  if (!/[0-9]/.test(password)) {
    hints.push('숫자를 포함하세요');
  } else {
    score++;
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    hints.push('특수문자(!@#$%)를 포함하세요');
  } else {
    score++;
  }

  // score 0-5 → map to 0-4
  const clampedScore = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const LABELS: PasswordStrength['label'][] = ['', '약함', '보통', '강함', '매우 강함'];
  const COLORS = ['', '#EF4444', '#F59E0B', '#10B981', '#3B82F6'];

  return {
    score: clampedScore,
    label: LABELS[clampedScore],
    color: COLORS[clampedScore],
    hints,
    isValid: score >= 3 && password.length >= 8,
  };
}

// ── Email validation ──────────────────────────────────────────
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ── Korean error messages ─────────────────────────────────────
export const AUTH_ERRORS: Record<string, string> = {
  'Invalid login credentials': '로그인 정보가 올바르지 않습니다.',
  'Email not confirmed': '이메일 인증이 필요합니다. 메일함을 확인하세요.',
  'User already registered': '이미 가입된 이메일입니다.',
  'Password should be at least 6 characters': '비밀번호는 6자 이상이어야 합니다.',
  'Unable to validate email address: invalid format': '이메일 형식이 올바르지 않습니다.',
  'Signup requires a valid password': '유효한 비밀번호를 입력하세요.',
  'Email rate limit exceeded': '잠시 후 다시 시도해주세요.',
  'Network request failed': '네트워크 오류가 발생했습니다.',
  'Failed to fetch': '서버에 연결할 수 없습니다.',
  'Supabase not configured': 'Supabase가 설정되지 않았습니다.',
  'default': '오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
};

export function getKoreanError(error: string): string {
  for (const [key, value] of Object.entries(AUTH_ERRORS)) {
    if (error.includes(key)) return value;
  }
  return AUTH_ERRORS.default;
}

// ── Role system ───────────────────────────────────────────────
export const ROLE_RANK: Record<UserRole, number> = {
  user: 0, vip: 1, lifetime: 2, founder: 3,
  admin: 4, developer: 5, super_admin: 6,
};

export const ROLE_INFO: Record<UserRole, { label: string; icon: string; color: string; desc: string }> = {
  user:        { label: '일반회원',  icon: '👤', color: '#94A3B8', desc: '기본 모의투자 이용' },
  vip:         { label: 'VIP',       icon: '⭐', color: '#F59E0B', desc: 'VIP 우선 지원' },
  lifetime:    { label: '평생회원',  icon: '♾️', color: '#F59E0B', desc: '평생 Pro 이용' },
  founder:     { label: '창업멤버',  icon: '🚀', color: '#EF4444', desc: '창업팀 특별 멤버' },
  admin:       { label: '관리자',    icon: '🛡️', color: '#10B981', desc: '사용자 관리 권한' },
  developer:   { label: '개발자',    icon: '⚙️', color: '#7C3AED', desc: '개발자 도구 접근' },
  super_admin: { label: '슈퍼관리자',icon: '👑', color: '#D97706', desc: '최고 관리자 권한' },
};

export const canAccessAdmin     = (role?: UserRole) => !!role && ROLE_RANK[role] >= ROLE_RANK.admin;
export const canAccessDeveloper = (role?: UserRole) => !!role && ROLE_RANK[role] >= ROLE_RANK.developer;
export const canAccessSuperAdmin= (role?: UserRole) => role === 'super_admin';
export const hasLifetimeAccess  = (p?: UserProfile) => !!(p && ['lifetime','founder','admin','developer','super_admin'].includes(p.role));

// ── Session storage key ───────────────────────────────────────
const SESSION_KEY = 'tg_mock_session_v2';

export function getMockSession(): UserProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setMockSession(user: UserProfile): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch {}
}

export function clearMockSession(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ── Mock data ─────────────────────────────────────────────────
export const MOCK_USERS: UserProfile[] = [
  { id:'usr_super', email:'super@traigo.app',  displayName:'슈퍼관리자', role:'super_admin', plan:'admin',    status:'active', badges:['admin'],   expiresAt:null, createdAt:'2024-01-01', lastSignIn:'방금' },
  { id:'usr_dev',   email:'dev@traigo.app',    displayName:'개발자',     role:'developer',   plan:'lifetime', status:'active', badges:['vip'],     expiresAt:null, createdAt:'2024-01-01', lastSignIn:'1분 전' },
  { id:'usr_admin', email:'admin@traigo.app',  displayName:'관리자',     role:'admin',       plan:'admin',    status:'active', badges:['admin'],   expiresAt:null, createdAt:'2024-01-01', lastSignIn:'5분 전' },
  { id:'usr_found', email:'founder@test.com',  displayName:'창업멤버',   role:'founder',     plan:'founder',  status:'active', badges:['founder','vip'], expiresAt:null, createdAt:'2024-11-01', lastSignIn:'1시간 전' },
  { id:'usr_vip',   email:'vip@test.com',      displayName:'VIP회원',    role:'vip',         plan:'pro',      status:'active', badges:['vip','early_bird'], expiresAt:'2025-12-31', createdAt:'2025-01-01', lastSignIn:'오늘' },
  { id:'usr_life',  email:'lifetime@test.com', displayName:'평생회원',   role:'lifetime',    plan:'lifetime', status:'active', badges:['lifetime'], expiresAt:null, createdAt:'2024-06-01', lastSignIn:'어제' },
  { id:'usr_user',  email:'user@test.com',     displayName:'테스트유저', role:'user',        plan:'free',     status:'active', badges:[],          expiresAt:null, createdAt:'2025-03-01', lastSignIn:'오늘' },
  { id:'usr_ban',   email:'banned@test.com',   displayName:'차단된유저', role:'user',        plan:'free',     status:'banned', badges:[],          expiresAt:null, createdAt:'2025-02-01', lastSignIn:'한달 전' },
];

export const MOCK_INVITE_CODES: InviteCode[] = [
  { id:'ic1', code:'FOUNDER-2026',    plan:'founder',  role:'founder',  usesMax:10,   usesCount:2, active:true,  createdBy:'super',  createdAt:'2024-11-01', expiresAt:null,           note:'창업멤버 초대' },
  { id:'ic2', code:'FRIEND-LIFETIME', plan:'lifetime', role:'lifetime', usesMax:null, usesCount:8, active:true,  createdBy:'super',  createdAt:'2025-01-01', expiresAt:null,           note:'지인 평생회원 (무제한)' },
  { id:'ic3', code:'DEV-ACCESS-2025', plan:'lifetime', role:'developer',usesMax:5,    usesCount:1, active:true,  createdBy:'super',  createdAt:'2025-02-01', expiresAt:'2025-12-31',  note:'개발자 테스트 접근' },
  { id:'ic4', code:'PRO-FRIEND-XYZ',  plan:'pro',      role:'user',     usesMax:null, usesCount:14,active:true,  createdBy:'admin',  createdAt:'2025-03-01', expiresAt:null,           note:'친구 Pro 초대 (무제한)' },
  { id:'ic5', code:'BETA-EXPIRED',    plan:'pro',      role:'user',     usesMax:50,   usesCount:50,active:false, createdBy:'admin',  createdAt:'2024-10-01', expiresAt:'2025-01-01',  note:'베타 테스터용 (만료)' },
];

export const MOCK_AUDIT_LOGS: AuditLog[] = [
  { id:'al1', actorId:'usr_super', actorEmail:'super@traigo.app', action:'GRANT_LIFETIME', targetId:'usr_found', targetEmail:'founder@test.com', details:'창업멤버 plan=founder 부여',    createdAt:'2025-05-13T09:32:00' },
  { id:'al2', actorId:'usr_admin', actorEmail:'admin@traigo.app', action:'BAN_USER',       targetId:'usr_ban',   targetEmail:'banned@test.com',  details:'약관 위반으로 계정 차단',       createdAt:'2025-05-12T18:00:00' },
  { id:'al3', actorId:'usr_admin', actorEmail:'admin@traigo.app', action:'CREATE_CODE',    details:'PRO-FRIEND-XYZ 코드 생성',                                                           createdAt:'2025-05-10T12:00:00' },
  { id:'al4', actorId:'usr_dev',   actorEmail:'dev@traigo.app',   action:'SYSTEM_CONFIG',  details:'기능 플래그 aiSignals=true 변경',                                                    createdAt:'2025-05-09T10:00:00' },
  { id:'al5', actorId:'usr_super', actorEmail:'super@traigo.app', action:'GRANT_LIFETIME', targetId:'usr_life',  targetEmail:'lifetime@test.com', details:'평생회원 plan=lifetime 부여', createdAt:'2025-04-01T09:00:00' },
];

// ── Mock auth functions ───────────────────────────────────────
export async function mockSignIn(
  email: string,
  password: string
): Promise<{ user: UserProfile | null; error: string | null }> {
  await new Promise(r => setTimeout(r, 600));
  const user = MOCK_USERS.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return { user: null, error: '로그인 정보가 올바르지 않습니다.' };
  if (user.status === 'banned') return { user: null, error: '차단된 계정입니다. 관리자에게 문의하세요.' };
  if (password.length < 4) return { user: null, error: '비밀번호를 확인해주세요.' };
  setMockSession(user);
  return { user, error: null };
}

export async function mockSignUp(
  email: string,
  password: string,
  displayName: string,
  inviteCode?: string
): Promise<{ user: UserProfile | null; error: string | null }> {
  await new Promise(r => setTimeout(r, 800));
  if (MOCK_USERS.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    return { user: null, error: '이미 가입된 이메일입니다.' };
  }
  const codeMatch = inviteCode
    ? MOCK_INVITE_CODES.find(c =>
        c.code.toUpperCase() === inviteCode.toUpperCase() && c.active &&
        (c.usesMax === null || c.usesCount < c.usesMax))
    : null;
  const user: UserProfile = {
    id: 'usr_' + Date.now().toString(36),
    email, displayName,
    role: codeMatch ? codeMatch.role : 'user',
    plan: codeMatch ? codeMatch.plan : 'free',
    status: 'active',
    badges: codeMatch ? (codeMatch.role !== 'user' ? [codeMatch.role as BadgeType] : []) : [],
    expiresAt: codeMatch && ['lifetime','founder'].includes(codeMatch.plan) ? null : null,
    createdAt: new Date().toISOString().split('T')[0],
    inviteCode: codeMatch?.code,
  };
  setMockSession(user);
  return { user, error: null };
}

export async function mockRedeemCode(
  code: string,
  userId: string
): Promise<{ success: boolean; plan?: PlanType; role?: UserRole; error?: string }> {
  await new Promise(r => setTimeout(r, 600));
  const found = MOCK_INVITE_CODES.find(c =>
    c.code.toUpperCase() === code.toUpperCase() && c.active &&
    (c.usesMax === null || c.usesCount < c.usesMax)
  );
  if (!found) return { success: false, error: '유효하지 않거나 사용 횟수가 초과된 코드입니다.' };
  return { success: true, plan: found.plan, role: found.role };
}

// ── Supabase SQL Schema reference ─────────────────────────────
export const SUPABASE_AUTH_SCHEMA = `
-- Run in Supabase SQL Editor after enabling Auth
-- See: supabase/schema.sql for full schema
`;
