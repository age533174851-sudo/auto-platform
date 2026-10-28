// src/lib/engine/keysetScan.ts
//
// **목록을 끝까지 읽었다는 증거.**
//
// `select(...).limit(N)`은 N줄을 돌려주고 `error: null`을 준다. 그건
// "N줄이 전부다"라는 뜻이 아니다. **"지금 N줄 줬다"**는 뜻이다. 그 둘을
// 같은 것으로 읽으면 두 방향으로 틀린다:
//
//   · 잘린 뒤쪽을 "없다"로 읽으면 → 보호가 누락된다
//   · 잘린 기존 목록을 "비어 있다"로 읽으면 → 같은 일을 또 한다
//
// 두 번째가 더 비싸다. 킬스위치에서는 전량청산 잡이 둘이 된다.
//
// 왜 OFFSET이 아니라 커서인가
// ───────────────────────────
// `range(from, to)`는 읽는 중 앞쪽 행이 지워지면 **한 행을 건너뛴다.**
// 건너뛴 사실은 응답에 남지 않는다. 안정된 고유 키로 커서를 잡으면
// 앞쪽이 어떻게 바뀌어도 뒤쪽을 빠뜨리지 않는다.
//
// 상한에 닿으면 조용히 멈추지 않는다
// ──────────────────────────────────
// 메모리를 지키려면 페이지 수에 상한이 필요하다. 그런데 상한에서 그냥
// 끝내면 "읽었다"와 구별이 안 된다. 그래서 상한에 닿았을 때 **1행만 더**
// 물어서 '정확히 끝'과 '아직 남음'을 가른다.
//
// 이 저장소에 이미 같은 모양이 둘 더 있다 —
// `src/lib/autotrade/schedulePages.ts`(#434, OFFSET)와
// `src/lib/engine/pendingReconcileScan.ts`(#460, keyset). 둘 다 아직
// main에 없다. 셋이 main에 모이면 **하나로 합쳐야 한다.** 같은 판단이
// 세 곳에 있으면 언젠가 갈린다.

export type KeysetFailure =
  /** 조회가 오류를 돌려줬거나 던졌다 */
  | 'query_failed'
  /** 배열이 아니거나 요청한 크기보다 길다 */
  | 'invalid_page'
  /** 키가 비었거나 중복이거나 역행했다 — 커서를 믿을 수 없다 */
  | 'unstable_page'
  /** 페이지 상한에 닿았고 뒤에 아직 남아 있다 */
  | 'scan_limit';

export interface KeysetPage { data?: any; error?: any }

export interface KeysetResult<T> {
  /** 읽은 행. **`complete`가 false면 부분 목록이다** */
  rows: T[];
  /** 끝까지 읽었음을 증명했는가 */
  complete: boolean;
  pages: number;
  failure: KeysetFailure | null;
  /** 사람이 읽을 사유. 완전하면 null */
  reason: string | null;
}

const REASON: Record<KeysetFailure, string> = {
  query_failed: '페이지 조회가 실패했습니다',
  invalid_page: '페이지 응답이 배열이 아니거나 요청한 크기보다 깁니다',
  unstable_page: '페이지 키가 중복·역행해 커서를 신뢰할 수 없습니다',
  scan_limit: '페이지 상한에 닿아 목록의 끝을 확인하지 못했습니다',
};

/**
 * 안정된 고유 키 오름차순으로 전체 목록을 모은다.
 *
 * `read`는 반드시 **`order(key, asc).gt(key, cursor).limit(size)`** 계약을
 * 지켜야 한다. 첫 페이지는 `cursor === null`이다.
 *
 * 실패해도 **읽은 만큼은 돌려준다.** 다만 `complete`는 false다 — 호출자가
 * 그 값을 보고 "없다"를 말할지 정한다. 부분 목록을 완전한 목록으로
 * 둔갑시키지 않는 것이 이 함수의 전부다.
 */
export async function scanKeyset<T>(
  read: (cursor: string | null, size: number) => Promise<KeysetPage>,
  keyOf: (row: T) => string,
  opts: { pageSize: number; maxPages: number },
): Promise<KeysetResult<T>> {
  const size = opts.pageSize;
  const cap = opts.maxPages;
  const rows: T[] = [];
  let pages = 0;

  const done = (failure: KeysetFailure | null, detail?: string): KeysetResult<T> => ({
    rows, complete: failure == null, pages, failure,
    reason: failure == null ? null
      : `${REASON[failure]}${detail ? ` — ${detail}` : ''} (읽은 행 ${rows.length}, 페이지 ${pages})`,
  });

  if (!Number.isSafeInteger(size) || size < 1 || size > 1000
      || !Number.isSafeInteger(cap) || cap < 1 || cap > 1000) {
    return done('invalid_page', `페이지 설정이 올바르지 않습니다 (size ${size}, cap ${cap})`);
  }

  const seen = new Set<string>();
  let prevKey = '';
  let cursor: string | null = null;

  /** 페이지를 받아 누적한다. 키 증거가 깨지면 false */
  const accept = (page: T[]): boolean => {
    for (const row of page) {
      const key = keyOf(row);
      if (!key || seen.has(key) || key <= prevKey) return false;
      seen.add(key);
      prevKey = key;
    }
    rows.push(...page);
    cursor = prevKey;
    return true;
  };

  for (let i = 0; i < cap; i++) {
    let page: KeysetPage;
    try {
      page = await read(cursor, size);
      pages++;
    } catch (e: any) {
      pages++;
      return done('query_failed', String(e?.message ?? e));
    }
    if (!page || page.error != null) {
      return done('query_failed', String(page?.error?.message ?? page?.error ?? '응답 없음'));
    }
    if (!Array.isArray(page.data) || page.data.length > size) {
      return done('invalid_page', `받은 값: ${Array.isArray(page.data) ? `${page.data.length}행` : typeof page.data}`);
    }
    if (!accept(page.data as T[])) return done('unstable_page');
    // 꽉 차지 않았으면 **끝이다.** 여기서만 complete가 참이 된다.
    if (page.data.length < size) return done(null);
  }

  // 상한에 딱 닿았다. '정확히 끝'인지 '아직 남음'인지 1행으로 가른다.
  let tail: KeysetPage;
  try {
    tail = await read(cursor, 1);
    pages++;
  } catch (e: any) {
    pages++;
    return done('query_failed', String(e?.message ?? e));
  }
  if (!tail || tail.error != null) {
    return done('query_failed', String(tail?.error?.message ?? tail?.error ?? '응답 없음'));
  }
  if (!Array.isArray(tail.data) || tail.data.length > 1) return done('invalid_page');
  return tail.data.length === 0 ? done(null) : done('scan_limit');
}

/** `in(...)` 목록을 URL이 버틸 크기로 쪼갠다 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
