// src/lib/portfolio/snapshotPlan.ts
//
// **표는 있는데 채우는 코드가 없었다.**
//
// `account_equity_snapshots`(마이그레이션 048)는 자산 곡선을 그리려고
// 만든 표다. 그런데 저장소 전체를 뒤져도 **여기에 INSERT하는 곳이
// 하나도 없다.** 그래서 지갑의 곡선은 구조적으로 영원히 비어 있었다.
//
// 화면 쪽은 정직했다 — 없는 값을 그리지 않고 "아직 없습니다"라고 적었다.
// 다만 아무리 기다려도 생기지 않는다는 사실은 아무도 몰랐다.
//
// 왜 순수 함수로 나누나
// ─────────────────────
// **언제 찍을지**와 **무엇을 찍을지**는 값으로 확인할 수 있어야 한다.
// 너무 자주 찍으면 표가 부풀고, 너무 성기면 곡선이 계단이 된다.
// 그리고 **못 읽은 값을 0으로 찍으면 곡선이 바닥으로 떨어져서**
// 사용자는 그 시각에 전액을 잃은 줄 안다 — 그건 되돌릴 수 없는 기록이다.

/** 얼마나 자주 찍는가. 곡선의 최소 해상도다 */
export const SNAPSHOT_INTERVAL_MS = 15 * 60_000;

export type SnapshotSkip =
  /** 아직 간격이 안 됐다 */
  | 'TOO_SOON'
  /** 자산을 못 읽었다. **0으로 찍지 않는다** */
  | 'EQUITY_UNKNOWN'
  /** 이 환경에 연결된 계좌가 없다 */
  | 'NO_ACCOUNT';

export interface SnapshotVerdict {
  /** 지금 찍어야 하는가 */
  take: boolean;
  code: 'TAKE' | SnapshotSkip;
  reason: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 지금 이 환경의 자산을 찍을 차례인가.
 *
 * **못 읽은 자산을 찍지 않는다.** 그게 이 함수의 핵심이다 —
 * NULL 행을 남기면 곡선에 구멍이 나고, 0을 남기면 곡선이 바닥으로
 * 떨어진다. 둘 다 사실이 아니고, 기록은 되돌릴 수 없다.
 *
 * **마지막 시각을 못 읽으면 찍는다.** 안 찍으면 영원히 안 찍힌다 —
 * 지금까지가 정확히 그 상태였다.
 */
export function snapshotVerdict(i: {
  nowMs: number;
  lastTakenMs: number | null;
  /** 이 환경의 연결 수 */
  connections: number;
  /** 지금 읽은 자산. **못 읽었으면 null** */
  totalEquity: number | null;
  intervalMs?: number;
}): SnapshotVerdict {
  const interval = num(i.intervalMs) ?? SNAPSHOT_INTERVAL_MS;

  if (!(Number(i.connections) > 0)) {
    return { take: false, code: 'NO_ACCOUNT',
      reason: '이 환경에 연결된 계좌가 없습니다 — 찍을 자산이 없습니다' };
  }
  if (num(i.totalEquity) == null) {
    // **여기서 0을 찍으면 그래프가 바닥으로 떨어진다.**
    return { take: false, code: 'EQUITY_UNKNOWN',
      reason: '자산을 읽지 못했습니다 — 0으로 찍지 않습니다. 다음 주기에 다시 시도합니다' };
  }

  const last = num(i.lastTakenMs);
  // 못 읽었으면 찍는다. 안 찍으면 영원히 안 찍힌다.
  if (last == null) {
    return { take: true, code: 'TAKE', reason: '첫 기록입니다' };
  }
  const waited = Number(i.nowMs) - last;
  if (waited < interval) {
    return { take: false, code: 'TOO_SOON',
      reason: `${Math.ceil((interval - waited) / 60_000)}분 뒤에 다시 찍습니다` };
  }
  return { take: true, code: 'TAKE', reason: `${Math.round(waited / 60_000)}분 만에 기록합니다` };
}

/**
 * DB에 넣을 행.
 *
 * **못 읽은 칸은 넣지 않는다(undefined).** 0으로 채우면 "그 시각에
 * 수수료가 0이었다"가 사실로 기록되고, 나중에 그 숫자로 성과를 계산한다.
 */
export function snapshotRow(i: {
  userId: string;
  env: 'LIVE' | 'TESTNET' | 'MOCK';
  accountKey?: string;
  takenAtMs: number;
  totalEquity: number;
  unrealizedPnl?: number | null;
  realizedPnl?: number | null;
  fees?: number | null;
  funding?: number | null;
  deposit?: number | null;
  withdrawal?: number | null;
  currency?: string;
}): Record<string, any> {
  const put = (k: string, v: any) => (num(v) == null ? {} : { [k]: num(v) });
  return {
    user_id: i.userId,
    env: i.env,
    account_key: i.accountKey ?? '',
    taken_at: new Date(i.takenAtMs).toISOString(),
    total_equity: i.totalEquity,
    currency: i.currency ?? 'USDT',
    ...put('unrealized_pnl', i.unrealizedPnl),
    ...put('realized_pnl', i.realizedPnl),
    ...put('fees', i.fees),
    ...put('funding', i.funding),
    ...put('deposit', i.deposit),
    ...put('withdrawal', i.withdrawal),
  };
}
