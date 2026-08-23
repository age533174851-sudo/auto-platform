// src/lib/supabase/url.ts
//
// **서버가 쓸 Supabase URL을 고르는 곳은 여기 하나다.**
//
// 무엇이 틀렸었나
// ───────────────
// 두 곳이 서로 다른 규칙으로 골랐다.
//
//   getSupabaseAdmin()            NEXT_PUBLIC_SUPABASE_URL
//   /api/system/deployment 지문   SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL
//   /api/system/runtime-health    SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL
//   parityGate                    SUPABASE_URL || NEXT_PUBLIC_SUPABASE_URL
//
// 그래서 **화면에 뜨는 지문이 실제로 읽는 DB의 지문이 아니었다.**
//
// 이게 만든 상태가 정확히 이랬다: Fly 워커는 f469f8d로 돌면서
// `[heartbeat] ok ... target=1351b7`를 계속 찍고 있는데,
// `/api/system/deployment`는 같은 지문 1351b7을 보여 주면서
// `fly.lastSeen = 8/20` · `fly.sha = 3c46151` · `fly.alive = false`를
// 돌려줬다. 지문은 SUPABASE_URL에서 오고, 그 줄을 읽는 admin client는
// NEXT_PUBLIC_SUPABASE_URL로 접속했기 때문이다.
//
// **셋이 동시에 참이려면 쓰기는 성공하는데 다른 곳에 쓰고 있어야 한다.**
// 그 문장은 deployment 라우트 주석에 이미 적혀 있었다 — 그런데 그걸
// 확인하라고 만든 지문 자체가 다른 값을 보고 있었다.
//
// 같은 뿌리에서 나온 다른 증상: migrate 워크플로는 `SUPABASE_DB_URL`로
// psql을 붙어 "남음 0"이라 하고, `/api/system/deployment`는 admin
// client로 `schema_migrations`를 읽어 `pendingCount: 62`라고 한다.
// 두 숫자는 **서로 다른 데이터베이스의 사실**이다.
//
// 규칙
// ────
//   1. 서버는 canonical `SUPABASE_URL`을 먼저 쓴다.
//   2. 없으면 `NEXT_PUBLIC_SUPABASE_URL`로 내려간다 — **호환 목적의
//      명시적 fallback**이고, 어느 쪽을 썼는지 항상 같이 말한다.
//   3. 둘 다 있는데 **다르면 고르지 않는다.** URL_MISMATCH로 실패한다.
//
// 3번이 왜 실패인가
// ─────────────────
// 둘이 다르면 이 저장소의 어느 값도 믿을 수 없다. 한쪽을 골라 계속
// 돌면 **쓰기는 A로 가고 진단은 B를 말한다** — 지금 겪고 있는 바로 그
// 상태다. 조용히 한쪽을 고르는 것이 멈추는 것보다 나쁘다.
//
// 값은 절대 내보내지 않는다
// ─────────────────────────
// 밖으로 나가는 것은 지문 6자와 project ref뿐이다. project ref는
// `https://<ref>.supabase.co`의 `<ref>`로, Supabase가 공개 URL에 쓰는
// 값이라 비밀이 아니다. **6자 해시가 같다는 것만으로 같은 DB라고
// 단정하지 않기 위해** 같이 준다.

export type SupabaseUrlSource = 'SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_URL' | 'NONE';

export type SupabaseUrlCode =
  | 'OK'             // 하나를 골랐다
  | 'MISSING'        // 둘 다 없다
  | 'URL_MISMATCH'   // 둘 다 있는데 다르다 — **고르지 않는다**
  | 'INVALID';       // 고른 값이 URL이 아니다

export interface SupabaseUrlResolution {
  /** admin client가 실제로 쓸 값. 실패하면 null */
  url: string | null;
  source: SupabaseUrlSource;
  code: SupabaseUrlCode;
  message: string;
  /** 고른 URL의 지문. 값이 아니다 */
  fingerprint: string | null;
  /** `https://<ref>.supabase.co`의 `<ref>`. 비밀이 아니다 */
  projectRef: string | null;
  /** 두 이름이 각각 무엇을 가리켰나 — **지문과 ref만** */
  saw: {
    server: { fingerprint: string | null; projectRef: string | null } | null;
    public: { fingerprint: string | null; projectRef: string | null } | null;
  };
}

export interface UrlEnv {
  SUPABASE_URL?: string | null;
  NEXT_PUBLIC_SUPABASE_URL?: string | null;
}

