// src/lib/engine/pendingReconcileScan.ts
// Issue #453 — 대조 대상 조회를 500건에서 끊지 않고 안전하게 페이지로 훑는다.
// 순수 DB 경계 함수: 주문/키/운영 DB 쓰기 없이 Fake Supabase로 회귀 검증한다.
import type { PendingOrderRow } from './pendingReconcile';

export const PENDING_SCAN_PAGE_SIZE = 500;
export const PENDING_SCAN_MAX_PAGES = 20; // 한 크론 회차에 최대 10,000행 + 존재 검사
export type ScanError = 'query_failed' | 'invalid_page' | 'unstable_page' | 'scan_limit';

export interface PendingScanCursor { createdAt: string; id: string; }

export interface ScanPage {
  data: PendingOrderRow[] | null;
  error?: unknown;
}
export interface PendingScanResult {
  rows: PendingOrderRow[];
  complete: boolean;
  pages: number;
  error: ScanError | null;
}

/**
 * 읽기 전용 페이지 스캔. 호출자는 created_at ASC, id ASC와
 * 직전 커서보다 큰 행만 읽는 keyset 조건을 반드시 설정한다.
 * from/to는 요청 페이지 크기 계산용이며 DB OFFSET으로 사용하면 안 된다.
 * - 마지막 페이지가 딱 꽉 차면 다음 페이지로 끝을 확인한다.
 * - 실패·비배열·중복·역행·상한 초과를 정상적인 0건으로 바꾸지 않는다.
 * - OFFSET은 앞쪽 행 삭제 시 건너뛴 행을 감지할 수 없으므로 커서를 넘긴다.
 * - 중간 실패 시 partial rows를 반환하되 complete=false를 강제한다.
 *   호출자가 complete=false에서 주문 대조를 진행하면 안 된다.
 */
export async function scanPendingRows(
  read: (from: number, to: number, cursor: PendingScanCursor | null) => Promise<ScanPage>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<PendingScanResult> {
  const size = opts.pageSize ?? PENDING_SCAN_PAGE_SIZE;
  const cap = opts.maxPages ?? PENDING_SCAN_MAX_PAGES;
  const rows: PendingOrderRow[] = [];
  let pages = 0;
  const result = (complete: boolean, error: ScanError | null): PendingScanResult =>
    ({ rows, complete, pages, error });

  if (!Number.isSafeInteger(size) || size < 1 || size > 1000
      || !Number.isSafeInteger(cap) || cap < 1 || cap > 100) {
    return result(false, 'invalid_page');
  }

  const cursor = (): PendingScanCursor | null => {
    const last = rows[rows.length - 1];
    return last ? { createdAt: String(last.created_at), id: String(last.id).trim() } : null;
  };

  const seen = new Set<string>();
  let prevTime = -Infinity;
  let prevId = '';
  const accept = (page: PendingOrderRow[]): boolean => {
    for (const row of page) {
      // DB는 정렬된 id/timestamptz를 보낸다. 이 증거가 깨지면
      // OFFSET 페이지가 같은 행을 두 번 주거나 한 행을 건너뛸 수 있다.
      const id = String(row?.id ?? '').trim();
      const time = Date.parse(String(row?.created_at ?? ''));
      if (!id || !Number.isFinite(time) || seen.has(id)
          || time < prevTime || (time === prevTime && id <= prevId)) {
        return false;
      }
      seen.add(id);
      prevTime = time;
      prevId = id;
    }
    rows.push(...page);
    return true;
  };

  for (let index = 0; index < cap; index++) {
    let page: ScanPage;
    try {
      page = await read(index * size, (index + 1) * size - 1, cursor());
      pages++;
    } catch {
      pages++;
      return result(false, 'query_failed');
    }
    if (!page || page.error != null) return result(false, 'query_failed');
    if (!Array.isArray(page.data) || page.data.length > size) {
      return result(false, 'invalid_page');
    }
    if (!accept(page.data)) return result(false, 'unstable_page');
    if (page.data.length < size) return result(true, null);
  }

  // 최대 행 수에 딱 닿았다면 '정확히 끝'인지 '아직 남음'인지
  // 별도 1행 조회로 구별한다. 상한 초과는 HTTP 성공이 아니다.
  let tail: ScanPage;
  try {
    tail = await read(cap * size, cap * size, cursor());
    pages++;
  } catch {
    pages++;
    return result(false, 'query_failed');
  }
  if (!tail || tail.error != null) return result(false, 'query_failed');
  if (!Array.isArray(tail.data) || tail.data.length > 1) return result(false, 'invalid_page');
  return tail.data.length === 0 ? result(true, null) : result(false, 'scan_limit');
}
