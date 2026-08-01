// src/lib/auth/authToken.ts
//
// **로그인 토큰을 한 번 읽고 끝내지 않는다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// 터미널은 화면이 뜰 때 `getSession()`으로 access token을 한 번 읽어
// 문자열로 들고 있었다. 그리고 **다시는 읽지 않았다.**
//
// Supabase의 access token은 기본 1시간짜리다. 라이브러리가 뒤에서
// 갱신해 주지만(autoRefreshToken), 갱신된 값은 새 세션 객체에 들어가지
// 이미 복사해 둔 문자열을 고쳐 주지는 않는다. 그래서 한 시간이 지나면
// 화면이 들고 있는 토큰만 죽은 것이 되고, 그때부터 모든 요청이 401이다.
//
// 사용자에게는 이렇게 보인다 — **"가만히 있었는데 로그아웃됐다."**
// 실제로는 로그아웃된 적이 없다. 세션은 살아 있고 화면만 옛 토큰을
// 들고 있다. 다시 로그인하면 낫는 이유도 그래서다(새 토큰을 다시 복사).
//
// 이 파일이 하는 일
// ─────────────────
// 토큰이 바뀔 때마다 알려준다. 세 군데를 본다:
//
//   1. onAuthStateChange — 로그인·로그아웃·TOKEN_REFRESHED
//   2. 화면이 다시 보일 때(visibilitychange) — 휴대폰에서 앱을 한참
//      뒤로 보내 두면 갱신 타이머가 안 돈다. 돌아왔을 때 한 번 확인한다.
//   3. 창에 포커스가 올 때 — 데스크톱에서 탭을 오래 두는 경우
//
// 2·3이 없으면 아침에 앱을 열자마자 401이 뜨고, 새로고침해야 낫는다.

const EMPTY = '';

/**
 * 지금 유효한 `Authorization` 헤더 값. 없으면 빈 문자열.
 *
 * `getSession()`은 만료됐으면 **갱신해서** 돌려준다. 그래서 요청 직전에
 * 부르는 것이 안전하고, 복사해 둔 값을 재사용하는 것이 위험하다.
 */
export async function readAuthToken(): Promise<string> {
  const r = await probeAuthToken();
  return r ?? EMPTY;
}

/**
 * 토큰을 확인한다. **셋을 구분한다.**
 *
 *   'Bearer …'  로그인돼 있다
 *   ''          확실히 로그인 안 돼 있다
 *   null        **확인하지 못했다** (갱신 요청이 네트워크에서 실패 등)
 *
 * 마지막이 중요하다. 못 읽은 것을 ''로 바꾸면 화면이 "로그아웃됨"으로
 * 그리고, 사용자는 멀쩡한 세션을 두고 다시 로그인한다 — 이 파일이 없애려는
 * 바로 그 증상이다. 지하철에서 잠깐 끊긴 것과 로그아웃은 다르다.
 */
export async function probeAuthToken(): Promise<string | null> {
  try {
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const sb = getSupabaseClient();
    // Supabase가 아예 설정 안 된 환경 — 여기서는 '로그인 없음'이 사실이다.
    if (!sb) return EMPTY;
    const { data, error } = await sb.auth.getSession();
    if (error) return null;
    const t = data?.session?.access_token;
    return t ? `Bearer ${t}` : EMPTY;
  } catch {
    return null;
  }
}

/**
 * 토큰을 계속 따라간다.
 *
 * 콜백은 **즉시 한 번** 불리고, 그 뒤로는 값이 바뀔 때만 불린다.
 * 같은 값으로 다시 부르지 않는 이유는 그때마다 리액트가 다시 그리고,
 * 그 렌더가 다시 요청을 내보내는 화면이 있기 때문이다.
 *
 * @returns 정리 함수
 */
export function watchAuthToken(onToken: (token: string) => void): () => void {
  let stopped = false;
  let last: string | null = null;
  let unsubscribe: (() => void) | null = null;

  const push = (t: string | null) => {
    if (stopped) return;
    // **확인하지 못했으면 아무것도 바꾸지 않는다.** 지난 값을 그대로 둔다.
    // null을 ''로 바꾸면 잠깐 끊긴 것이 로그아웃으로 보이고, 사용자는
    // 멀쩡한 세션을 두고 다시 로그인한다.
    if (t == null) return;
    if (t === last) return;
    last = t;
    onToken(t);
  };

  const recheck = () => { void probeAuthToken().then(push); };

  // 화면이 다시 보일 때·포커스가 올 때. 휴대폰에서 앱을 뒤로 보내 두면
  // 갱신 타이머가 안 돌아, 돌아왔을 때 확인하지 않으면 첫 요청이 401이다.
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    recheck();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', recheck);
  }

  (async () => {
    // 지금 값을 먼저 한 번. 이미 로그인된 상태로 새로고침하면 이벤트가
    // 안 올 수 있다.
    recheck();
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sb = getSupabaseClient();
      if (!sb || stopped) return;
      const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
        push(session?.access_token ? `Bearer ${session.access_token}` : EMPTY);
      });
      unsubscribe = () => { try { sub.subscription.unsubscribe(); } catch { /* 이미 정리됨 */ } };
    } catch { /* Supabase 없음 — 이벤트 없이 위의 한 번만 */ }
  })();

  return () => {
    stopped = true;
    unsubscribe?.();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('focus', recheck);
  };
}
