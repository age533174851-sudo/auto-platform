// src/lib/supabase/cacheProbe.ts
//
// **같은 client가 같은 표를 읽는데 한 질의만 사흘 전 값을 준다.**
//
// 2026-08-24 Production 실측:
//
//   serviceKey    kind=sb_secret · role=service_role      → 권한 문제 아님
//   visibility    count=1 · recent[0].ageSec=1            → 최신 줄이 보인다
//   lookup        found=true · lastSeen=13:34:12.286Z     → 콕 집어도 보인다
//   그런데 fly    lastSeen=2026-08-20T14:18:35 · alive=false
//
// **같은 요청 안에서 같은 `sb`가** 한 질의에서는 8/20을, 다른 질의에서는
// 1초 전을 돌려준다. 그러면 남는 차이는 하나뿐이다 — **질의의 모양**.
//
//   기존   .select('worker_id, last_seen, status, current_task, version')
//   신규   .select('worker_id, last_seen, version, provider, machine_id')
//
// supabase-js는 PostgREST에 GET으로 간다. 컬럼 목록이 URL에 들어가므로
// **두 질의는 서로 다른 URL**이고, URL 단위로 캐시되는 무엇이 있다면
// 정확히 이 모양이 된다 — 오래 쓰던 URL은 굳고, 새 URL은 신선하다.
//
// **그래도 단정하지 않는다.**
//
// 이 라우트에는 이미 `dynamic = 'force-dynamic'`가 있다. 문서대로라면
// 그것만으로도 데이터 캐시를 우회해야 한다. 그러니 "캐시다"라고 적기
// 전에 **세 팔로 재 본다**:
//
//   A 기존 질의        건드리지 않는다 (증상이 여기 있다)
//   B 같은 뜻 · 다른 URL  컬럼 하나만 더한다
//   C no-store 강제     fetch에 cache:'no-store'를 준 client로 같은 질의
//
//   A만 낡고 B·C가 최신   → FETCH_CACHE_STALE (URL 단위 캐시)
//   A·B 낡고 C만 최신     → NO_STORE_ONLY (URL을 바꿔도 안 깨지는 캐시)
//   셋 다 최신            → FRESH (이 순간엔 재현되지 않았다)
//   셋 다 낡음            → NOT_CACHE (캐시가 아니라 다른 원인이다)
//
// 판정은 여기 있고 테스트가 붙는다. 라우트는 사실만 모은다.

/** 한 팔의 관측 결과. **못 읽었으면 lastSeen이 null이다** */
export interface ProbeArm {
  /** 이 팔이 돌긴 했는가 */
  ran: boolean;
  lastSeen: string | null;
  error: string | null;
}

export type CacheCode =
  | 'FETCH_CACHE_STALE' // 기존 URL만 굳었다 — URL을 바꾸면 신선하다
  | 'NO_STORE_ONLY'     // URL을 바꿔도 굳어 있고 no-store만 뚫는다
  | 'FRESH'             // 셋 다 최신 — 지금은 재현되지 않았다
  | 'NOT_CACHE'         // 셋 다 낡았다 — 캐시가 아니다
  | 'UNVERIFIED';       // 비교할 만큼 못 읽었다. **아니라는 뜻이 아니다**

export interface CacheProbeVerdict {
  code: CacheCode;
  /** 각 팔의 나이(초). 못 읽었으면 null */
  ageSec: { baseline: number | null; variantUrl: number | null; noStore: number | null };
  headline: string;
  nextStep: string;
}

