// src/lib/strategies/ladderSizing.ts
// 10배 계단식 증거금 + 사이클 락.
//
// 핵심: 복리가 아니다. 구간 안에서는 증거금이 고정되고,
// 계좌가 이전 단계의 10배를 달성했을 때만 증거금이 10배 올라간다.
//
//   $100 ~ $999      → $10
//   $1,000 ~ $9,999  → $100
//   $10,000 ~ $99,999 → $1,000
//   $100,000 도달     → 사이클 종료 → 전략 자본을 $100으로 리셋 (초과분은 보호 자산)
//
// 승급/강등 기준을 분리한다(히스테리시스). $1,000을 찍었다 $950이 됐다고
// 증거금이 계속 오르내리면 안 된다.

export interface LadderTier {
  index: number;
  minEquity: number;
  maxEquity: number;
  margin: number;         // 1회 격리 증거금
  label: string;
}

export const LADDER_TIERS: LadderTier[] = [
  { index: 0, minEquity: 100,     maxEquity: 999.99,    margin: 10,    label: '1단계' },
  { index: 1, minEquity: 1000,    maxEquity: 9999.99,   margin: 100,   label: '2단계' },
  { index: 2, minEquity: 10000,   maxEquity: 99999.99,  margin: 1000,  label: '3단계' },
];

export const CYCLE_TARGET = 100_000;   // 이 금액 도달 시 사이클 종료
export const CYCLE_BASE = 1_000;       // 사이클 시작·리셋 시 전략 자본

// 참고: 1단계($100~$999)는 확정 명세의 운용 구간이 아니다. 사이클은 $1,000
// (= 2단계)에서 시작한다. 1단계는 손실로 자본이 $1,000 아래로 내려갔을 때
// 곧바로 거래 불가가 되지 않도록 두는 방어 구간이다.

// 강등은 승급보다 늦게 — 구간 하단의 이 비율 아래로 내려가야 강등
export const DEMOTE_BUFFER = 0.8;      // 예: 2단계($1,000~) → $800 아래로 가야 1단계

export interface LadderState {
  currentTierIndex: number;
  strategyCapital: number;      // 이 전략에 배정된 자본 (전체 자산 아님)
  realizedEquity: number;       // 확정 잔고 (미실현 제외)
  cycleNumber: number;
  cycleStartAt: string;
  protectedProfit: number;      // 사이클 완료로 빼놓은 수익 누적
  cycleLocked: boolean;         // 목표 달성 → 신규 진입 정지
  lockReason?: string;
}

