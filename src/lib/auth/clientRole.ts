// src/lib/auth/clientRole.ts
//
// 화면에서 '내 role이 무엇인가'를 묻는 하나의 경로.
//
// 왜 공용으로 빼는가
// ──────────────────
// /admin은 서버에 물어보고 있었고 /developer는 localStorage를 읽고 있었다.
// 같은 질문에 두 개의 답이 있으면 둘 중 하나는 반드시 틀린다 — 이번에는
// /developer가 틀렸다. `tg_mock_session_v2`에 role만 바꿔 넣으면 화면이
// 열렸다. 그래서 묻는 방법을 한 곳으로 모았다.
//
// role은 어디서 오는가
// ────────────────────
// 반드시 서버다. 클라이언트가 들고 있는 값은 사용자가 고칠 수 있다.
//   1순위: /api/auth/me — JWT를 검증하고 DB의 role을 돌려준다.
//          ADMIN_EMAILS 자동 승급도 이 경로에서 일어난다
//   2순위: profiles 직접 조회 — RLS(자기 행만)로 보호된다. /api/auth/me가
//          죽었을 때 관리자가 아예 못 들어오는 것을 막기 위한 폴백이다
//
// 이 값으로 화면을 가리는 것은 **편의**다. 진짜 방어선은 둘이다:
//   - 미들웨어가 페이지 진입을 막는다 (lib/auth/adminGate.ts)
//   - API가 requireAdmin()으로 데이터를 막는다
// 화면 검사는 그 둘을 통과한 사람에게 올바른 UI를 보여주기 위한 것이고,
// 여기서 통과해도 데이터는 나오지 않는다.

export interface ClientRole {
  userId: string | null;
  /** 서버가 확인해 준 role. 확인 못 했으면 null */
  role: string | null;
  /** API 호출에 쓸 access token */
  token: string | null;
  email: string | null;
  displayName: string | null;
}

const NONE: ClientRole = {
  userId: null, role: null, token: null, email: null, displayName: null,
};

export async function getSessionAndRole(): Promise<ClientRole> {
  try {
    const { getSupabaseClient } = await import('../supabase/client');
    const sb = getSupabaseClient();
    if (!sb) return NONE;

    const { data: { session } } = await sb.auth.getSession();
    if (!session?.user) return NONE;

    const token = session.access_token;
    const userId = session.user.id;
    const email = session.user.email ?? null;

    // 1순위 — 서버가 검증하고 승급까지 처리한 결과
    try {
      const r = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const d = await r.json();
        return {
          userId: d?.user?.id ?? userId,
          role: d?.profile?.role ?? 'user',
          token,
          email: d?.user?.email ?? email,
          displayName: d?.profile?.display_name ?? null,
        };
      }
    } catch {
      /* 폴백으로 내려간다 */
    }

    // 2순위 — RLS로 자기 행만 읽는다
    const { data: profile } = await sb
      .from('profiles')
      .select('role, display_name')
      .eq('id', userId)
      .single();
    const p = profile as { role?: string; display_name?: string } | null;

    return {
      userId,
      // 조회가 실패하면 'user'로 본다. 여기서 관리자로 가정하면 조회 한 번
      // 실패할 때마다 관리 화면이 열린다.
      role: p?.role ?? 'user',
      token,
      email,
      displayName: p?.display_name ?? null,
    };
  } catch {
    return NONE;
  }
}