/** 시각 → 나이(초). 못 읽으면 null */
function ageOf(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

/**
 * 판정. **순수 함수.**
 *
 * `freshWithinSec`보다 어리면 신선한 것으로 본다. 워커는 1분마다 쓰므로
 * 넉넉히 잡아도 사흘 전 값과 헷갈릴 일은 없다.
 */
export function cacheProbeVerdict(i: {
  baseline: ProbeArm;
  variantUrl: ProbeArm;
  noStore: ProbeArm;
  nowMs: number;
  freshWithinSec?: number;
}): CacheProbeVerdict {
  const within = i.freshWithinSec ?? 600;
  const a = ageOf(i.baseline.lastSeen, i.nowMs);
  const b = ageOf(i.variantUrl.lastSeen, i.nowMs);
  const c = ageOf(i.noStore.lastSeen, i.nowMs);
  const ageSec = { baseline: a, variantUrl: b, noStore: c };

  const fresh = (n: number | null) => n != null && n <= within;
  const stale = (n: number | null) => n != null && n > within;

  // **못 읽은 것은 낡은 것이 아니다.** 비교가 성립하지 않으면 UNVERIFIED다.
  if (a == null || (b == null && c == null)) {
    return {
      code: 'UNVERIFIED', ageSec,
      headline: '비교할 만큼 읽지 못했습니다 — 캐시가 아니라는 뜻이 아닙니다',
      nextStep: '각 팔의 error를 보세요. 못 읽은 것과 낡은 것은 다른 사실입니다.',
    };
  }

  if (stale(a) && fresh(b)) {
    return {
      code: 'FETCH_CACHE_STALE', ageSec,
      headline: '기존 질의만 낡았고 컬럼 하나만 바꾼 같은 질의는 최신입니다 — URL 단위로 굳어 있습니다',
      nextStep: '증상이 있는 SELECT 한 곳의 모양만 바꾸면 그 자리만 낫고 다른 곳에서 다시 납니다.'
        + ' 서버 client의 fetch에 no-store를 주는 쪽을 검토하세요.',
    };
  }

  if (stale(a) && stale(b) && fresh(c)) {
    return {
      code: 'NO_STORE_ONLY', ageSec,
      headline: 'URL을 바꿔도 낡았고 no-store를 준 질의만 최신입니다',
      nextStep: 'URL 모양으로는 깨지지 않는 캐시입니다 — 서버 client의 fetch에 no-store가 필요합니다.',
    };
  }

  if (stale(a) && stale(b) && stale(c)) {
    return {
      code: 'NOT_CACHE', ageSec,
      headline: '세 팔이 모두 낡았습니다 — 캐시가 아닙니다',
      nextStep: '캐시 가설을 접고 다른 원인을 봐야 합니다. 표에 실제로 최신 줄이 있는지부터 다시 확인하세요.',
    };
  }

  if (fresh(a)) {
    return {
      code: 'FRESH', ageSec,
      headline: '기존 질의도 최신입니다 — 이 순간에는 재현되지 않았습니다',
      nextStep: '재현되지 않은 것은 고쳐진 것과 다릅니다. 증상이 다시 보이면 이 값을 함께 보세요.',
    };
  }

  return {
    code: 'UNVERIFIED', ageSec,
    headline: '어느 쪽으로도 확정할 수 없는 조합입니다',
    nextStep: '각 팔의 나이와 error를 그대로 보세요.',
  };
}

/**
 * **캐시를 타지 않는 fetch.**
 *
 * Next.js는 서버의 `fetch`를 감싸 데이터 캐시를 붙인다. supabase-js는
 * 그 `fetch`로 PostgREST에 GET을 보내므로, 아무것도 지정하지 않으면
 * 그 캐시의 대상이 될 수 있다.
 *
 * `cache: 'no-store'`는 그 요청 하나를 캐시에서 빼는 표준 방법이다.
 *
 * **이 함수는 아직 운영 경로에 붙이지 않는다.** A/B의 대조군으로만
 * 쓴다 — 캐시가 원인이라고 확정된 뒤에 붙일지 정한다.
 */
export function noStoreFetch(base?: typeof fetch): typeof fetch {
  const f = base ?? fetch;
  return ((input: any, init?: any) => f(input, { ...(init || {}), cache: 'no-store' })) as typeof fetch;
}