export interface LadderDecision {
  tier: LadderTier;
  margin: number;
  promoted: boolean;
  demoted: boolean;
  cycleComplete: boolean;
  locked: boolean;
  message: string;
  nextPromotionAt?: number;     // 다음 승급까지 필요한 잔고
  progressPct: number;          // 현재 구간 진행률
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function tierForEquity(equity: number): LadderTier {
  for (let i = LADDER_TIERS.length - 1; i >= 0; i--) {
    if (equity >= LADDER_TIERS[i].minEquity) return LADDER_TIERS[i];
  }
  return LADDER_TIERS[0];
}

/**
 * 계단 판정.
 * 승급: 잔고가 다음 구간 하한 이상 → 즉시 승급
 * 강등: 잔고가 현재 구간 하한 × DEMOTE_BUFFER 아래 → 강등 (히스테리시스)
 */
export function evaluateLadder(state: LadderState): LadderDecision {
  const equity = state.realizedEquity;

  // ── 사이클 목표 달성 ──
  if (equity >= CYCLE_TARGET) {
    return {
      tier: LADDER_TIERS[LADDER_TIERS.length - 1],
      margin: 0,
      promoted: false, demoted: false,
      cycleComplete: true, locked: true,
      message: `사이클 ${state.cycleNumber} 목표 $${CYCLE_TARGET.toLocaleString()} 달성 — 신규 진입을 정지하고 수익을 보호합니다. 포지션 정리 후 $${CYCLE_BASE}로 새 사이클을 시작하세요.`,
      progressPct: 100,
    };
  }

  if (state.cycleLocked) {
    return {
      tier: LADDER_TIERS[state.currentTierIndex] || LADDER_TIERS[0],
      margin: 0, promoted: false, demoted: false,
      cycleComplete: false, locked: true,
      message: state.lockReason || '사이클이 잠겨 있습니다',
      progressPct: 0,
    };
  }

  const current = LADDER_TIERS[clamp(state.currentTierIndex, 0, LADDER_TIERS.length - 1)];
  const naturalTier = tierForEquity(equity);

  let tier = current;
  let promoted = false, demoted = false;

  // 승급: 다음 구간 하한 도달
  if (naturalTier.index > current.index) {
    tier = naturalTier;
    promoted = true;
  }
  // 강등: 현재 구간 하한 × 버퍼 아래로
  else if (equity < current.minEquity * DEMOTE_BUFFER && current.index > 0) {
    tier = LADDER_TIERS[current.index - 1];
    demoted = true;
  }

  // 자본이 최소 구간 아래면 거래 불가
  if (equity < LADDER_TIERS[0].minEquity) {
    return {
      tier: LADDER_TIERS[0], margin: 0,
      promoted: false, demoted, cycleComplete: false, locked: true,
      message: `전략 자본 $${equity.toFixed(0)}이 최소 $${LADDER_TIERS[0].minEquity} 미만 — 거래할 수 없습니다`,
      progressPct: 0,
    };
  }

  const nextTier = LADDER_TIERS[tier.index + 1];
  const nextPromotionAt = nextTier ? nextTier.minEquity : CYCLE_TARGET;
  const span = nextPromotionAt - tier.minEquity;
  const progressPct = clamp(((equity - tier.minEquity) / (span || 1)) * 100, 0, 100);

  let message = `${tier.label} · 1회 증거금 $${tier.margin}`;
  if (promoted) message = `승급! ${tier.label}로 올라가 증거금이 $${tier.margin}이 됩니다`;
  if (demoted) message = `강등: ${tier.label}로 내려가 증거금이 $${tier.margin}이 됩니다`;

  return {
    tier, margin: tier.margin, promoted, demoted,
    cycleComplete: false, locked: false,
    message, nextPromotionAt, progressPct,
  };
}

/**
 * 사이클 완료 처리 — 초과 수익을 보호 자산으로 빼고 자본을 리셋한다.
 * 실제 총자산을 $100으로 만드는 게 아니라, 이 전략의 기준 자본만 리셋한다.
 */
export interface CycleResetResult {
  newCapital: number;
  protectedAmount: number;    // 이번 사이클에서 빼놓는 금액
  totalProtected: number;     // 누적 보호 금액
  newCycleNumber: number;
  summary: string;
}

export function completeCycle(state: LadderState): CycleResetResult {
  const excess = Math.max(0, state.realizedEquity - CYCLE_BASE);
  return {
    newCapital: CYCLE_BASE,
    protectedAmount: excess,
    totalProtected: state.protectedProfit + excess,
    newCycleNumber: state.cycleNumber + 1,
    summary: `사이클 ${state.cycleNumber} 완료: $${excess.toLocaleString()}을 보호 자산으로 분리하고 $${CYCLE_BASE}로 사이클 ${state.cycleNumber + 1}을 시작합니다. 포지션 명목 규모가 무한정 커지지 않습니다.`,
  };
}

// 사이클 성공에 필요한 대략적 조건 (사용자에게 보여줄 정보)
export function cycleDifficulty(winRate: number, riskReward: number, riskPerTradePct = 20): {
  evPerTrade: number; tradesPerTier: number; totalDays: number; feasible: boolean;
} {
  const r = riskPerTradePct / 100;
  const ev = winRate * riskReward * r - (1 - winRate) * r;
  if (ev <= 0) return { evPerTrade: ev * 100, tradesPerTier: Infinity, totalDays: Infinity, feasible: false };
  // 구간 통과 = 계좌 10배 = 증거금 대비 약 90배 수익
  const tradesPerTier = Math.ceil(90 / ev);
  return {
    evPerTrade: ev * 100,
    tradesPerTier,
    totalDays: tradesPerTier * LADDER_TIERS.length,   // 하루 1회이므로 거래수 = 일수
    feasible: true,
  };
}
