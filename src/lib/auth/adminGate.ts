// src/lib/auth/adminGate.ts
//
// /admin · /developer 화면을 **서버에서** 막는 판단.
//
// 왜 필요한가
// ───────────
// 지금까지 이 두 화면의 문지기는 브라우저 안에만 있었다. 특히 /developer는
// localStorage의 JSON 하나(`tg_mock_session_v2`)를 읽어 role을 봤다 — 콘솔에서
// 한 줄로 바꿀 수 있는 값이다. 데이터는 API의 requireAdmin()이 막고 있었지만,
// 화면은 열렸다. "잠긴 줄 알았는데 안 잠긴" 상태가 제일 나쁘다. 문이 없는
// 것보다 나쁘다 — 없으면 조심하지만, 있으면 잠겼다고 믿는다.
//
// 판단을 왜 순수 함수로 빼는가
// ────────────────────────────
// 미들웨어는 테스트하기 어려운 자리다 (Edge 런타임, 요청 객체, 리다이렉트).
// 그래서 '누구를 통과시킬지'만 여기로 떼어내 테스트를 붙였다. 미들웨어가 하는
// 일은 쿠키를 꺼내고 리다이렉트하는 것뿐이다.
//
// role을 토큰에서 읽지 않는 이유
// ──────────────────────────────
// JWT의 payload는 서명 검증 없이 누구나 만들 수 있다. base64 한 번이면
// `{"role":"super_admin"}`이 된다. 그래서 여기서 디코드해 쓰는 값은 `sub`와
// `exp` 둘뿐이고, 그것도 **네트워크를 부를 필요조차 없는 경우를 미리 걸러내기
// 위해서만** 쓴다. 권한은 반드시 Supabase가 서명을 검증한 뒤 돌려준 role로만
// 정한다 (아래 lookupRole).
//
// 조회에 실패하면 통과시키지 않는다
// ─────────────────────────────────
// Supabase가 느리거나 죽었을 때 열어 주면, 장애 시간 동안 관리자 화면이 전부
// 열린다. 잠금장치가 정전에 풀리면 그건 잠금장치가 아니다. 대신 관리자가
// 잠깐 못 들어오는 쪽을 택했다 — 화면 2개고, API는 어차피 따로 막혀 있다.

import { ROLE_RANK, type UserRole } from '../auth';

/**
 * 미들웨어가 읽는 쿠키 이름.
 *
 * 왜 쿠키가 필요한가: Supabase 세션은 localStorage에 있고 미들웨어는 그걸 볼
 * 수 없다. 그래서 클라이언트가 access token을 이 쿠키로 **복사**한다
 * (components/auth/SessionCookieSync.tsx). 원본은 그대로 localStorage다 —
 * 로그인 흐름을 건드리지 않기 위해서다.
 *
 * 이 쿠키는 httpOnly가 아니다 (JS가 써야 하므로). 즉 XSS가 읽을 수 있는데,
 * 같은 토큰이 이미 localStorage에 있어 XSS 관점에서 새로 열리는 구멍은 없다.
 *
 * ⚠ API가 이 쿠키를 인증에 쓰면 안 된다. API는 계속 Authorization 헤더만
 *   본다. 쿠키를 받기 시작하면 그 순간 CSRF 표면이 생긴다 — 브라우저는
 *   남의 사이트에서 온 요청에도 쿠키를 붙여 보내기 때문이다.
 */
export const SESSION_COOKIE = 'tg_at';

/** 이 화면에 들어가려면 최소 어떤 role이어야 하는가 */
export type GateArea = 'admin' | 'developer';

/**
 * 화면별 최소 role.
 *
 * `developer`가 `admin`보다 높다 (ROLE_RANK: admin 4 < developer 5). 그래서
 * admin 계정은 /developer에 못 들어간다 — 기존 canAccessDeveloper()와 같은
 * 기준이다. 두 곳의 기준이 다르면 화면과 미들웨어가 서로 다른 말을 한다.
 */
export const AREA_MIN_ROLE: Record<GateArea, UserRole> = {
  admin: 'admin',
  developer: 'developer',
};

