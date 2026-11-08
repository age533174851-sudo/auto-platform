// src/lib/risk/killRetry.ts
//
// **킬스위치를 자동으로 다시 시도해도 되는가.**
//
// 왜 이 파일이 따로 있는가
// ────────────────────────
// `killSwitchTruth.ts`의 `retriggerDecision`은 **사람이 버튼을 다시
// 눌렀을 때** 실행할지 판단한다. 그 판단의 전제는 "사람이 보고 있다"다.
// 그래서 모르면 다시 한다 — 안 하는 쪽의 대가가 더 크고, 누른 사람이
// 결과를 읽는다.
//
// 자동 재시도는 전제가 다르다. 보는 사람이 없다. 같은 규칙을 그대로
// 쓰면 세 가지가 난다:
//
//   ① 같은 주문이 두 번 나간다. 큐에 이미 실행 중인 시도가 있는데
//      그걸 못 보고(또는 조회 실패를 "없음"으로 읽고) 또 claim한다.
//   ② 끝없이 다시 낸다. 한도가 없으면 거래소가 계속 거절하는 상황에서
//      무한히 때린다.
//   ③ 아무도 모르게 멈춘다. 한도까지 실패했는데 그걸 "완료"로 적으면,
//      남은 포지션 위에서 아무도 손을 안 쓴다.
//
// 그래서 **자동 경로의 판정만** 여기 모은다.
//
// 잔여 판정은 여기서 만들지 않는다
// ────────────────────────────────
// 거래소에 남은 것이 있는지는 `leftoverVerdict`가 이미 판단한다. 이
// 파일은 그 결과(`LeftoverVerdict`)를 **받아서** 쓴다. 숫자를 다시 세지
// 않는다 — 같은 판단이 두 곳에 있으면 언젠가 갈린다.
//
// 큐의 수명은 `worker/src/index.ts`의 실제 동작을 따른다
// ─────────────────────────────────────────────────────
//   PENDING → (claim) PROCESSING · attempts+1 · locked_until = now+60s
//   잠금 만료 + 보유 워커 heartbeat 없음 + 유예(120s) 경과 → 회수 대상
//   **살아 있는 워커의 잡은 아무리 느려도 회수하지 않는다.**
//
// 이 파일은 네트워크도 DB도 모른다. 전부 주입받는다. 그래서 시험이
// 중복 요청·재시작·조회 실패·한도 초과를 sleep 없이 재현한다
// (`scripts/test-kill-retry.mjs`).
//
// **주의: 이 판정은 판정이다.** 이것이 통과했다는 사실은 거래소에서
// 실제로 청산이 끝났다는 증거가 아니다. 그 증거는 `leftoverVerdict`가
// `CLEAR`를 줄 때, 그것도 실제 거래소 응답으로만 생긴다.

import type { LeftoverVerdict } from './killSwitchTruth';

/** 기본 백오프. 시도마다 2배로 늘고 8배에서 멈춘다 (최대 2분) */
export const KILL_RETRY_BACKOFF_MS = 15_000;
/** 백오프 배수 상한 */
export const KILL_RETRY_BACKOFF_CAP = 8;
/** `max_attempts`가 없을 때 쓰는 한도. 076_jobs_queue.sql의 기본값과 같다 */
export const KILL_RETRY_MAX_ATTEMPTS = 5;
/** 잠금 만료 후 회수까지의 유예. worker의 STALE_GRACE_MS와 같다 */
export const KILL_RETRY_STALE_GRACE_MS = 120_000;

export type KillRetryCode =
  /** 킬스위치가 발동 중이 아니다 — 재시도할 것이 없다 */
  | 'NOT_ACTIVE'
  /** 거래소가 잔여 없음을 확인했다 — 다시 낼 주문이 없다 */
  | 'DONE'
  /** 이미 실행 중(또는 대기 중)인 시도가 있다 — 중복으로 또 내지 않는다 */
  | 'IN_FLIGHT'
  /** 다시 할 때가 아니다. `waitMs`만큼 남았다 */
  | 'BACKOFF'
  /** 지금 다시 한다 */
  | 'RETRY'
  /** 한도까지 했는데 남아 있다 — 자동 재시도를 멈추고 사람에게 올린다 */
  | 'GIVE_UP_REPORT'
  /** **판단 근거를 못 읽었다.** 완료도 아니고 재시도 허가도 아니다 */
  | 'UNKNOWN_HOLD';

export interface KillRetryVerdict {
  code: KillRetryCode;
  /** 지금 새 시도를 claim해도 되는가. `RETRY`만 참 */
  retry: boolean;
  /** 끝났다고 적어도 되는가. **`DONE`만 참** */
  complete: boolean;
  /** 사람에게 올려야 하는가 */
  escalate: boolean;
  /** `BACKOFF`일 때 남은 대기(ms). 그 밖에는 null */
  waitMs: number | null;
  /** 남은 시도 횟수. 모르면 null — **0이 아니다** */
  attemptsLeft: number | null;
  reason: string;
}

