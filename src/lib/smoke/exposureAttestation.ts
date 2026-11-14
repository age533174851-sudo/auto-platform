// src/lib/smoke/exposureAttestation.ts
//
// **막아 놓은 것을 푸는 유일한 길.**
//
// `unresolvedExposureBlock`은 `POSITION_ZERO`·`ORDERS_ZERO`가 둘 다
// PASS일 때만 다음 회차를 연다. 2026-10-16 BTCUSDT 두 회차는
// `ENTRY=FAIL [-1111]`로 끝나면서 `ORDERS_ZERO`를 아예 적지 못했고,
// 그래서 그 연결은 **영구히 막혀 있다.**
//
// 막는 것은 맞다. 문제는 **푸는 길이 코드에 없다는 것**이었다. 남은
// 수단이 "사람이 운영 DB를 직접 고친다" 하나뿐이면, 그건 증거 없이 쓰는
// PASS가 되고 이 저장소가 가장 피하려는 모양이다.
//
// 무엇을 주장하고 무엇을 주장하지 않는가
// ──────────────────────────────────────
// **10월에 무슨 일이 있었는지는 모른다. 영원히 모른다.** 그래서 과거의
// `state`·`verdict`·`ENTRY` 판정은 건드리지 않는다. 사후 확인은 과거
// 기록을 고치는 것이 아니라 **새로운 사실을 덧붙이는 것**이다.
//
// 차단의 목적은 "살아 있는 노출 위에 새 포지션을 쌓지 않는 것"이다.
// 그 목적에 답하는 것은 과거가 아니라 **지금**이다. 다만 조회 한 번은
// 원자적이지 않다 — 읽은 직후에 주문이 생길 수 있고, 읽는 순간에만
// 비어 있었을 수도 있다. 그래서 두 가지를 요구한다:
//
//   ① **간격을 둔 두 번의 관측**이 둘 다 비어 있을 것
//   ② 그 둘 사이에 아무것도 생기지 않았을 것 (세 수치가 모두 0)
//
// 그래도 원자적이지는 않다. 그래서 이것은 **진입 허가가 아니다** —
// 장부의 미해결 줄을 더는 차단 사유로 쓰지 않는다는 뜻일 뿐이고,
// 실제 진입 직전에는 `preflightVerdict`가 거래소를 다시 읽는다.
// 관문이 둘이고, 이쪽이 풀려도 저쪽은 그대로다.
//
// 관측은 #343의 `legacySmokeExposureVerdict`가 만든다 — 포지션·일반
// 주문·조건부(Algo) 주문 세 가지를 다 읽고, 하나라도 못 읽으면
// `UNKNOWN`이다. 여기서 그 판정을 다시 쓰지 않는다. **읽기만 한다.**

/** 두 관측 사이 최소 간격. 이보다 가까우면 "두 번 봤다"고 치지 않는다 */
export const ATTEST_MIN_GAP_MS = 10 * 60_000;
/**
 * 사후 확인의 유효 기간.
 *
 * 영원히 유효하면 몇 달 전 관측으로 오늘의 차단을 푸는 일이 생긴다.
 * 지나면 다시 확인한다 — 확인은 자동이므로 사람이 할 일은 늘지 않는다.
 */
export const ATTEST_MAX_AGE_MS = 6 * 60 * 60_000;

export type AttestationCode =
  /** 간격을 둔 두 관측이 모두 비었다 */
  | 'ATTESTED_FLAT'
  /** 사후 확인 기록이 없다 */
  | 'ABSENT'
  /** 기록이 있는데 모양이 깨졌다 — 모르는 것으로 본다 */
  | 'MALFORMED'
  /** 관측에 노출이 있었거나 못 읽었다 */
  | 'NOT_FLAT'
  /** 두 관측이 너무 가깝다 */
  | 'TOO_CLOSE'
  /** 너무 오래됐다 (또는 미래 시각) */
  | 'STALE';

export interface AttestationVerdict {
  /** 이 값이 true일 때만 미해결 줄을 차단 사유에서 뺀다 */
  accepted: boolean;
  code: AttestationCode;
  reason: string;
}