export type DenyReason =
  /** 쿠키가 없다 — 로그인 안 했거나, 쿠키 동기화가 아직 안 돌았다 */
  | 'no_token'
  /** 토큰 모양이 JWT가 아니거나 sub/exp를 읽을 수 없다 */
  | 'bad_token'
  /** 만료된 토큰 — 네트워크를 부르지 않고 여기서 끝낸다 */
  | 'expired'
  /** Supabase가 토큰을 거부했다 (서명 위조·폐기) */
  | 'unverified'
  /** 토큰은 유효한데 profiles 행이 없다 */
  | 'no_profile'
  /** role이 부족하거나 모르는 값이다 */
  | 'insufficient_role'
  /** 조회 자체를 못 했다 (네트워크·타임아웃·설정 없음) */
  | 'lookup_failed';

/**
 * 판별 유니온(`{allow:true}|{allow:false,reason}`)으로 쓰지 않는 이유:
 * 이 프로젝트는 tsconfig가 `strict:false`라 그 형태의 narrowing이 동작하지
 * 않는다. `if(!d.allow) d.reason` 이 타입 에러가 된다. 타입을 예쁘게 만들고
 * 쓰는 곳마다 캐스팅하는 것보다, 설정에 맞는 모양을 쓴다.
 */
export interface GateDecision {
  allow: boolean;
  role: UserRole | null;
  /** allow=false일 때만 채워진다 */
  reason?: DenyReason;
}

/** 쿠키가 없거나 만료돼 '다시 로그인'이 답인 경우 */
export function needsLogin(reason: DenyReason): boolean {
  return reason === 'no_token' || reason === 'bad_token' || reason === 'expired' || reason === 'unverified';
}

// ── 토큰 디코드 (검증 아님) ───────────────────────────────────
export interface TokenClaims {
  sub: string;
  /** epoch 초 */
  exp: number;
}

/**
 * JWT payload에서 sub·exp만 꺼낸다. **서명을 검증하지 않는다.**
 *
 * 여기서 나온 값으로 권한을 정하면 안 된다. 쓰임은 둘뿐이다:
 *   1. 만료된 토큰을 네트워크 없이 걸러내기
 *   2. profiles 조회의 필터로 쓸 id 얻기 (위조해도 RLS가 0행을 돌려준다)
 *
 * sub이나 exp가 없으면 null이다 — '모르면 통과 못 한다'.
 */
export function readClaims(token: string | null | undefined): TokenClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const raw = b64 + pad;
    // Edge 런타임에는 atob이 있고 Node 테스트에는 Buffer가 있다.
    const json =
      typeof atob === 'function'
        ? atob(raw)
        : Buffer.from(raw, 'base64').toString('binary');
    const p = JSON.parse(json) as { sub?: unknown; exp?: unknown };
    const sub = typeof p.sub === 'string' ? p.sub : '';
    const exp = typeof p.exp === 'number' ? p.exp : 0;
    if (!sub || !exp) return null;
    return { sub, exp };
  } catch {
    return null;
  }
}

/**
 * 만료 여부.
 *
 * skewSec은 시계 오차 보정이 **아니라 반대 방향**이다 — 곧 만료될 토큰을
 * 미리 만료로 본다. 검증 중에 만료되면 Supabase가 401을 돌려주는데, 그건
 * '위조'와 같은 응답이라 구분이 안 된다. 미리 걸러 이유를 정확히 남긴다.
 */
export function isExpired(claims: TokenClaims, nowSec: number, skewSec = 5): boolean {
  return claims.exp <= nowSec + skewSec;
}

// ── role로 통과 판정 ──────────────────────────────────────────
/**
 * 서버가 확인해 준 role만 넣어야 한다. 클라이언트가 준 값을 넣으면 이 함수는
 * 아무것도 막지 못한다.
 */
export function decideByRole(area: GateArea, role: string | null | undefined): GateDecision {
  if (!role) return { allow: false, reason: 'no_profile', role: null };

  const rank = ROLE_RANK[role as UserRole];
  // 모르는 role 문자열 — 오타든 새로 생긴 역할이든 통과시키지 않는다.
  // 여기서 '일단 통과'를 택하면 role 하나 추가할 때 조용히 문이 열린다.
  if (typeof rank !== 'number') return { allow: false, reason: 'insufficient_role', role: null };

  if (rank < ROLE_RANK[AREA_MIN_ROLE[area]]) {
    return { allow: false, reason: 'insufficient_role', role: role as UserRole };
  }
  return { allow: true, role: role as UserRole };
}

