// src/lib/supabase/usageBudget.ts
//
// **한도에 닿기 전에 말한다.**
//
// 지금 있는 것과 없는 것
// ──────────────────────
// `quotaBreaker`는 **402가 난 뒤에** 반응한다. 그건 이미 늦은 자리다 —
// 그 시점에는 자동매매·예약 청산·감시가 이미 끊긴 뒤다(실제로 그랬다:
// 2026-10-23 21:03 KST `exceed_egress_quota`).
//
// 여기는 그 앞이다. 쓰는 양이 포함량의 70 · 85 · 95%를 지날 때 단계별로
// 알리고, 95%부터는 **한가한 일만** 줄인다.
//
// 이것이 아닌 것
// ──────────────
// **결제를 막지 않는다.** 경고와 자체 제한일 뿐이고, Supabase 쪽 과금을
// 멈추는 기능이 아니다. 하드 캡은 이 코드가 제공할 수 없다 — 요금제의
// spend cap 설정은 대시보드에서 사람이 켜는 것이고, 그 상태를 여기서
// 읽지 않는다. 경고를 차단으로 오해하면 안 된다.
//
// 못 읽은 것을 0%로 읽지 않는다
// ─────────────────────────────
// 사용량을 못 읽었는데 "0%니까 괜찮다"로 적으면, 한도를 넘긴 상태에서
// 조용히 계속 쓴다. 모르면 `UNKNOWN`이고, **보호 경로는 그래도 돈다.**

export type UsageTier =
  /** 70% 미만 */
  | 'OK'
  /** 70% 이상 */
  | 'NOTICE'
  /** 85% 이상 */
  | 'WARN'
  /** 95% 이상 */
  | 'CRITICAL'
  /** 100% 이상 — 초과 과금 또는 서비스 제한 구간 */
  | 'EXCEEDED'
  /** **못 읽었다.** 0%가 아니다 */
  | 'UNKNOWN';

/** 단계가 바뀌는 지점. 값으로 둔다 — 여러 곳에 숫자를 적지 않는다. */
export const USAGE_TIERS: Array<{ tier: UsageTier; atPct: number }> = [
  { tier: 'EXCEEDED', atPct: 100 },
  { tier: 'CRITICAL', atPct: 95 },
  { tier: 'WARN', atPct: 85 },
  { tier: 'NOTICE', atPct: 70 },
];

/** 이 단계부터 한가한 일을 쉬게 한다. 보호 경로는 해당 없다. */
const THROTTLE_FROM: UsageTier[] = ['CRITICAL', 'EXCEEDED'];

export interface UsageVerdict {
  tier: UsageTier;
  /** 0~100+. 못 읽었으면 null — **0으로 적지 않는다** */
  pct: number | null;
  /** 한가한(ROUTINE) 조회를 쉬게 할 것인가 */
  throttleRoutine: boolean;
  /** 사람에게 알릴 단계인가 (OK·UNKNOWN 아래로는 알리지 않는다) */
  shouldAlert: boolean;
  reason: string;
}

const num = (v: any): number | null => {
  // **`Number(null)`은 0이다.** 그대로 쓰면 "못 읽음"이 0%가 되고,
  // 한도를 넘긴 상태에서 "여유 있음"으로 적힌다. 빈 값은 먼저 거른다.
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 지금 어느 단계인가.
 *
 * `used`·`included`는 같은 단위면 무엇이든 된다(바이트·요청 수 등).
 * 둘 중 하나라도 읽지 못했으면 `UNKNOWN`이다.
 */
export function usageVerdict(i: {
  /** 이번 주기에 쓴 양. 환경변수로 올 수 있어 문자열도 받는다 */
  used: number | string | null | undefined;
  /** 요금제에 포함된 양. 0이나 음수면 비율을 낼 수 없다 */
  included: number | string | null | undefined;
}): UsageVerdict {
  const used = num(i?.used);
  const included = num(i?.included);
  if (used == null || included == null) {
    return {
      tier: 'UNKNOWN', pct: null, throttleRoutine: false, shouldAlert: true,
      reason: '사용량을 읽지 못했습니다 — 0%로 읽지 않습니다. 보호 경로는 계속 돕니다',
    };
  }
  if (included <= 0) {
    return {
      tier: 'UNKNOWN', pct: null, throttleRoutine: false, shouldAlert: true,
      reason: `포함량이 ${included}입니다 — 비율을 낼 수 없습니다`,
    };
  }
  if (used < 0) {
    return {
      tier: 'UNKNOWN', pct: null, throttleRoutine: false, shouldAlert: true,
      reason: `사용량이 음수(${used})입니다 — 믿을 수 없는 값입니다`,
    };
  }

  const pct = (used / included) * 100;
  const hit = USAGE_TIERS.find((t) => pct >= t.atPct);
  const tier: UsageTier = hit ? hit.tier : 'OK';
  const throttleRoutine = THROTTLE_FROM.includes(tier);
  return {
    tier, pct,
    throttleRoutine,
    shouldAlert: tier !== 'OK',
    reason: tier === 'OK'
      ? `포함량의 ${pct.toFixed(1)}% — 여유가 있습니다`
      : `포함량의 ${pct.toFixed(1)}%${throttleRoutine ? ' — 한가한 조회를 쉬게 합니다 (보호 경로는 그대로)' : ''}`,
  };
}

/**
 * 같은 단계를 두 번 알리지 않는다.
 *
 * 매 주기 같은 경고가 나가면 사람이 읽지 않게 되고, 그러면 진짜 단계가
 * 올라갔을 때도 묻힌다. **내려갔다 다시 올라가면 다시 알린다.**
 */
export function shouldSendUsageAlert(prevTier: UsageTier | null | undefined, next: UsageVerdict): boolean {
  if (!next.shouldAlert) return false;
  return prevTier !== next.tier;
}

/**
 * 이 조회를 지금 보내도 되는가.
 *
 * **보호 경로는 어떤 단계에서도 막지 않는다.** 열린 100배 포지션이
 * 방치되는 쪽이 초과 과금보다 비싸다. 아끼는 것은 한가한 쪽에서만 한다.
 */
export function usageAllows(verdict: UsageVerdict, kind: 'PROTECTION' | 'ROUTINE'): boolean {
  if (kind === 'PROTECTION') return true;
  return !verdict.throttleRoutine;
}
