// src/lib/portfolio/snapshotBucket.ts
//
// **읽기 요청이 쓰기를 하고 있었다.**
//
// 무엇이 잘못돼 있었나
// ────────────────────
// `/api/wallets/overview`는 GET인데 `account_equity_snapshots`에 INSERT를
// 했다. 사람이 지갑 화면을 열 때마다 자산이 찍혔다. 그 구조에는 세 가지
// 고장이 같이 들어 있다:
//
//   1. **사람이 안 보면 곡선이 안 그려진다.** 자동매매는 24시간 도는데
//      자산 기록은 사람이 앱을 여는 시간에만 남는다. 밤에 무슨 일이
//      있었는지는 영원히 알 수 없다
//   2. **탭을 두 개 열면 두 번 찍힌다.** 간격 판정이 "마지막 기록에서
//      15분"이라 동시 요청은 둘 다 통과한다. 표가 부풀고, 그날 손익이
//      두 배로 보인다
//   3. **표에는 `UNIQUE (user_id, env, account_key, taken_at)`이 있지만**
//      `taken_at`이 밀리초까지 다르므로 그 제약은 아무것도 막지 못한다
//
// 어떻게 바꾸나
// ─────────────
// **시각이 아니라 칸(bucket)에 찍는다.** 15분을 한 칸으로 보고, 그 칸의
// 시작 시각을 키로 쓴다. 같은 칸에 두 번 들어오면 DB가 막는다 —
// 판정이 아니라 **제약**이 막는 것이 핵심이다. 경쟁 조건에서 애플리케이션
// 판정은 언제나 진다.
//
// 그리고 **찍는 주체는 워커다.** 사람이 화면을 열든 말든 15분마다
// 남는다. GET은 이제 읽기만 한다.

/** 한 칸의 길이. 곡선의 최소 해상도다 */
export const SNAPSHOT_BUCKET_MS = 15 * 60_000;

/**
 * 워커가 안 찍은 지 이만큼 지나면 **화면이 그 사실을 말한다.**
 *
 * 조용히 옛 곡선을 보여주면 사용자는 그게 지금 자산인 줄 안다.
 * 한 칸을 놓치는 것은 흔한 일이므로 두 칸으로 둔다.
 */
export const SNAPSHOT_STALE_MS = SNAPSHOT_BUCKET_MS * 2;

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 이 시각이 속한 칸의 시작.
 *
 * **바닥으로 내린다(floor).** 반올림하면 같은 순간이 기계마다 다른
 * 칸으로 갈 수 있고, 그러면 유일 제약이 중복을 못 막는다.
 */
export function bucketStartMs(ms: any, intervalMs?: any): number | null {
  const t = num(ms);
  if (t == null || t < 0) return null;
  const iv = num(intervalMs) ?? SNAPSHOT_BUCKET_MS;
  if (!(iv > 0)) return null;
  return Math.floor(t / iv) * iv;
}

/** 같은 값을 DB가 쓰는 모양으로 */
export function bucketStartIso(ms: any, intervalMs?: any): string | null {
  const b = bucketStartMs(ms, intervalMs);
  return b == null ? null : new Date(b).toISOString();
}

export type SnapshotFreshnessCode =
  /** 최근 칸이 찍혀 있다 */
  | 'FRESH'
  /** 찍힌 지 오래됐다. **워커가 안 도는 것일 수 있다** */
  | 'STALE'
  /** 한 번도 안 찍혔다 */
  | 'NEVER'
  /** 이 환경에 계좌가 없다 — 찍을 것이 없다 */
  | 'NO_ACCOUNT'
  /** 기록을 못 읽었다. **없다는 뜻이 아니다** */
  | 'UNKNOWN';

export interface SnapshotFreshness {
  code: SnapshotFreshnessCode;
  /** 화면이 경고를 띄워야 하는가 */
  stale: boolean;
  ageMs: number | null;
  reason: string;
}

/**
 * 자산 기록이 지금 것인가.
 *
 * **GET이 더 이상 찍지 않으므로 이 판정이 필요해졌다.** 예전에는 화면을
 * 여는 행위가 곧 기록이라 "오래됐다"가 존재할 수 없었다. 이제는 워커가
 * 멈추면 곡선이 조용히 멈춘다 — 그걸 화면이 말해야 한다.
 */
