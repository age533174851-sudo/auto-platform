// src/lib/engine/pendingReconcileScan.ts
// P1 #453: 미확정 주문 방문 대상 조회의 페이징 정본.
// 최초 RED 재현 단계. 뒤 페이지를 아직 보지 않는 기존 결함을 의도적으로 표현한다.
import type { PendingOrderRow } from './pendingReconcile';

export const PENDING_SCAN_PAGE_SIZE = 500;
export const PENDING_SCAN_MAX_PAGES = 20;
export type ScanError = 'query_failed' | 'invalid_page' | 'unstable_page' | 'scan_limit';

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
export async function scanPendingRows(
  read: (from: number, to: number) => Promise<ScanPage>,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<PendingScanResult> {
  const size = opts.pageSize ?? PENDING_SCAN_PAGE_SIZE;
  const page = await read(0, size - 1);
  return { rows: Array.isArray(page.data) ? page.data : [], complete: true, pages: 1, error: null };
}