/** jobs 행에서 이 판정이 보는 칸들. 못 읽은 칸은 null이다 — 0이 아니다 */
export interface KillRetryJob {
  /** 'PENDING' | 'PROCESSING' | 그 밖의 종료 상태. null = 못 읽었다 */
  status: string | null;
  /** 지금까지의 시도 횟수. null = 못 읽었다 */
  attempts: number | null;
  /** 이 잡의 한도. null이면 KILL_RETRY_MAX_ATTEMPTS를 쓴다 */
  maxAttempts: number | null;
  lockedUntilMs: number | null;
  lockedBy: string | null;
  lastAttemptAtMs: number | null;
}

/**
 * 큐 조회 결과.
 *
 * **`ok: true` + `job: null`("조회했고 행이 없다")과 `ok: false`
 * ("조회 자체를 못 했다")를 한 모양으로 합치지 않는다.** 합치면 조회
 * 실패가 "실행 중인 시도 없음"으로 읽히고, 그 순간 중복 주문이 난다.
 */
export type KillRetryJobLookup =
  | { ok: true; job: KillRetryJob | null }
  | { ok: false; error?: string | null };

export interface KillRetryInput {
  nowMs: number | null | undefined;
  /** kill_switch_state.active. null = 못 읽었다 — 꺼졌다는 뜻이 아니다 */
  active: boolean | null | undefined;
  lookup: KillRetryJobLookup | null | undefined;
  /** `leftoverVerdict()`의 결과. 여기서 다시 계산하지 않는다 */
  leftover: LeftoverVerdict | null | undefined;
  /** 잡을 쥔 워커의 heartbeat가 살아 있는가. null = 모른다 */
  holderAlive?: boolean | null;
  backoffMs?: number;
  staleGraceMs?: number;
  maxAttemptsDefault?: number;
}

