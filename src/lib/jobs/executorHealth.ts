// src/lib/jobs/executorHealth.ts
//
// "지금 이 주문을 실행할 사람이 있는가."
//
// 무엇이 문제였나
// ───────────────
// `/api/binance/futures/order`는 거래소를 직접 부르지 않는다. jobs 큐에
// PLACE_ORDER를 적재하고 `{ ok: true, queued: true }`를 돌려준다. 실행자는
// Railway Worker 하나뿐이다.
//
// 그런데 그 워커는 Binance에 IP 지역 차단을 당해 쓰지 않고 있다
// (PROGRESS.md 인프라 표). 즉 이 경로로 넣은 주문은 **큐에 쌓이기만 하고
// 실행되지 않는다.** 화면은 `ok: true`를 받아 "주문됨"으로 그린다.
// 사용자는 포지션이 열렸다고 믿고 손을 뗀다.
//
// 이 앱에서 가장 위험한 종류의 실패다 — 성공처럼 보이는 실패.
//
// 두 가지를 정한다
// ────────────────
// 1. 실행자가 없으면 **적재하지 않고 거절한다.** 적재해 두면 지뢰가 된다 —
//    워커가 몇 시간 뒤 살아나면 그때 시세로 주문이 나간다. 사용자는 그 주문을
//    이미 잊었다.
// 2. 그래도 큐에 남아 있을 수 있는 주문에 **만료 시각**을 새긴다. 워커가
//    돌아왔을 때 오래된 주문을 실행하지 않도록. 판단 규칙을 여기 두고
//    워커와 앱이 같은 함수를 쓴다.
//
// 판정 기준을 이 파일로 모으는 이유: `/api/worker/status`(화면)와 주문
// 경로가 각자 임계값을 갖고 있으면, 화면은 '정상'인데 주문은 막히는(또는
// 그 반대) 상태가 생긴다. 이 프로젝트가 상태 대조를 공용화한 것과 같은 이유다.

/** 하트비트가 이 시간을 넘기면 '지연' */
export const DEGRADED_AFTER_MS = 25_000;
/** 하트비트가 이 시간을 넘기면 '중단' */
export const STOPPED_AFTER_MS = 60_000;

/**
 * 적재된 주문의 유효 시간.
 *
 * 2분으로 잡은 이유: 수동 주문은 사용자가 화면을 보며 누른 것이다. 2분이면
 * 시세가 이미 달라졌고, 그 가격을 의도했다고 볼 수 없다. 길게 두면 "왜
 * 아까 취소한 주문이 나갔지"가 되고, 짧게 두면 정상적인 큐 지연에도 실패한다.
 */
export const ORDER_TTL_MS = 120_000;

export type ExecutorStatus =
  /** 하트비트가 최근이다 */
  | 'running'
  /** 하트비트가 느리다. 아직 살아 있을 수 있다 */
  | 'degraded'
  /** 하트비트가 끊겼거나 스스로 중단을 보고했다 */
  | 'stopped'
  /** 하트비트 행이 아예 없다 — 한 번도 뜬 적이 없다 */
  | 'absent'
  /** 조회 자체를 못 했다. '정상'이 아니다 */
  | 'unknown';

export interface HeartbeatRow {
  worker_id?: string | null;
  /** ISO 문자열 */
  last_seen?: string | null;
  status?: string | null;
  current_task?: string | null;
  error_count?: number | null;
}

export interface ExecutorVerdict {
  status: ExecutorStatus;
  /** 화면에 그대로 쓸 한국어 */
  label: string;
  /** 하트비트가 몇 초 전인가. 모르면 null */
  ageSec: number | null;
  workerId: string | null;
  /**
   * 지금 주문을 큐에 넣어도 되는가.
   *
   * `degraded`는 허용한다 — 느린 것과 죽은 것은 다르고, 25초 지연으로 매매를
   * 막으면 정상 운영 중에도 자주 걸린다. `stopped`·`absent`·`unknown`은 막는다.
   */
  canQueue: boolean;
  /** canQueue=false일 때 사용자에게 보여줄 이유 */
  reason: string;
}

/**
 * 하트비트 한 줄로 실행자 상태를 판정한다. 순수 함수.
 *
 * `row`가 null이면 '행이 없음'(absent)이고, `readFailed`가 true면 '조회 실패'
 * (unknown)다. 둘을 구분하는 이유: 워커가 한 번도 뜬 적 없는 것과, DB를 못
 * 읽은 것은 대응이 다르다. 그리고 둘 다 **'정상'이 아니다.**
 */
