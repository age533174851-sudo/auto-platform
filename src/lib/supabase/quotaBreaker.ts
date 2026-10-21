// src/lib/supabase/quotaBreaker.ts
//
// **DB가 한도를 넘겨 402를 돌려줄 때, 재시도로 트래픽을 더 늘리지 않는다.**
//
// 무엇이 일어났나
// ───────────────
// Supabase Free Plan의 Egress가 한도를 넘자 요청이 402로 떨어졌다.
// 그런데 워커는 **3초마다** 같은 조회를 다시 보낸다. 402는 "잠깐
// 실패"가 아니라 **달이 바뀌기 전까지 계속 실패하는 상태**인데,
// 실패할 때마다 또 보내면 그 요청 자체가 다시 전송량이 된다.
// 고장이 고장을 키우는 모양이다.
//
// 무엇을 **끄지 않는가** — 이게 핵심이다
// ──────────────────────────────────────
// 차단기는 **한가한 조회만** 끊는다. 포지션을 지키는 일은 끊지 않는다:
// 청산 감시 · 스모크 정산/취소 · 킬스위치 · 미확정 주문 대조는
// 차단기가 열려 있든 닫혀 있든 **언제나 시도한다.**
//
// 이유는 단순하다. 조회가 막혀서 돈이 드는 것보다 **열린 100배 포지션이
// 방치되는 쪽이 훨씬 비싸다.** 한도를 아끼려고 보호를 끄면, 아낀 것보다
// 큰 것을 잃는다. 그래서 끊는 것은 "지금 안 해도 되는 것"뿐이다.
//
// **못 읽은 것을 "없다"로 바꾸지도 않는다.** 차단기가 조회를 건너뛰면
// 호출부는 `SKIPPED`를 받는다 — 0건이 아니다. 그 구분이 무너지면
// 한도 초과가 "포지션 없음"으로 보인다.

/** 한도·결제 때문에 막힌 것인가 (일시적 네트워크 오류와 다르다) */
export function isQuotaError(err: any): boolean {
  if (err == null) return false;
  const status = Number(err?.status ?? err?.statusCode ?? err?.code);
  if (status === 402) return true;
  const text = [
    err?.message, err?.error, err?.details, err?.hint,
    typeof err === 'string' ? err : null,
  ].filter(Boolean).map(String).join(' ').toLowerCase();
  if (!text) return false;
  return /\b402\b/.test(text)
    || /payment required/.test(text)
    || /quota|egress|bandwidth/.test(text)
    || /exceeded .*(plan|limit)|over the .*(plan|limit)/.test(text)
    || /free plan .*(limit|exceeded)/.test(text);
}

/** 차단기의 상태. **값으로만 들고 다닌다** — 시계도 전역도 읽지 않는다 */
export interface BreakerState {
  /** 연속 한도 실패 횟수 */
  strikes: number;
  /** 이 시각까지는 한가한 조회를 보내지 않는다. 열려 있으면 null */
  blockedUntilMs: number | null;
  /** 마지막으로 한도 실패를 본 시각 */
  lastQuotaFailureMs: number | null;
}

export const OPEN_BREAKER: BreakerState = {
  strikes: 0, blockedUntilMs: null, lastQuotaFailureMs: null,
};

/**
 * 대기 시간. 1분 → 2 → 4 → 8 → 16 → **30분 상한**.
 *
 * 상한을 두는 이유: 한도는 달이 바뀌면 풀린다. 무한히 늘리면 풀린 뒤에도
 * 몇 시간씩 자고 있게 된다. 30분이면 전송량은 1/600로 줄고, 복구는
 * 늦어도 반 시간 안에 알아챈다.
 */
export const BACKOFF_STEPS_MS = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000];

export function backoffMsFor(strikes: number): number {
  if (!Number.isFinite(strikes) || strikes <= 0) return BACKOFF_STEPS_MS[0];
  const i = Math.min(Math.floor(strikes) - 1, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[i];
}

/**
 * 조회 결과를 차단기에 반영한다.
 *
 * **한도 오류만 차단기를 닫는다.** 평범한 오류(네트워크 끊김·제약 위반)는
 * 손대지 않는다 — 그런 것까지 모아서 끊으면, 고칠 수 있는 고장을
 * 조용히 숨기게 된다.
 */
export function noteResult(
  prev: BreakerState, outcome: { error?: any } | null | undefined, nowMs: number,
): BreakerState {
  const err = outcome?.error ?? null;
  if (isQuotaError(err)) {
    const strikes = (Number.isFinite(prev?.strikes) ? prev.strikes : 0) + 1;
    return {
      strikes,
      blockedUntilMs: nowMs + backoffMsFor(strikes),
      lastQuotaFailureMs: nowMs,
    };
  }
  // 한도 오류가 아니고 **성공**이면 연다. 다른 오류는 상태를 유지한다 —
  // 성공하지 않았는데 여는 것은 확인하지 않은 것을 통과로 적는 일이다.
  if (err == null) return { ...OPEN_BREAKER };
  return prev ?? { ...OPEN_BREAKER };
}

/** 이 조회가 포지션을 지키는 일인가 */
export type QueryClass =
  /** 열린 노출을 보고 닫는 일 · 안전 관문. **절대 건너뛰지 않는다** */
  | 'PROTECTION'
  /** 지금 안 해도 되는 일 — 통계·목록·새 진입 찾기 */
  | 'ROUTINE';

export type GateCode = 'ALLOW' | 'SKIP_QUOTA';

export interface QuotaGate {
  allowed: boolean;
  code: GateCode;
  /** 언제 다시 열리는가 (ms). 열려 있으면 null */
  retryAtMs: number | null;
  reason: string;
}

/**
 * 지금 이 조회를 보내도 되는가.
 *
 * `PROTECTION`은 **언제나 true**다. 한도를 아끼려고 포지션 보호를
 * 멈추지 않는다 — 그 선택은 아낀 것보다 큰 것을 잃는다.
 */
export function quotaGate(
  state: BreakerState | null | undefined, kind: QueryClass, nowMs: number,
): QuotaGate {
  if (kind === 'PROTECTION') {
    return { allowed: true, code: 'ALLOW', retryAtMs: null,
      reason: '포지션 보호 조회는 한도와 무관하게 보냅니다' };
  }
  const until = state?.blockedUntilMs ?? null;
  if (until != null && Number.isFinite(until) && nowMs < until) {
    const leftSec = Math.ceil((until - nowMs) / 1000);
    return {
      allowed: false, code: 'SKIP_QUOTA', retryAtMs: until,
      reason: `DB 사용량 한도로 막혀 있습니다 — 한가한 조회를 ${leftSec}초 쉽니다 `
        + '(재시도가 전송량을 더 늘리지 않게 합니다)',
    };
  }
  return { allowed: true, code: 'ALLOW', retryAtMs: null, reason: '' };
}

/** 화면·로그에 적을 한 줄. **숫자를 지어내지 않는다** */
export function breakerLine(state: BreakerState | null | undefined, nowMs: number): string {
  const until = state?.blockedUntilMs ?? null;
  if (until == null || !Number.isFinite(until) || nowMs >= until) {
    return 'DB 사용량 차단기: 열림';
  }
  return `DB 사용량 차단기: 닫힘 (연속 ${state?.strikes ?? 0}회 · `
    + `${Math.ceil((until - nowMs) / 1000)}초 뒤 재시도)`;
}