function hold(reason: string, attemptsLeft: number | null = null): KillRetryVerdict {
  return { code: 'UNKNOWN_HOLD', retry: false, complete: false, escalate: true, waitMs: null, attemptsLeft, reason };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 시도 n회 뒤의 대기 시간 */
export function killRetryBackoffMs(attempts: number, base = KILL_RETRY_BACKOFF_MS): number {
  const n = Math.max(0, Math.floor(attempts) - 1);
  const mult = Math.min(KILL_RETRY_BACKOFF_CAP, 2 ** n);
  return base * mult;
}

/**
 * 지금 자동으로 다시 시도해도 되는가.
 *
 * 규칙은 전부 fail-closed다:
 *
 *   · 못 읽은 것은 **완료가 아니다** (`DONE`은 거래소 `CLEAR`에서만 나온다)
 *   · 못 읽은 것은 **재시도 허가도 아니다** (큐를 모르면 claim하지 않는다)
 *   · 한도까지 실패한 것은 **완료가 아니다** (`GIVE_UP_REPORT` + 올린다)
 */
export function killRetryVerdict(i: KillRetryInput): KillRetryVerdict {
  const now = num(i?.nowMs);
  if (now == null) return hold('현재 시각을 읽지 못했습니다 — 어떤 판정도 내리지 않습니다');

  if (i.active == null) {
    return hold('킬스위치 발동 여부를 읽지 못했습니다 — 꺼졌다는 뜻이 아닙니다');
  }
  if (i.active === false) {
    return { code: 'NOT_ACTIVE', retry: false, complete: false, escalate: false, waitMs: null, attemptsLeft: null,
      reason: '킬스위치가 발동 중이 아닙니다 — 자동 재시도 대상이 아닙니다' };
  }

  const lv = i.leftover ?? null;
  if (!lv || !lv.code) {
    return hold('거래소 잔여 판정이 없습니다 — 완료도 재시도도 판단할 수 없습니다');
  }
  // **완료는 여기서만 나온다.** 거래소가 직접 확인해 준 경우다.
  if (lv.code === 'CLEAR') {
    return { code: 'DONE', retry: false, complete: true, escalate: false, waitMs: null, attemptsLeft: null,
      reason: lv.reason };
  }

  // ── 큐에 이미 떠 있는 시도가 있는가 ──
  const lk = i.lookup ?? null;
  if (!lk || (lk as any).ok !== true) {
    const err = (lk as any)?.error;
    return hold(`실행 큐를 조회하지 못했습니다${err ? ` (${String(err)})` : ''} — `
      + '실행 중인 시도가 없다는 뜻이 아니므로 새로 내지 않습니다');
  }
  const job = (lk as { ok: true; job: KillRetryJob | null }).job ?? null;

  const grace = num(i.staleGraceMs) ?? KILL_RETRY_STALE_GRACE_MS;
  const base = num(i.backoffMs) ?? KILL_RETRY_BACKOFF_MS;
  const fallbackMax = num(i.maxAttemptsDefault) ?? KILL_RETRY_MAX_ATTEMPTS;

  let attempts: number | null = 0;
  let lastAt: number | null = null;
  let max = fallbackMax;

  if (job) {
    const st = job.status == null ? null : String(job.status).toUpperCase();
    if (st == null) {
      return hold('실행 잡의 상태를 읽지 못했습니다 — 실행 중이 아니라는 뜻이 아닙니다');
    }

    if (st === 'PENDING') {
      return { code: 'IN_FLIGHT', retry: false, complete: false, escalate: false, waitMs: null, attemptsLeft: null,
        reason: '이미 큐에서 대기 중인 시도가 있습니다 — 같은 작업을 또 쌓지 않습니다' };
    }

    if (st === 'PROCESSING') {
      const until = num(job.lockedUntilMs);
      if (until == null) {
        return hold('실행 중인 잡의 잠금 시각을 읽지 못했습니다 — 회수해도 되는지 알 수 없으므로 새로 내지 않습니다');
      }
      if (until > now) {
        return { code: 'IN_FLIGHT', retry: false, complete: false, escalate: false, waitMs: null, attemptsLeft: null,
          reason: `다른 시도가 실행 중입니다 (잠금 ${Math.round((until - now) / 1000)}초 남음) — 중복으로 내지 않습니다` };
      }
      // 잠금은 만료됐다. 그래도 **보유 워커가 살아 있으면 회수하지 않는다** —
      // 거래소 호출이 느려서 늦은 것일 수 있고, 회수하면 같은 주문이 두 번 나간다.
      if (i.holderAlive == null) {
        return hold(`잠금이 만료됐지만 보유 워커(${job.lockedBy || '?'})의 생존을 확인하지 못했습니다 — `
          + '살아 있는 시도 위에 또 내지 않습니다');
      }
      if (i.holderAlive === true) {
        return { code: 'IN_FLIGHT', retry: false, complete: false, escalate: false, waitMs: null, attemptsLeft: null,
          reason: `잠금이 만료됐지만 보유 워커(${job.lockedBy || '?'})가 살아 있습니다 — 느릴 뿐이므로 회수하지 않습니다` };
      }
      const waited = now - until;
      if (waited < grace) {
        return { code: 'BACKOFF', retry: false, complete: false, escalate: false,
          waitMs: grace - waited, attemptsLeft: null,
          reason: `보유 워커(${job.lockedBy || '?'})가 끊겼지만 회수 유예가 ${Math.round((grace - waited) / 1000)}초 남았습니다` };
      }
      // 유예까지 지났다 — 아래 한도·백오프 판정으로 넘어간다.
    }

    attempts = num(job.attempts);
    if (attempts == null) {
      return hold('지금까지의 시도 횟수를 읽지 못했습니다 — 0으로 읽지 않습니다');
    }
    lastAt = num(job.lastAttemptAtMs);
    max = num(job.maxAttempts) ?? fallbackMax;
  }

  // ── 한도 ──
  //
  // 한도에 닿았는데 거래소에 남아 있다. **이것을 완료로 적지 않는다.**
  // 자동으로 할 수 있는 것은 끝났고, 남은 것은 사람이 봐야 한다.
  if (attempts >= max) {
    return { code: 'GIVE_UP_REPORT', retry: false, complete: false, escalate: true, waitMs: null, attemptsLeft: 0,
      reason: `자동 재시도 한도(${attempts}/${max})에 닿았는데 아직 끝나지 않았습니다 — ${lv.reason}. `
        + '거래소에서 직접 확인하세요' };
  }
  const attemptsLeft = max - attempts;

  // ── 백오프 ──
  if (lastAt == null) {
    if (attempts > 0) {
      return hold(`${attempts}번 시도한 기록은 있는데 그 시각을 읽지 못했습니다 — `
        + '얼마나 지났는지 모르는 채로 바로 또 내지 않습니다', attemptsLeft);
    }
    return { code: 'RETRY', retry: true, complete: false, escalate: false, waitMs: null, attemptsLeft,
      reason: `아직 시도한 적이 없습니다 — 지금 실행합니다 (${lv.reason})` };
  }

  const elapsed = now - lastAt;
  if (elapsed < 0) {
    return hold(`마지막 시도 시각이 현재보다 미래입니다 (${Math.round(-elapsed / 1000)}초) — `
      + '시계가 어긋났으므로 그대로 믿고 내지 않습니다', attemptsLeft);
  }
  const need = killRetryBackoffMs(attempts, base);
  if (elapsed < need) {
    return { code: 'BACKOFF', retry: false, complete: false, escalate: false,
      waitMs: need - elapsed, attemptsLeft,
      reason: `직전 시도로부터 ${Math.round(elapsed / 1000)}초 — ${Math.round((need - elapsed) / 1000)}초 더 기다립니다 `
        + `(${attempts}/${max})` };
  }

  return { code: 'RETRY', retry: true, complete: false, escalate: false, waitMs: null, attemptsLeft,
    reason: `다시 실행합니다 (${attempts + 1}/${max}) — ${lv.reason}` };
}