export function judgeExecutor(
  row: HeartbeatRow | null | undefined,
  nowMs: number,
  readFailed = false,
): ExecutorVerdict {
  if (readFailed) {
    return {
      status: 'unknown', label: '상태 확인 실패', ageSec: null, workerId: null,
      canQueue: false,
      reason: '주문 실행기의 상태를 확인하지 못했습니다. 확인하지 못한 것을 정상으로 볼 수 없어 주문을 보류합니다.',
    };
  }
  if (!row) {
    return {
      status: 'absent', label: '워커 없음', ageSec: null, workerId: null,
      canQueue: false,
      reason: '주문을 실행할 워커가 등록되어 있지 않습니다. 큐에 넣어도 실행되지 않습니다.',
    };
  }

  const workerId = row.worker_id ?? null;
  const seenMs = row.last_seen ? Date.parse(row.last_seen) : NaN;
  if (!Number.isFinite(seenMs)) {
    return {
      status: 'unknown', label: '하트비트 시각 불명', ageSec: null, workerId,
      canQueue: false,
      reason: '워커의 마지막 응답 시각을 읽을 수 없습니다. 살아 있는지 확인할 수 없어 주문을 보류합니다.',
    };
  }

  const ageMs = nowMs - seenMs;
  const ageSec = Math.round(ageMs / 1000);

  // 스스로 중단을 보고했으면 나이와 무관하게 중단이다
  if (String(row.status ?? '').toLowerCase() === 'stopped') {
    return {
      status: 'stopped', label: '중단', ageSec, workerId, canQueue: false,
      reason: '주문 실행기가 중단 상태를 보고했습니다. 큐에 넣어도 실행되지 않습니다.',
    };
  }
  if (ageMs > STOPPED_AFTER_MS) {
    return {
      status: 'stopped', label: '중단(heartbeat 끊김)', ageSec, workerId, canQueue: false,
      reason: `주문 실행기의 응답이 ${ageSec}초째 없습니다. 큐에 넣어도 실행되지 않습니다.`,
    };
  }
  if (ageMs > DEGRADED_AFTER_MS || String(row.status ?? '').toLowerCase() === 'degraded') {
    // 느린 것과 죽은 것은 다르다. 막지 않되 사실은 알린다.
    return {
      status: 'degraded', label: '지연', ageSec, workerId, canQueue: true,
      reason: `주문 실행기가 ${ageSec}초 지연 중입니다 — 체결이 늦을 수 있습니다.`,
    };
  }
  return {
    status: 'running', label: '정상', ageSec, workerId, canQueue: true, reason: '',
  };
}

// ── 적재된 주문의 만료 ────────────────────────────────────────

/** payload에 새길 만료 시각 */
export function orderExpiryIso(nowMs: number, ttlMs = ORDER_TTL_MS): string {
  return new Date(nowMs + ttlMs).toISOString();
}

export interface ExpiryVerdict {
  expired: boolean;
  reason: string;
}

/**
 * 이 적재 주문을 지금 실행해도 되는가.
 *
 * 워커가 돌아왔을 때 오래된 주문을 그대로 내보내면, 사용자가 이미 잊은
 * 주문이 완전히 다른 시세에서 체결된다. 그래서 실행 직전에 본다.
 *
 * `expiresAt`이 없는 주문(이 기능 이전에 적재된 것)은 **만료로 본다.**
 * 만료 시각을 모르는 주문을 실행하는 것이 더 위험하다 — 언제 만든 것인지
 * 알 수 없기 때문이다. 그런 주문은 사람이 다시 누르는 편이 맞다.
 */
export function isOrderExpired(
  expiresAtIso: string | null | undefined,
  nowMs: number,
): ExpiryVerdict {
  if (!expiresAtIso) {
    return {
      expired: true,
      reason: '만료 시각이 없는 주문입니다. 언제 만들어진 것인지 알 수 없어 실행하지 않습니다.',
    };
  }
  const t = Date.parse(expiresAtIso);
  if (!Number.isFinite(t)) {
    return { expired: true, reason: `만료 시각을 읽을 수 없습니다 (${expiresAtIso})` };
  }
  if (nowMs > t) {
    const lateSec = Math.round((nowMs - t) / 1000);
    return {
      expired: true,
      reason: `${lateSec}초 지난 주문입니다. 그때 시세가 아니므로 실행하지 않습니다.`,
    };
  }
  return { expired: false, reason: '' };
}
