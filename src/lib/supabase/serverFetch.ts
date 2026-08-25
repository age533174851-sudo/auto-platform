// src/lib/supabase/serverFetch.ts
//
// **서버가 읽은 값이 사흘 전 것이면 안 된다.**
//
// 무엇이 있었나 (Production 실측으로 확정)
// ────────────────────────────────────────
// 2026-08-24, 같은 요청 안에서 **같은 admin client가** 이렇게 답했다:
//
//   기존 조회   .select('worker_id, last_seen, status, current_task, version')
//               → 2026-08-20T14:18:35 (사흘 전) · alive=false
//   컬럼 하나만 더한 조회
//               → 1초 전
//   같은 컬럼 + fetch에 cache:'no-store'
//               → 1초 전
//
//   → cacheProbe.code = FETCH_CACHE_STALE
//
// 그 전에 다른 원인은 전부 실측으로 배제됐다: 같은 프로젝트
// (sameProject=true) · service_role 키(kind=sb_secret) · RLS 아님
// (count=1, 최신 행 조회됨) · 워커 쓰기 정상(verdict=RECORDED).
//
// supabase-js는 PostgREST에 **GET**으로 간다. 컬럼 목록이 URL에 들어가므로
// 오래 쓰던 URL은 굳고 새 URL은 신선했다. **오래 안 바뀐 조회일수록
// 더 오래된 값을 준다** — 가장 신뢰하던 코드가 가장 크게 틀린다.
//
// 왜 여기서 고치나
// ────────────────
// 서버에서 Supabase 표를 읽는 자리가 265곳이다. 증상이 보인 한 곳의
// 컬럼 모양만 바꾸면 **그 자리만 낫고 264곳이 그대로 남는다.** 그리고
// 자동매매에서 낡은 값을 읽는다는 것은 이런 뜻이다:
//
//   닫은 포지션을 열려 있다고 읽는다      → 중복 청산
//   켠 킬스위치를 꺼져 있다고 읽는다      → 막아야 할 주문이 나간다
//   heartbeat가 낡아 죽은 것으로 본다     → 실제로 겪은 것
//
// 그래서 **client를 만드는 한 곳**에서 막는다.
//
// 범위 — 읽기만 건드린다
// ──────────────────────
// `cache`는 GET·HEAD에만 붙인다. 쓰기(POST/PATCH/DELETE)는 애초에
// 캐시 대상이 아니고, **쓰기 요청의 의미를 바꾸지 않는다**는 것이
// 이 파일의 약속이다. 그리고 호출부가 `cache`를 이미 정했으면 그것을
// 존중한다 — 여기서 남의 결정을 덮지 않는다.
//
// 무엇을 건드리지 않나
// ────────────────────
//   브라우저 client   `NEXT_PUBLIC_*` + anon 키. 목적이 다르고, 브라우저
//                     캐시는 이 문제와 무관하다
//   워커              Next 런타임 밖의 순수 Node다. 이 캐시가 없다

/** 이 요청이 읽기인가. 모르면 GET으로 본다 (fetch의 기본값이 GET이다) */
function isRead(input: any, init?: any): boolean {
  const m = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * 서버 전용 Supabase client에 물릴 fetch.
 *
 * **하는 일은 하나다** — 읽기 요청에 `cache: 'no-store'`를 붙인다.
 * 나머지(method · headers · body · signal · duplex …)는 손대지 않고
 * 그대로 넘긴다.
 *
 * `base`를 받는 이유는 테스트 때문이다. 실제로는 전역 `fetch`를 쓴다.
 */
export function noStoreServerFetch(base?: typeof fetch): typeof fetch {
  return ((input: any, init?: any) => {
    const f = base ?? fetch;
    // 쓰기는 그대로 보낸다. **의미를 바꾸지 않는다.**
    if (!isRead(input, init)) return f(input, init);
    // 호출부가 이미 정했으면 존중한다.
    if (init && typeof init === 'object' && 'cache' in init && init.cache != null) {
      return f(input, init);
    }
    return f(input, { ...(init || {}), cache: 'no-store' });
  }) as typeof fetch;
}

/**
 * 서버 전용 client 생성 옵션.
 *
 * `getSupabaseAdmin()`이 이것을 쓴다. **여기 있는 이유는 테스트다** —
 * `@supabase/supabase-js`를 부르지 않고도 "어떤 옵션으로 만드는가"를
 * 값으로 확인할 수 있어야 한다.
 */
export function adminClientOptions(base?: typeof fetch): {
  auth: { autoRefreshToken: boolean; persistSession: boolean };
  global: { fetch: typeof fetch };
} {
  return {
    // 서버에는 세션을 남기지 않는다 (기존 동작 그대로).
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: noStoreServerFetch(base) },
  };
}