/** 관측 한 번. `legacySmokeExposureVerdict`의 결과를 시각과 함께 적은 것 */
export interface AttestationObservation {
  /** ISO 8601 */
  at: string;
  /** `legacySmokeExposureVerdict`의 code */
  code: string;
  positions: number | null;
  regular: number | null;
  algo: number | null;
}

const no = (code: AttestationCode, reason: string): AttestationVerdict =>
  ({ accepted: false, code, reason });

/** 시각을 ms로. 못 읽으면 null — 0으로 바꾸지 않는다 */
function msOf(v: any): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 이 관측이 "비어 있음을 확인했다"인가 */
function flat(o: any): boolean {
  if (!o || typeof o !== 'object') return false;
  if (String(o.code) !== 'OBSERVED_FLAT_NOW') return false;
  // **세 수치가 모두 0이어야 한다.** null은 "못 읽음"이지 0이 아니다.
  for (const k of ['positions', 'regular', 'algo'] as const) {
    if (o[k] !== 0) return false;
  }
  return true;
}

/**
 * 이 사후 확인으로 미해결 줄의 차단을 풀 수 있는가.
 *
 * 순수 함수다. 네트워크도 DB도 타지 않는다.
 *
 * @param att `steps._attestation`에 적힌 기록 (없으면 null/undefined)
 * @param nowMs 지금. 시험이 시계를 넣는다
 */
export function attestationVerdict(att: any, nowMs: number): AttestationVerdict {
  if (att == null) return no('ABSENT', '사후 확인 기록이 없습니다');
  if (typeof att !== 'object') return no('MALFORMED', '사후 확인 기록이 객체가 아닙니다');
  if (String((att as any).code) !== 'ATTESTED_FLAT') {
    return no('MALFORMED', `사후 확인 기록의 판정이 ATTESTED_FLAT이 아닙니다 (${String((att as any).code)})`);
  }

  const first = (att as any).first;
  const second = (att as any).second;
  // **한 번만 본 것은 두 번 본 것이 아니다.** 여기서 봐주면 간격 요구가
  // 통째로 사라진다 — 그 요구가 이 장치의 전부다.
  if (first == null || second == null) {
    return no('MALFORMED', '관측이 두 번 기록되어 있지 않습니다');
  }
  if (!flat(first) || !flat(second)) {
    return no('NOT_FLAT',
      '두 관측 중 비어 있음을 확인하지 못한 것이 있습니다 — 못 읽은 것과 0건은 다릅니다');
  }

  const t1 = msOf(first.at);
  const t2 = msOf(second.at);
  if (t1 == null || t2 == null) return no('MALFORMED', '관측 시각을 읽지 못했습니다');
  if (t2 - t1 < ATTEST_MIN_GAP_MS) {
    return no('TOO_CLOSE',
      `두 관측 간격이 ${Math.max(0, t2 - t1)}ms입니다 — ${ATTEST_MIN_GAP_MS}ms 이상이어야 합니다`);
  }
  if (!Number.isFinite(nowMs)) return no('MALFORMED', '현재 시각을 모릅니다');
  // 미래 시각은 시계가 틀렸거나 기록이 조작된 것이다. 둘 다 통과시키지 않는다.
  if (t1 > nowMs || t2 > nowMs) return no('STALE', '관측 시각이 미래입니다');
  if (nowMs - t2 > ATTEST_MAX_AGE_MS) {
    return no('STALE',
      `마지막 관측이 ${Math.round((nowMs - t2) / 60_000)}분 전입니다 — 다시 확인합니다`);
  }

  return {
    accepted: true, code: 'ATTESTED_FLAT',
    reason: `간격 ${Math.round((t2 - t1) / 60_000)}분을 둔 두 관측에서 포지션·일반 주문·조건부 주문이 모두 0이었습니다`,
  };
}

// ── 관측을 기록하는 쪽 ──────────────────────────────────────────────
//
// 사람이 할 일은 "노출 해소해" 한 마디다. 나머지는 이 계획기가 정한다 —
// 이번 관측이 **첫 번째**인지, 간격을 채운 **두 번째**인지, 아니면
// 처음부터 다시 봐야 하는지.

