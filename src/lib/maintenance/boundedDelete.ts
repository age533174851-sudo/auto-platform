// src/lib/maintenance/boundedDelete.ts
//
// COUNT와 DELETE는 별도 요청이다. 그 사이 오래된 행이 삽입되면
// DELETE .lt(cutoff)는 COUNT로 확인한 5,000건 상한을 넘을 수 있다.
// 삭제 전에 기본키 집합을 최대 eligible건으로 고정하고 그 집합만 삭제한다.
// 운영 DB 마이그레이션/보관 기간/삭제 상한 정책은 변경하지 않는다.
export const CLEANUP_PRIMARY_KEYS: Readonly<Record<string, string>> = {
  news_articles: 'hash',
  ai_usage: 'id',
  ai_cache: 'cache_key',
};

export interface BoundedCleanupDeleteResult {
  /** DELETE 결과를 증명할 수 없으면 null — 사전 COUNT로 대체하지 않는다. */
  deleted: number | null;
  error: string | null;
}

export async function deleteBoundedCleanupRows(
  sb: any,
  item: { table: string; column: string; cutoff: string },
  eligible: number,
  maxDeletePerRun: number,
): Promise<BoundedCleanupDeleteResult> {
  const pk = CLEANUP_PRIMARY_KEYS[item.table];
  if (!pk) return { deleted: 0, error: '삭제 대상 표의 기본키를 확인하지 못했습니다' };
  if (!Number.isSafeInteger(eligible) || eligible < 0 || eligible > maxDeletePerRun
    || !Number.isSafeInteger(maxDeletePerRun) || maxDeletePerRun < 1) {
    return { deleted: 0, error: '삭제 상한 검증 실패 — 삭제하지 않습니다' };
  }
  if (eligible === 0) return { deleted: 0, error: null };

  // 먼저 삭제할 ID를 고정한다. COUNT 이후 추가된 행은 ID 집합 밖이다.
  // PK 커서 페이지네이션으로 OFFSET 이동/중복 문제를 피한다.
  const ids: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  try {
    while (ids.length < eligible) {
      const take = Math.min(200, eligible - ids.length);
      let q = sb.from(item.table).select(pk)
        .lt(item.column, item.cutoff)
        .order(pk, { ascending: true })
        .limit(take);
      if (cursor !== null) q = q.gt(pk, cursor);
      const page = await q;
      if (page?.error || !Array.isArray(page?.data) || page.data.length > take) {
        return { deleted: 0, error: '삭제 대상 ID 조회 실패/불완전 — 삭제하지 않습니다' };
      }
      for (const row of page.data) {
        const id = row?.[pk];
        if (typeof id !== 'string' || !id || seen.has(id)) {
          return { deleted: 0, error: '삭제 대상 기본키 누락/중복 — 삭제하지 않습니다' };
        }
        ids.push(id);
        seen.add(id);
        cursor = id;
      }
      if (page.data.length < take) break;
    }
  } catch {
    return { deleted: 0, error: '삭제 대상 ID 조회 예외 — 삭제하지 않습니다' };
  }

  // 실제 DELETE는 고정된 ID 집합 + 기존 cutoff로 제한한다.
  // 100개씩 삭제해 URL 길이 제한을 피하고 반환된 PK로 실제 건수를 센다.
  let confirmed = 0;
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    try {
      const result = await sb.from(item.table).delete()
        .in(pk, batch).lt(item.column, item.cutoff).select(pk);
      if (result?.error || !Array.isArray(result?.data)) {
        return { deleted: null, error: `삭제 결과 미확인 (이전 배치 확인 ${confirmed}건)` };
      }
      const allowed = new Set(batch);
      const returned = new Set<string>();
      for (const row of result.data) {
        const id = row?.[pk];
        if (typeof id !== 'string' || !allowed.has(id) || returned.has(id)) {
          return { deleted: null, error: '삭제 결과 기본키가 요청 집합과 불일치합니다' };
        }
        returned.add(id);
      }
      confirmed += returned.size;
    } catch {
      return { deleted: null, error: `삭제 결과 조회 예외 (이전 배치 확인 ${confirmed}건)` };
    }
  }
  return { deleted: confirmed, error: null };
}
