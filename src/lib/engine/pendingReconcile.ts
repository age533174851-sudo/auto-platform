// src/lib/engine/pendingReconcile.ts
//
// **응답을 못 받은 주문을 누가, 언제 확인하는가.**
//
// 무엇이 문제였나
// ───────────────
// executeOrder는 거래소 응답을 못 받으면 UNKNOWN으로 적고 **절대 재시도하지
// 않는다.** 그건 맞다 — 재시도하면 이미 체결된 주문 위에 하나 더 얹는다.
// 대신 나중에 대조해서 확정하기로 되어 있었다.
//
// 그 '나중에'가 `reconcilePendingOrders`인데, 부르는 곳이 둘뿐이었다:
//
//   · /api/orders/reconcile — **connectionId를 줘야** 실제 대조를 한다.
//     사람이 화면에서 눌러야 하는 것이고, 크론은 그 값을 모른다.
//   · /api/autotrade/exit-monitor — 크론이 **하루 한 번**(0 0 * * *).
//
// 그래서 00시 05분에 UNKNOWN이 된 주문은 **하루를 그대로 보낸다.** 그동안
// 벌어지는 일은 둘이다:
//
//   1. 거래소에는 포지션이 열려 있는데 앱은 모른다 → 손절이 안 걸린다
//   2. 체크리스트가 `unresolvedOrderCount > 0`으로 막는다 → 자동매매가 멎는다
//
// 둘째는 불편이지만 첫째는 사고다. **못 여는 것은 불편이고 못 닫는 것은
// 사고다.**
//
// 이 파일이 하는 일
// ─────────────────
// "지금 대조가 필요한 연결이 어디인가"를 정한다. 순수 함수라 테스트가
// 붙는다 — 크론 안에 이 판단을 적으면 아무도 확인할 수 없다.
//
// 왜 유예 시간이 필요한가
// ───────────────────────
// 방금 만들어진 주문은 **다른 요청이 아직 거래소 응답을 기다리는 중**일 수
// 있다. 그때 대조하면 "거래소에 없네 → 안 나갔다"로 확정하는데, 1초 뒤
// 체결 응답이 온다. 확정을 되돌릴 방법은 없다.

export type PendingStatus = 'SENT' | 'UNKNOWN' | 'INTENT';

export const PENDING_STATUSES: PendingStatus[] = ['SENT', 'UNKNOWN', 'INTENT'];

/**
 * 방금 만들어진 주문은 건드리지 않는다.
 *
 * 90초는 거래소 요청 타임아웃(보통 10~30초)과 재시도를 넉넉히 덮는 값이다.
 * 짧게 잡으면 진행 중인 요청을 앞질러 확정하고, 길게 잡으면 손절 없는
 * 포지션이 그만큼 오래 방치된다.
 */
export const DEFAULT_GRACE_MS = 90_000;

/** 한 번에 몇 개 연결까지. 서버리스 실행 시간 안에 끝나야 한다 */
export const DEFAULT_MAX_CONNECTIONS = 20;

export interface PendingOrderRow {
  id?: any;
  user_id?: any;
  connection_id?: any;
  status?: any;
  created_at?: any;
  symbol?: any;
}

export interface PendingTarget {
  connectionId: string;
  userId: string | null;
  /** 이 연결에 남은 미확정 주문 수 */
  count: number;
  /** 가장 오래된 것의 나이(ms) */
  oldestAgeMs: number;
}

/**
 * 지금 대조할 연결 목록. **오래된 것부터.**
 *
 * 새것부터 하면 상한(maxConnections)에 걸렸을 때 가장 오래 방치된 것이
 * 영영 뒤로 밀린다 — 그리고 그게 정확히 제일 위험한 것이다.
 */