export type AttestPhase =
  /** 첫 관측을 적었다. 간격이 지난 뒤 한 번 더 봐야 한다 */
  | 'FIRST'
  /** 두 번째 관측까지 비었다 — 차단이 풀린다 */
  | 'COMPLETED'
  /** 이번 관측에 노출이 보였거나 못 읽었다 — 처음부터 다시 */
  | 'RESET'
  /** 아직 간격이 안 찼다. 기다린다 */
  | 'WAITING';

export interface AttestPlan {
  phase: AttestPhase;
  /** `steps._attestation`에 넣을 값. `RESET`이면 null(지운다) */
  attestation: {
    code: 'ATTESTED_FLAT' | 'PENDING';
    first: AttestationObservation;
    second?: AttestationObservation;
    method: string;
    env: string;
    sha?: string | null;
  } | null;
  reason: string;
  /** 다음 관측까지 남은 ms. `WAITING`에서만 의미가 있다 */
  waitMs: number;
}

/** 거래소 세 조회를 한 번 본 결과를 관측 기록으로 */
export function observationOf(
  v: { code: string; positionCount: number | null; regularOrderCount: number | null; algoOrderCount: number | null },
  atMs: number,
): AttestationObservation {
  return {
    at: new Date(atMs).toISOString(), code: String(v?.code),
    positions: v?.positionCount ?? null,
    regular: v?.regularOrderCount ?? null,
    algo: v?.algoOrderCount ?? null,
  };
}

/**
 * 이번 관측을 받아 다음 상태를 정한다. 순수 함수다.
 *
 * **노출이 보이면 쌓아 둔 것을 버린다.** 첫 관측이 비어 있었고 두 번째에
 * 주문이 보였다면, 그 사이에 뭔가 생긴 것이다. 그 상태에서 세 번째를
 * 기다리는 것은 "비어 있을 때까지 다시 뽑기"가 된다.
 */
export function planAttestation(i: {
  current: any;
  observation: AttestationObservation;
  nowMs: number;
  method: string;
  env: string;
  sha?: string | null;
}): AttestPlan {
  const { observation: obs, nowMs } = i;
  const meta = { method: i.method, env: i.env, sha: i.sha ?? null };

  if (!flat(obs)) {
    return {
      phase: 'RESET', attestation: null, waitMs: 0,
      reason: obs.code === 'OBSERVED_FLAT_NOW'
        ? '관측 수치를 믿을 수 없습니다 — 처음부터 다시 봅니다'
        : `지금 노출이 보이거나 읽지 못했습니다 (${obs.code}) — 처음부터 다시 봅니다`,
    };
  }

  const cur = i.current;
  const curFirst = cur && typeof cur === 'object' ? cur.first : null;
  const t1 = flat(curFirst) ? msOf(curFirst.at) : null;

  // 첫 관측이 없거나, 있어도 유효 기간을 넘겼으면 이번 것이 첫 번째다.
  if (t1 == null || nowMs - t1 > ATTEST_MAX_AGE_MS || t1 > nowMs) {
    return {
      phase: 'FIRST', waitMs: ATTEST_MIN_GAP_MS,
      attestation: { code: 'PENDING', first: obs, ...meta },
      reason: `첫 관측을 적었습니다 — ${Math.round(ATTEST_MIN_GAP_MS / 60_000)}분 뒤 한 번 더 확인합니다`,
    };
  }

  const gap = nowMs - t1;
  if (gap < ATTEST_MIN_GAP_MS) {
    return {
      phase: 'WAITING', waitMs: ATTEST_MIN_GAP_MS - gap,
      attestation: { code: 'PENDING', first: curFirst, ...meta },
      reason: `첫 관측에서 ${Math.round(gap / 60_000)}분 지났습니다 — 간격을 더 둡니다`,
    };
  }

  return {
    phase: 'COMPLETED', waitMs: 0,
    attestation: { code: 'ATTESTED_FLAT', first: curFirst, second: obs, ...meta },
    reason: `간격 ${Math.round(gap / 60_000)}분을 둔 두 관측에서 노출이 0이었습니다`,
  };
}