/** 공백·줄바꿈·끝슬래시를 턴다. Vercel에서 흔한 함정이다 */
export function normalizeSupabaseUrl(raw: string | null | undefined): string {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

/**
 * 값을 보여주지 않고 같은 값인지만 말한다.
 *
 * `src/lib/system/fingerprint.ts`와 같은 방식(sha256 앞 6자)이다.
 * 여기서 다시 구현하지 않고 그쪽을 부른다 — 두 벌을 두면 언젠가 한쪽만
 * 바뀌고, 그러면 지문 대조 자체가 거짓말을 한다.
 */
import { fingerprintOf } from '../system/fingerprint';

/**
 * `https://abcdefgh.supabase.co` → `abcdefgh`
 *
 * 6자 해시가 같다는 것만으로 같은 DB라고 단정하지 않기 위해 쓴다.
 * 자체 호스팅이나 프록시 주소면 null이다 — **모르는 것을 지어내지 않는다.**
 */
export function supabaseProjectRef(url: string | null | undefined): string | null {
  const u = normalizeSupabaseUrl(url);
  if (!u) return null;
  try {
    const host = new URL(u).hostname;
    const m = /^([a-z0-9-]+)\.supabase\.(co|in|net)$/i.exec(host);
    return m ? m[1] : null;
  } catch { return null; }
}

function seen(raw: string | null | undefined) {
  const u = normalizeSupabaseUrl(raw);
  if (!u) return null;
  return { fingerprint: fingerprintOf(u), projectRef: supabaseProjectRef(u) };
}

/**
 * **서버용 Supabase URL을 고른다. 이 함수 하나만 쓴다.**
 *
 * 브라우저용(`NEXT_PUBLIC_SUPABASE_URL` + anon key)은 여기서 고르지
 * 않는다 — 그건 번들에 들어가는 값이고 목적이 다르다.
 */
export function resolveServerSupabaseUrl(env: UrlEnv): SupabaseUrlResolution {
  const server = normalizeSupabaseUrl(env.SUPABASE_URL);
  const pub = normalizeSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  const saw = { server: seen(server), public: seen(pub) };

  const fail = (code: SupabaseUrlCode, message: string): SupabaseUrlResolution => ({
    url: null, source: 'NONE', code, message, fingerprint: null, projectRef: null, saw,
  });

  if (!server && !pub) {
    return fail('MISSING', 'SUPABASE_URL도 NEXT_PUBLIC_SUPABASE_URL도 없습니다');
  }

  // **둘 다 있는데 다르면 고르지 않는다.**
  if (server && pub && server !== pub) {
    const a = saw.server!, b = saw.public!;
    const refNote = a.projectRef && b.projectRef
      ? ` (project ${a.projectRef} vs ${b.projectRef})`
      : '';
    return fail('URL_MISMATCH',
      `SUPABASE_URL과 NEXT_PUBLIC_SUPABASE_URL이 서로 다른 곳을 가리킵니다`
      + ` — 지문 ${a.fingerprint} vs ${b.fingerprint}${refNote}.`
      + ' 한쪽을 고르면 쓰기와 진단이 서로 다른 데이터베이스를 보게 되므로 고르지 않습니다.');
  }

  const url = server || pub;
  const source: SupabaseUrlSource = server ? 'SUPABASE_URL' : 'NEXT_PUBLIC_SUPABASE_URL';
  try { new URL(url); } catch {
    return fail('INVALID', `${source}이 URL 형식이 아닙니다 (값은 표시하지 않습니다)`);
  }

  return {
    url,
    source,
    code: 'OK',
    message: source === 'SUPABASE_URL'
      ? 'SUPABASE_URL을 씁니다'
      : 'SUPABASE_URL이 없어 NEXT_PUBLIC_SUPABASE_URL로 내려갔습니다 (호환 fallback)',
    fingerprint: fingerprintOf(url),
    projectRef: supabaseProjectRef(url),
    saw,
  };
}

/** 지금 프로세스의 환경으로 고른다 */
export function serverSupabaseUrl(): SupabaseUrlResolution {
  return resolveServerSupabaseUrl({
    SUPABASE_URL: process.env.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
}

/**
 * 진단이 보여줄 지문.
 *
 * **admin client가 실제로 고른 URL의 지문이다.** 고르지 못했으면 null —
 * 그때는 "확인 못 함"이지 "같음"이 아니다.
 */
export function serverSupabaseFingerprint(): string | null {
  return serverSupabaseUrl().fingerprint;
}

/**
 * 두 지문이 같은 DB를 가리키는가.
 *
 * **6자가 같다는 것만으로 단정하지 않는다.** ref를 둘 다 알면 ref로
 * 판단하고, 하나라도 모르면 `null`(모름)을 돌려준다.
 */
export function sameDatabase(
  a: { fingerprint: string | null; projectRef: string | null } | null,
  b: { fingerprint: string | null; projectRef: string | null } | null,
): boolean | null {
  if (!a || !b) return null;
  if (a.projectRef && b.projectRef) return a.projectRef === b.projectRef;
  if (a.fingerprint && b.fingerprint && a.fingerprint !== b.fingerprint) return false;
  // 지문만 같은 경우 — 같을 **가능성이 높다**는 것이지 확인된 것이 아니다.
  return null;
}
