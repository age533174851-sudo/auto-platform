'use client';
//
// Supabase 세션의 access token을 쿠키로 복사한다.
//
// 왜 필요한가
// ───────────
// 미들웨어는 요청 쿠키만 볼 수 있고 localStorage는 볼 수 없다. Supabase
// 세션은 기본 설정에서 localStorage에 저장되므로, 그대로 두면 미들웨어가
// 로그인 여부를 판별할 방법이 없다 — 실제로 그래서 오랫동안 아무것도
// 막지 못했다.
//
// 왜 세션 전체를 쿠키로 옮기지 않는가
// ───────────────────────────────────
// 옮기려면 저장소 어댑터를 바꾸고(@supabase/ssr 또는 커스텀 storage),
// refresh token까지 쿠키에 담고, 4KB 제한 때문에 조각내야 한다. 로그인·
// 로그아웃·토큰 갱신 전부를 건드리는 작업이다. 지금 필요한 것은 '미들웨어가
// 누구인지 확인할 수 있는 값' 하나뿐이라, access token만 복사한다.
// 원본은 그대로 localStorage에 있고 인증 흐름은 손대지 않았다.
//
// 보안상 알아둘 것
// ────────────────
// 이 쿠키는 httpOnly가 아니다 — JS가 써야 하니 그럴 수 없다. 즉 XSS가 읽을
// 수 있는데, **같은 토큰이 이미 localStorage에 있으므로 XSS 관점에서 새로
// 열리는 구멍은 없다.**
//
// ⚠ API가 이 쿠키를 인증에 쓰기 시작하면 그 순간 CSRF 표면이 생긴다.
//   브라우저는 남의 사이트에서 시작된 요청에도 쿠키를 붙여 보내기 때문이다.
//   API는 계속 Authorization 헤더만 봐야 한다. 이 쿠키의 용도는 미들웨어의
//   화면 차단, 그 하나다.
import { useEffect } from 'react';
import { SESSION_COOKIE } from '@/lib/auth/adminGate';

interface MinimalSession {
  access_token?: string | null;
  /** epoch 초 */
  expires_at?: number | null;
}

function clearCookie() {
  document.cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function writeCookie(session: MinimalSession | null) {
  if (typeof document === 'undefined') return;

  const token = session?.access_token;
  if (!token) {
    // 로그아웃했거나 세션이 없다. 남겨 두면 만료된 토큰으로 계속 튕긴다.
    clearCookie();
    return;
  }

  // 쿠키 수명을 토큰 수명에 맞춘다. 더 길게 두면 이미 죽은 토큰이 남아
  // 미들웨어가 'expired'로 거절하고, 사용자는 로그인했는데 왜 튕기는지
  // 알 수 없다.
  const nowSec = Math.floor(Date.now() / 1000);
  const maxAge = (session?.expires_at ?? 0) - nowSec;
  if (maxAge <= 0) {
    clearCookie();
    return;
  }

  // SameSite=Strict가 아니라 Lax인 이유: Strict는 외부 링크로 /admin에
  // 직접 들어올 때 쿠키를 안 보낸다. 그러면 로그인한 관리자가 링크를
  // 눌렀을 때만 튕기고, 주소창에 직접 치면 통과한다 — 재현이 안 되는
  // 버그로 보인다. Lax는 최상위 GET 이동에는 쿠키를 보낸다.
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

export default function SessionCookieSync() {
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      // 동적 import — Supabase가 설정되지 않은 환경에서 이 컴포넌트가
      // 앱 첫 로드를 붙잡지 않게 한다.
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      const sb = getSupabaseClient();
      if (!sb || cancelled) return;

      // 이미 로그인된 상태로 새로고침한 경우 — 이벤트가 안 올 수 있으니
      // 현재 세션을 먼저 한 번 쓴다.
      try {
        const { data } = await sb.auth.getSession();
        if (!cancelled) writeCookie(data?.session ?? null);
      } catch {
        /* 세션을 못 읽으면 쿠키를 건드리지 않는다 */
      }
      if (cancelled) return;

      // 로그인·로그아웃·토큰 갱신을 모두 따라간다. 갱신(TOKEN_REFRESHED)을
      // 놓치면 1시간 뒤부터 관리자 화면이 조용히 막힌다.
      const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
        writeCookie(session ?? null);
      });
      unsubscribe = () => {
        try { sub.subscription.unsubscribe(); } catch { /* 이미 정리됐다 */ }
      };
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return null;
}
