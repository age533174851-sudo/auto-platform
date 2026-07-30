// src/lib/auth/ensureAdmin.ts
// SERVER-ONLY — import from /api/... route handlers only.
//
// 환경변수에 적힌 이메일로 가입한 사용자를 자동으로 승급합니다.
// 동작:
// - 로그인/세션 확인 API 호출 시 1회 실행 (/api/auth/me)
// - email이 목록에 있고 현재 등급이 더 낮으면 → 그 등급으로 올림
// - 이미 같거나 더 높으면 **건드리지 않음** (강등 없음)
// - 목록이 비어 있으면 no-op
//
// 왜 목록이 세 개인가
// ───────────────────
// 예전에는 `ADMIN_EMAILS` 하나였고 언제나 `admin`만 줬다. 그런데 권한은
// admin(4) < developer(5) < super_admin(6) 순서라(lib/auth.ts ROLE_RANK),
// `/developer`는 developer 이상이라야 열린다(adminGate의 AREA_MIN_ROLE).
// 즉 **소유자 본인도 환경변수만으로는 `/developer`에 못 들어갔다.**
// DB에서 직접 UPDATE하는 것 말고는 방법이 없었고, 그건 문서에만 적혀 있었다.
//
// 그래서 목표 등급별로 목록을 나눈다. 한 이메일이 여러 목록에 있으면
// **가장 높은 등급**을 준다.
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { UserRole } from '../auth';
import { buildPromotionMap, shouldPromote } from './promotionMap';

let cached: Map<string, UserRole> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000; // 1 min — 환경변수 핫리로드 대비

/**
 * 이메일 → 줄 등급. 여러 목록에 있으면 가장 높은 것.
 *
 * 만드는 규칙은 promotionMap.ts(순수)에 있고 테스트가 붙어 있다.
 * 여기서는 env를 읽어 넣고 결과를 잠깐 캐시할 뿐이다.
 */
export function getPromotionMap(): Map<string, UserRole> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
  cached = buildPromotionMap(name => process.env[name]);
  cachedAt = now;
  return cached;
}

/** 예전 이름 유지 — 호출부(`/api/auth/me`)를 건드리지 않기 위해서다 */
export function getAdminEmails(): Set<string> {
  return new Set(getPromotionMap().keys());
}

export function isEmailInAdminList(email: string | null | undefined): boolean {
  if (!email) return false;
  return getPromotionMap().has(email.trim().toLowerCase());
}

/** 이 이메일에 주기로 한 등급. 목록에 없으면 null */
export function targetRoleFor(email: string | null | undefined): UserRole | null {
  if (!email) return null;
  return getPromotionMap().get(email.trim().toLowerCase()) ?? null;
}

/**
 * 이메일이 승급 목록에 있으면 profiles.role을 그 등급으로 올림.
 * 반환: 이번에 올렸으면 promoted=true. 이미 같거나 높으면 false.
 *
 * 안전:
 * - service_role 클라이언트로만 동작 (RLS 우회)
 * - **올리기만 한다.** 현재 등급이 목표보다 높으면 그대로 둔다 —
 *   환경변수를 잘못 고쳐서 super_admin이 admin으로 내려가면 안 된다
 * - 클라이언트가 직접 호출할 수 없는 서버 전용 함수
 */
export async function ensureAdminFromEmails(
  userId: string,
  email: string | null | undefined,
): Promise<{ promoted: boolean; role: string | null }> {
  const target = targetRoleFor(email);
  if (!target) return { promoted: false, role: null };

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
      .upsert({ id: userId, email, role: target }, { onConflict: 'id' });
    return { promoted: true, role: target };
  }

  const role = String((current as { role?: string }).role || 'user');
  // 올릴지 말지는 순수 함수가 판단한다 (강등 금지·모르는 등급 보호 포함).
  const verdict = shouldPromote(role, target);
  if (!verdict.promote) {
    if (verdict.reason.includes('알 수 없는')) console.warn(`[ensureAdmin] ${verdict.reason}`);
    return { promoted: false, role };
  }

  const { error: updErr } = await (sb.from('profiles') as unknown as { update: (v: Record<string, unknown>) => { eq: (k: string, v: string) => Promise<{ error: { message: string } | null }> } })
    .update({ role: target })
    .eq('id', userId);

  if (updErr) {
    console.warn('[ensureAdmin] update failed', updErr.message);
    return { promoted: false, role };
  }
  console.log(`[ensureAdmin] promoted ${email} (${userId}) ${role} → ${target}`);
  return { promoted: true, role: target };
}
