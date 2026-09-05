// 프로브 환경에서 **정본 로그인 경로**를 재현한다.
//
// 왜 이 파일이 있나
// ─────────────────
// 자동매매 카드는 토큰이 없으면 읽지 않는다 — 그게 계약이다. 그래서 화면을
// 상태별로 재현하려면 프로브도 로그인돼 있어야 한다.
//
// 처음에는 제품 코드에 `localStorage.sb_access_token` 대체 경로를 넣어
// 해결했다. 그건 잘못이다. 프로브를 돌리려고 **제품이 검증되지 않은 두 번째
// 인증 경로를 영구히 들고 있게** 되고, 정본 경로가 고장 나도 프로브는 계속
// 초록으로 나온다. 없애야 할 실패 지점을 자동화로 덮는 꼴이다.
//
// 그래서 제품이 아니라 **환경**을 바꾼다. 프로브 빌드에만 Supabase 설정을
// 주고(아래 PROBE_ENV), 브라우저에는 Supabase가 스스로 쓰는 저장소 키에
// 세션을 심는다. 화면은 평소와 똑같이 `lib/auth/authToken` →
// `getSupabaseClient().auth.getSession()`을 탄다 — 프로브용 분기가 없다.
//
// 나가는 요청은 없다
// ──────────────────
// `getSession()`은 만료 전이면 저장소 값을 그대로 돌려준다. 그래서 이 세션은
// 네트워크를 타지 않는다. 그래도 확실히 하려고 프로브는 이 호스트로 나가는
// 요청을 전부 막는다(blockAuthHost). 실제 Supabase 프로젝트를 가리키지 않는
// 이름이므로 막히지 않아도 나갈 곳이 없다.

/** 프로브 빌드에만 주는 값. 실제 프로젝트가 아니다 — 이름표일 뿐이다. */
export const PROBE_SUPABASE_URL = 'https://probe-local.supabase.co';
/**
 * anon 키 자리. Supabase는 형식만 보고 클라이언트를 만든다. 이 값은 어떤
 * 프로젝트에도 유효하지 않은 서명이라 **권한이 전혀 없다.**
 */
export const PROBE_SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
  + '.eyJyb2xlIjoiYW5vbiIsImlzcyI6InByb2JlLWxvY2FsIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjIwMDAwMDAwMDB9'
  + '.cHJvYmUtb25seS1ub3QtYS1yZWFsLXNpZ25hdHVyZQ';

/** 프로브 빌드에 넘길 환경변수. `{ ...process.env, ...PROBE_ENV }` */
export const PROBE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: PROBE_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: PROBE_SUPABASE_ANON,
};

/**
 * supabase-js가 세션을 넣는 키. 라이브러리가
 * `sb-${new URL(url).hostname.split('.')[0]}-auth-token`으로 만든다.
 * 여기서 직접 계산하므로 URL을 바꾸면 키도 같이 따라간다.
 */
export const PROBE_STORAGE_KEY =
  `sb-${new URL(PROBE_SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

const HOUR = 3600;

/** 저장소에 심을 세션. 만료가 한참 남아 있어 갱신 요청이 나가지 않는다. */
export function probeSession() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: 'probe.access.token',
    refresh_token: 'probe.refresh.token',
    token_type: 'bearer',
    expires_in: 24 * HOUR,
    expires_at: now + 24 * HOUR,
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      aud: 'authenticated', role: 'authenticated',
      email: 'probe@local.invalid',
      app_metadata: {}, user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  };
}

/**
 * 브라우저가 열리기 전에 세션을 심는다. `context.addInitScript(...)`에
 * 그대로 펼쳐 넣는다:
 *
 *   await ctx.addInitScript(seedAuthScript());
 */
export function seedAuthScript() {
  return {
    content: `(() => { try {
      localStorage.setItem(${JSON.stringify(PROBE_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(probeSession()))});
    } catch {} })();`,
  };
}

/** 이 호스트로는 아무것도 내보내지 않는다. */
export async function blockAuthHost(page) {
  await page.route('**://*.supabase.co/**', r => r.abort());
}

/**
 * 화면이 정말로 정본 경로에서 토큰을 얻었는가.
 *
 * 프로브가 상태를 못 그렸을 때 "로그인이 안 된 것"과 "화면이 잘못 그린 것"을
 * 구분하려면 이 확인이 필요하다. 여기서 실패하면 프로브 환경 문제다.
 */
export async function assertProbeSignedIn(page) {
  const t = await page.evaluate(k => {
    try { return !!JSON.parse(localStorage.getItem(k) || 'null')?.access_token; }
    catch { return false; }
  }, PROBE_STORAGE_KEY);
  if (!t) throw new Error('프로브 세션이 심어지지 않았다 — 이 결과는 화면 증거가 아니다');
}
