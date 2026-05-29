// src/lib/auth/ensureAdmin.ts
// SERVER-ONLY — import from /api/... route handlers only.
//
// ADMIN_EMAILS 환경변수에 적힌 이메일로 가입한 사용자를 자동으로 admin 역할로 승급합니다.
// 동작:
// - 로그인/세션 확인 API 호출 시 1회 실행
// - email이 ADMIN_EMAILS 목록에 있고 role이 admin이 아니면 → role=admin으로 업데이트
// - 이미 admin/super_admin/developer면 변경 안 함
// - ADMIN_EMAILS가 없으면 no-op
import { getSupabaseAdmin } from '@/lib/supabase/server';

const ADMIN_ROLES = new Set(['admin', 'developer', 'super_admin']);

let cachedAdminEmails: Set<string> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 min — 환경변수 핫리로드 대비

/** ADMIN_EMAILS 환경변수를 파싱해서 normalized Set으로 반환. */
export function getAdminEmails(): Set<string> {
  const now = Date.now();
  if (cachedAdminEmails && now - cachedAt < CACHE_TTL_MS) return cachedAdminEmails;

  const raw = process.env.ADMIN_EMAILS || '';
  const set = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const e = part.trim().toLowerCase();
    if (e && e.includes('@')) set.add(e);
  }
  cachedAdminEmails = set;
  cachedAt = now;
  return set;
}

export function isEmailInAdminList(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().has(email.trim().toLowerCase());
}

/**
 * 주어진 이메일이 ADMIN_EMAILS 목록에 있으면 profiles.role을 admin으로 승급.
 * 반환: 승급되었거나 이미 admin이면 true.
 *
 * 안전:
 * - service_role 클라이언트로만 동작 (RLS 우회)
 * - 이미 admin/super_admin/developer면 건드리지 않음 (강등 방지)
 * - 클라이언트가 직접 호출할 수 없는 서버 전용 함수
 */
export async function ensureAdminFromEmails(
  userId: string,
  email: string | null | undefined,
): Promise<{ promoted: boolean; role: string | null }> {
  if (!email) return { promoted: false, role: null };
  if (!isEmailInAdminList(email)) return { promoted: false, role: null };

  const sb = getSupabaseAdmin();
  if (!sb) return { promoted: false, role: null };

  // 현재 role 조회
  const { data: current, error: readErr } = await sb
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (readErr || !current) {
    // profiles row가 아직 없으면 (트리거 누락 등) 생성
    // (기존 코드와 동일하게 Database 타입 정의 미동기화 우회)
    await (sb.from('profiles') as unknown as { upsert: (v: Record<string, unknown>, o: Record<string, unknown>) => Promise<unknown> })
      .upsert({ id: userId, email, role: 'admin' }, { onConflict: 'id' });
    return { promoted: true, role: 'admin' };
  }

  const role = String((current as { role?: string }).role || 'user');
  if (ADMIN_ROLES.has(role)) {
    // 이미 admin 등급이면 그대로
    return { promoted: false, role };
  }

  // 승급
  const { error: updErr } = await (sb.from('profiles') as unknown as { update: (v: Record<string, unknown>) => { eq: (k: string, v: string) => Promise<{ error: { message: string } | null }> } })
    .update({ role: 'admin' })
    .eq('id', userId);

  if (updErr) {
    console.warn('[ensureAdmin] update failed', updErr.message);
    return { promoted: false, role };
  }
  console.log(`[ensureAdmin] promoted ${email} (${userId}) to admin via ADMIN_EMAILS`);
  return { promoted: true, role: 'admin' };
}