export function pendingTargets(
  rows: PendingOrderRow[] | null | undefined,
  opts: { now: number; graceMs?: number; maxConnections?: number } = { now: 0 },
): PendingTarget[] {
  const now = Number(opts.now) || 0;
  const grace = Number.isFinite(opts.graceMs as number) ? (opts.graceMs as number) : DEFAULT_GRACE_MS;
  const cap = Number.isFinite(opts.maxConnections as number)
    ? (opts.maxConnections as number) : DEFAULT_MAX_CONNECTIONS;

  const byConn = new Map<string, PendingTarget>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const cid = String(r.connection_id ?? '').trim();
    // **연결을 모르면 대조하지 않는다.** 어느 키로 물어볼지 모르는 주문을
    // 아무 연결로나 물어보면, 그 거래소에 없다고 확정해 버린다.
    if (!cid) continue;
    if (!PENDING_STATUSES.includes(String(r.status ?? '').toUpperCase() as PendingStatus)) continue;

    const t = Date.parse(String(r.created_at ?? ''));
    // 시각을 못 읽으면 **유예를 지난 것으로 본다.** 여기서 건너뛰면
    // 시각이 깨진 행 하나가 영영 미확정으로 남아 자동매매를 계속 막는다.
    const age = Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
    if (age < grace) continue;

    const prev = byConn.get(cid);
    if (prev) {
      prev.count += 1;
      if (age > prev.oldestAgeMs) prev.oldestAgeMs = age;
      if (prev.userId == null && r.user_id) prev.userId = String(r.user_id);
    } else {
      byConn.set(cid, {
        connectionId: cid,
        userId: r.user_id ? String(r.user_id) : null,
        count: 1,
        oldestAgeMs: age,
      });
    }
  }

  return [...byConn.values()]
    .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs)
    .slice(0, Math.max(0, cap));
}

export interface ConnectionLike {
  id?: any;
  user_id?: any;
  exchange_id?: any;
  api_key?: any;
  api_secret_enc?: any;
  has_withdrawal?: any;
  is_testnet?: any;
  is_active?: any;
}

/**
 * 이 연결로 대조해도 되는가. 안 되면 **사유**를 돌려준다.
 *
 * null이면 진행. 문자열이면 건너뛴 이유이고, 그 이유는 응답에 적힌다 —
 * 조용히 건너뛰면 "대조했는데 아무것도 안 나왔다"와 구분되지 않는다.
 */
export function skipReason(conn: ConnectionLike | null | undefined): string | null {
  if (!conn) return '연결을 찾을 수 없습니다';
  if (conn.has_withdrawal) return '출금 권한이 있는 키입니다 — 자동 경로에서 쓰지 않습니다';
  if (!conn.api_key) return 'API 키가 없습니다';
  if (!conn.api_secret_enc) return '시크릿이 없습니다 — 복호화할 것이 없습니다';
  return null;
}

/**
 * 대조 결과 한 줄.
 *
 * `resolved`가 0인 것과 대조를 **못 한 것**은 다르다. 0은 "물어봤는데
 * 바뀐 게 없다"이고, error는 "물어보지 못했다"이다. 둘을 같게 적으면
 * 화면이 "대조 정상"이라고 말하는 동안 미확정이 계속 쌓인다.
 */
export interface ReconcileOutcome {
  connectionId: string;
  ok: boolean;
  skipped?: string;
  resolved?: number;
  checked?: number;
  error?: string;
}

/** 여러 연결의 결과를 사람이 읽을 한 줄로 */
export function summarizeOutcomes(list: ReconcileOutcome[]): string {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return '대조할 미확정 주문이 없습니다';
  const failed = arr.filter(o => !o.ok && !o.skipped).length;
  const skipped = arr.filter(o => o.skipped).length;
  const resolved = arr.reduce((a, o) => a + (Number(o.resolved) || 0), 0);
  const parts = [`연결 ${arr.length}개 · 확정 ${resolved}건`];
  if (skipped > 0) parts.push(`건너뜀 ${skipped}개`);
  // **실패를 뒤에 숨기지 않는다.** 앞줄만 읽는 사람이 많다.
  if (failed > 0) parts.unshift(`⚠️ 대조 실패 ${failed}개`);
  return parts.join(' · ');
}
