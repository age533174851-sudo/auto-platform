// src/lib/auth/sessionLogVerdict.ts
//
// **「현재 세션」 판정을 한 곳에 둔다.**
//
// `/api/auth/session-log`가 네 자리에서 `error`를 버리고 있었다. 그중 둘은
// 단순 기록이 아니라 **판단**이고, 못 읽은 것을 단정하면 사용자가 잘못 믿는다.
//
// ① 기존 세션 조회 (POST)
//    실패하면 `data`가 null이다. 그것을 "행이 없음"으로 읽으면 **신규 INSERT
//    경로**로 간다. `user_login_sessions`에는 `(user_id, session_token)` 유일
//    제약이 없다(`003_login_sessions.sql` — 인덱스만). 그래서 **중복 행이
//    조용히 생기고**, 로그인 기록에 같은 기기가 두 줄로 보인다. 한 줄을
//    종료해도 다른 줄은 살아 있는 것으로 남는다.
//
//    → 못 읽었으면 `UNREADABLE`이다. 신규로 넘어가지 않는다.
//      (POST 실패는 호출 쪽이 이미 삼킨다 — `useProfile.ts`의
//       `.catch(() => {})`. 그래서 멈추는 쪽이 로그인 흐름을 깨지 않는다.)
//
// ② 현재 세션 여부 조회 (DELETE)
//    실패하면 예전 코드는 `isCurrent = false`로 단정하고
//    「다른 기기는 다음 토큰 갱신 시점에 자동으로 로그아웃됩니다」를 답했다.
//    **자기 현재 세션을 끊은 사용자가 그 말을 믿고 로그아웃을 안 한다.**
//
//    → 못 읽었으면 `null`이고, 안내는 **안전한 쪽**으로 한다 —
//      "이 기기에서도 로그아웃해 주세요".
//      못 여는 것은 불편이고 로그인이 남아 있는 것은 사고다.

export type ExistingVerdict = 'UPDATE' | 'INSERT' | 'UNREADABLE';

/** 기존 세션 행이 있는가 — **못 읽은 것을 "없음"으로 적지 않는다** */
export function existingSessionVerdict(
  r: { row: { id?: string } | null; failed: boolean },
): ExistingVerdict {
  if (r.failed) return 'UNREADABLE';
  return r.row?.id ? 'UPDATE' : 'INSERT';
}

/** 끊은 세션이 지금 쓰는 세션인가 — **못 읽었으면 null이고 안전한 쪽을 안내한다** */
export function currentSessionNote(
  r: { row: { is_current?: boolean } | null; failed: boolean },
): { isCurrent: boolean | null; note: string } {
  if (r.failed) {
    return {
      isCurrent: null,
      note: '세션을 종료 표시했습니다. 다만 이것이 지금 쓰는 세션인지 '
        + '확인하지 못했습니다 — 안전하게 이 기기에서도 로그아웃해 주세요.',
    };
  }
  const isCurrent = !!r.row?.is_current;
  return {
    isCurrent,
    note: isCurrent
      ? '현재 세션 표시를 종료했습니다. 실제 로그아웃은 클라이언트에서 별도로 진행해주세요.'
      : '세션이 종료 표시되었습니다. 다른 기기는 다음 토큰 갱신 시점에 자동으로 로그아웃됩니다.',
  };
}