export function snapshotFreshness(i: {
  nowMs: any;
  /** 마지막으로 찍힌 시각. **못 읽었으면 undefined, 없으면 null** */
  lastTakenMs?: number | null;
  /** 기록을 읽는 데 성공했는가 */
  historyOk?: boolean;
  /** 이 환경의 연결 수 */
  connections?: any;
  staleMs?: any;
}): SnapshotFreshness {
  const now = num(i?.nowMs);
  if (i?.historyOk === false) {
    return { code: 'UNKNOWN', stale: false, ageMs: null,
      reason: '자산 기록을 읽지 못했습니다 — 기록이 없다는 뜻이 아닙니다' };
  }
  if (num(i?.connections) != null && !(Number(i.connections) > 0)) {
    return { code: 'NO_ACCOUNT', stale: false, ageMs: null,
      reason: '이 환경에 연결된 계좌가 없습니다 — 찍을 자산이 없습니다' };
  }
  const last = num(i?.lastTakenMs);
  if (last == null) {
    return { code: 'NEVER', stale: true, ageMs: null,
      reason: '자산이 아직 한 번도 기록되지 않았습니다 — 워커가 15분마다 찍습니다' };
  }
  if (now == null) {
    return { code: 'UNKNOWN', stale: false, ageMs: null, reason: '지금 시각을 알 수 없습니다' };
  }
  const age = now - last;
  const limit = num(i?.staleMs) ?? SNAPSHOT_STALE_MS;
  if (age > limit) {
    return { code: 'STALE', stale: true, ageMs: age,
      reason: `자산이 ${Math.round(age / 60_000)}분째 기록되지 않았습니다 — `
        + '워커가 멈췄을 수 있습니다. 곡선의 마지막 점은 지금 자산이 아닙니다' };
  }
  return { code: 'FRESH', stale: false, ageMs: age,
    reason: `${Math.max(0, Math.round(age / 60_000))}분 전에 기록되었습니다` };
}

/**
 * DB에 넣을 행. **칸 키가 들어 있다.**
 *
 * **자산을 못 읽었으면 null을 돌려준다.** 0으로 찍으면 곡선이 바닥으로
 * 떨어지고 사용자는 그 시각에 전액을 잃은 줄 안다 — 그 기록은 되돌릴 수
 * 없다. 부르는 쪽이 null을 받으면 그냥 이번 칸을 건너뛴다.
 */
export function snapshotUpsert(i: {
  userId: string;
  env: 'LIVE' | 'TESTNET' | 'MOCK';
  accountKey?: string;
  nowMs: number;
  /** 지금 읽은 총자산. **못 읽었으면 null** */
  totalEquity: number | null;
  unrealizedPnl?: number | null;
  /** 값을 못 매긴 자산이 하나라도 있으면 부분합계다 — 찍지 않는다 */
  unpricedCount?: number;
  intervalMs?: number;
  source?: string;
}): Record<string, any> | null {
  const equity = num(i?.totalEquity);
  if (equity == null) return null;
  if (Number(i?.unpricedCount ?? 0) > 0) return null;
  const bucket = bucketStartIso(i?.nowMs, i?.intervalMs);
  if (bucket == null) return null;
  const uid = String(i?.userId ?? '');
  if (!uid) return null;

  const put = (k: string, v: any) => (num(v) == null ? {} : { [k]: num(v) });
  return {
    user_id: uid,
    env: i.env,
    account_key: i.accountKey ?? '',
    // 같은 칸의 두 번째 쓰기를 DB가 막는다.
    bucket_start: bucket,
    // 실제로 읽은 시각도 남긴다 — 칸 안 어디였는지 알 수 있어야 한다.
    taken_at: new Date(Number(i.nowMs)).toISOString(),
    total_equity: equity,
    currency: 'USDT',
    source: i.source ?? 'worker',
    ...put('unrealized_pnl', i.unrealizedPnl),
  };
}

/** upsert할 때 충돌 키. 문자열이 두 곳에 갈리지 않게 여기 하나만 둔다 */
export const SNAPSHOT_CONFLICT_KEY = 'user_id,env,account_key,bucket_start';
