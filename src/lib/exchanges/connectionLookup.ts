// src/lib/exchanges/connectionLookup.ts
//
// **연결을 못 읽은 것과 연결이 없는 것은 다른 사실이다.**
//
// 왜 이 파일이 필요한가
// ─────────────────────
// 라우트들이 연결을 이렇게 읽는다:
//
//   const { data: conn } = await sb.from('exchange_connections')
//     .select('*').eq('id', id).eq('user_id', uid).single();
//   if (!conn) return 404 connection_not_found;
//
// `error`를 아예 받지 않는다. 그래서 DB가 죽었든 권한이 막혔든 응답이
// 유실됐든 **전부 404 "연결이 없습니다"가 된다.** 호출자는 사용자가
// 연결을 지웠다고 읽고, 화면은 "연결을 추가하세요"를 띄운다. 실제로는
// 연결이 그대로 있고 우리가 읽지 못한 것이다.
//
// 킬스위치에서는 이것이 더 비싸다. `risk/kill-switch/trigger`가 404를
// 돌려주면 "그런 연결 없다"는 뜻이 되는데, 사실은 **중지 명령이
// 연결을 확인하지 못해 아무것도 하지 않은 것**이다. 아무것도 안 한 것을
// "대상이 없다"로 적으면 그 회차는 조용히 지나간다.
//
// 그래서 이 저장소 규칙이 그대로 적용된다 —
// **UNKNOWN을 0으로 적지 않는다. 확인하지 못한 것은 통과가 아니다.**
//
// 왜 판정을 한 곳에 두는가
// ────────────────────────
// 0행도 오류로 온다. Supabase `.single()`은 결과가 0행일 때 `error`에
// `PGRST116`을 담아 준다. 즉 **"오류가 있으면 못 읽은 것"이 아니다** —
// 0행 오류는 "없다"가 맞다. 이 한 줄의 구분을 라우트마다 손으로 쓰면
// 언젠가 한 곳이 갈린다. 실제로 `PGRST116`을 아는 곳은 지금 라우트
// 3개뿐이고 `src/lib`에는 0곳이다.
//
// `.single()`과 `.maybeSingle()`이 또 다르다:
//
//   .single()       0행 → data null + error PGRST116
//   .maybeSingle()  0행 → data null + error null
//
// 그래서 `data: null, error: null`의 뜻이 호출 모양에 따라 **반대가
// 된다.** `maybeSingle`이면 "없다"가 맞고, `single`이면 둘 다 비어 온
// 것이므로 **대답을 못 받은 것**이다 — 그것을 "없다"로 적지 않는다.
// 호출 모양을 인자로 받는 이유가 이것이다.

/** 0행을 뜻하는 PostgREST 코드. 이 코드만 "없다"로 읽는다 */
export const NO_ROWS_CODE = 'PGRST116';

export type ConnectionLookupKind = 'FOUND' | 'NOT_FOUND' | 'UNREADABLE';

/** 어떤 호출로 읽었는가 — `data: null, error: null`의 뜻이 이것으로 갈린다 */
export type LookupShape = 'single' | 'maybeSingle';

export interface ConnectionLookupVerdict {
  kind: ConnectionLookupKind;
  /** 응답에 쓸 HTTP 상태. **UNREADABLE은 404가 아니다** */
  status: 200 | 404 | 503;
  /** 응답 본문의 error 코드 */
  code: 'ok' | 'connection_not_found' | 'connection_unreadable';
  reason: string;
}

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const c = (error as { code?: unknown }).code;
  return typeof c === 'string' ? c : null;
}

/**
 * 연결 한 건 조회의 결과를 세 갈래로 가른다.
 *
 * **기본값이 NOT_FOUND가 될 수 없다.** 판단할 근거가 없으면 UNREADABLE이다.
 */
export function connectionLookupVerdict(input: {
  data: unknown;
  error?: unknown;
  shape: LookupShape;
}): ConnectionLookupVerdict {
  const shape = input?.shape === 'maybeSingle' ? 'maybeSingle' : 'single';
  const error = input?.error ?? null;
  const data = input?.data ?? null;

  // 행이 왔으면 찾은 것이다. 오류가 함께 와도 행이 진짜다 —
  // 다만 객체가 아니면 행으로 세지 않는다(문자열·숫자는 연결이 아니다).
  if (data !== null && typeof data === 'object') {
    return { kind: 'FOUND', status: 200, code: 'ok', reason: '연결을 읽었습니다' };
  }

  if (error !== null) {
    // 0행 오류만 "없다"다. 그 밖의 오류는 전부 "못 읽었다"다.
    if (codeOf(error) === NO_ROWS_CODE) {
      return { kind: 'NOT_FOUND', status: 404, code: 'connection_not_found',
        reason: '그 연결이 없습니다 (0행)' };
    }
    return { kind: 'UNREADABLE', status: 503, code: 'connection_unreadable',
      reason: '연결을 읽지 못했습니다 — 연결이 없다는 뜻이 아닙니다' };
  }

  // data·error 둘 다 비었다. 뜻이 호출 모양으로 갈린다.
  if (shape === 'maybeSingle') {
    return { kind: 'NOT_FOUND', status: 404, code: 'connection_not_found',
      reason: '그 연결이 없습니다 (0행)' };
  }
  return { kind: 'UNREADABLE', status: 503, code: 'connection_unreadable',
    reason: '조회가 행도 오류도 돌려주지 않았습니다 — 연결이 없다는 뜻이 아닙니다' };
}