// ── Supabase에 role을 물어본다 ────────────────────────────────
export interface RoleLookup {
  ok: boolean;
  role: string | null;
  reason?: DenyReason;
}

export interface LookupOptions {
  token: string;
  userId: string;
  supabaseUrl: string;
  anonKey: string;
  /** 테스트에서 바꿔 끼운다 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * profiles.role을 PostgREST로 읽는다.
 *
 * 이 한 번의 호출이 두 가지를 동시에 한다:
 *   1. **서명 검증** — PostgREST는 서명이 틀린 JWT에 401을 준다. 그래서
 *      별도의 /auth/v1/user 호출이 필요 없다 (왕복 하나를 아낀다).
 *   2. **권한 확인** — RLS(profiles_self_read: auth.uid() = id)가 걸려 있어
 *      남의 행은 애초에 읽히지 않는다. 토큰의 sub을 위조해 다른 id로
 *      필터해도 0행이 돌아온다.
 *
 * service role 키를 쓰지 않는 이유: 여기서는 필요가 없고, 미들웨어에 최고
 * 권한 키를 들고 다닐 이유도 없다. 사용자 자기 토큰으로 자기 행만 읽는다.
 */
export async function lookupRole(opts: LookupOptions): Promise<RoleLookup> {
  const { token, userId, supabaseUrl, anonKey, timeoutMs = 4000 } = opts;
  const doFetch = opts.fetchImpl ?? fetch;

  const url =
    `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/profiles` +
    `?select=role&id=eq.${encodeURIComponent(userId)}&limit=1`;

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      // 미들웨어는 모든 /admin 요청 앞에 선다. 여기서 오래 매달리면
      // 화면이 아니라 '느린 앱'으로 보인다.
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch {
    // 타임아웃·네트워크 실패. 통과시키지 않는다.
    return { ok: false, role: null, reason: 'lookup_failed' };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, role: null, reason: 'unverified' };
  }
  if (!res.ok) {
    // 500·503 등 — 확인을 못 한 것이다. '문제없음'이 아니다.
    return { ok: false, role: null, reason: 'lookup_failed' };
  }

  let rows: unknown;
  try {
    rows = await res.json();
  } catch {
    return { ok: false, role: null, reason: 'lookup_failed' };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, role: null, reason: 'no_profile' };
  }
  const role = (rows[0] as { role?: unknown })?.role;
  if (typeof role !== 'string' || !role) {
    return { ok: false, role: null, reason: 'no_profile' };
  }
  return { ok: true, role };
}

// ── 미들웨어가 부르는 하나의 입구 ─────────────────────────────
export interface GateRequest {
  area: GateArea;
  token: string | null;
  nowSec: number;
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 쿠키에서 꺼낸 토큰 하나로 통과 여부를 정한다.
 *
 * 순서가 중요하다 — 싸고 확실한 거절을 먼저 한다. 만료된 토큰으로
 * Supabase를 부르는 것은 왕복만 낭비하고 결과도 덜 정확하다(401이 위조와
 * 구분되지 않는다).
 */
export async function gateRequest(req: GateRequest): Promise<GateDecision> {
  if (!req.supabaseUrl || !req.anonKey) {
    // 설정이 없으면 role을 확인할 방법이 없다. 그러면 열지 않는다.
    return { allow: false, reason: 'lookup_failed', role: null };
  }
  if (!req.token) return { allow: false, reason: 'no_token', role: null };

  const claims = readClaims(req.token);
  if (!claims) return { allow: false, reason: 'bad_token', role: null };
  if (isExpired(claims, req.nowSec)) return { allow: false, reason: 'expired', role: null };

  const lookup = await lookupRole({
    token: req.token,
    userId: claims.sub,
    supabaseUrl: req.supabaseUrl,
    anonKey: req.anonKey,
    fetchImpl: req.fetchImpl,
    timeoutMs: req.timeoutMs,
  });
  if (!lookup.ok) {
    return { allow: false, reason: lookup.reason ?? 'lookup_failed', role: null };
  }

  return decideByRole(req.area, lookup.role);
}
