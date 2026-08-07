// src/lib/strategies/costAnalysis.ts
//
// **비용을 빼기 전과 뺀 뒤를 나눠 봐야 무엇을 고칠지 알 수 있다.**
//
// 지금 기대값은 수수료를 이미 뺀 값 하나뿐이다. 그래서 음수가 나와도
// 원인이 둘 중 어느 쪽인지 알 수 없다:
//
//   비용 0에서도 음수  →  **진입 로직 자체에 우위가 없다.**
//                        TP/SL을 만져도, 수수료를 깎아도 안 된다.
//                        신호를 바꿔야 한다.
//
//   비용 0에서는 양수  →  **약한 우위는 있는데 비용을 못 이긴다.**
//                        메이커 주문·거래 횟수 감소·TP 확대로
//                        살릴 수 있다. 신호는 버릴 것이 아니다.
//
// 이 둘은 다음에 할 일이 완전히 다르다. 그런데 지금 화면은 둘 다
// "기대값 -0.05%"로만 보여준다 — 그 숫자로는 어느 쪽인지 모른다.
//
// 스캘핑이 정확히 그 자리에 있다. TP 0.6 / SL 0.3에 왕복 0.09%면
// **손절 폭의 30%가 비용**이다. 우위가 조금 있어도 비용이 먼저 먹는다.
//
// 규칙 하나: **비용을 뺀 값을 '진짜 기대값'으로 쓴다.** 비용 전 값은
// 원인을 가르는 데만 쓰고, 그것으로 전략을 평가하지 않는다 — 실제로
// 나가는 돈에는 수수료가 포함된다.

import type { StrategyProfile } from './profiles';
import { roundTripFeePct, expectancyPctOfNotional, noEdgeWinRate } from './simModel';

export type CostVerdict =
  /** 비용 전에도 음수 — 진입 로직에 우위가 없다 */
  | 'NO_EDGE_AT_ALL'
  /** 비용 전에는 양수인데 비용에 먹힌다 */
  | 'EATEN_BY_COST'
  /** 비용을 넘고도 남는다 */
  | 'SURVIVES_COST'
  /** 판정할 값이 없다 */
  | 'UNKNOWN';

export interface CostBreakdown {
  verdict: CostVerdict;
  /** 수수료를 빼기 **전** 기대값 (명목가 대비 %) */
  beforeCost: number | null;
  /** 수수료를 뺀 **뒤** 기대값 — 이것이 진짜 기대값이다 */
  afterCost: number | null;
  /** 왕복 수수료 (명목가 대비 %) */
  roundTripFeePct: number | null;
  /**
   * 비용이 **손절 폭의 몇 %**인가.
   *
   * 이 값이 클수록 우위가 조금만 흔들려도 부호가 바뀐다. 스캘핑은
   * 30%, 스윙은 1.5% 정도다 — 두 전략의 운명이 갈린 이유가 이것이다.
   */
  feeVsStopPct: number | null;
  /** 비용이 기대값을 얼마나 깎았는가 (%p) */
  costDrag: number | null;
  reason: string;
  /** 무엇을 해야 하는가 */
  nextStep: string;
}

const num = (v: any): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const unknown = (reason: string): CostBreakdown => ({
  verdict: 'UNKNOWN', beforeCost: null, afterCost: null,
  roundTripFeePct: null, feeVsStopPct: null, costDrag: null,
  reason, nextStep: '',
});

/**
 * 비용 전후로 나눠 본다.
 *
 * `winRate`는 0~1이다. 어떤 승률을 가정했는지는 부르는 쪽이 정한다 —
 * 여기서 기본값을 만들면 "무우위 기준으로 본 것"과 "우위를 가정한 것"이
 * 섞인다.
 */
export function costBreakdown(
  p: StrategyProfile | null | undefined, winRate: number | null | undefined,
): CostBreakdown {
  if (!p) return unknown('전략을 찾지 못했습니다');
  const w = num(winRate);
  if (w == null || w < 0 || w > 1) {
    return unknown('승률을 확인하지 못했습니다 — 0~1 사이여야 합니다');
  }

  const fee = roundTripFeePct(p);
  const after = expectancyPctOfNotional(p, w);
  // 비용 전 = 비용 후 + 왕복 수수료. 수수료는 이기든 지든 나가므로
  // 거래 한 건당 정확히 그만큼이다.
  const before = after + fee;

  const sl = num(p.stopLossPct);
  const feeVsStop = sl != null && sl > 0 ? (fee / sl) * 100 : null;

  // **정확히 0인 것을 양수로 읽지 않는다.** 무우위 승률은 TP/SL 비율로
  // 정의되므로 비용 전 기대값이 이론상 0인데, 부동소수 나눗셈을 거치면
  // 1e-17 같은 값이 남는다. 그걸 양수로 읽으면 '우위가 있다'가 되고,
  // 비용/우위 비율은 1e17%처럼 뜻 없는 숫자가 된다.
  const EPS = 1e-9;
  if (before <= EPS) {
    return {
      verdict: 'NO_EDGE_AT_ALL',
      beforeCost: before, afterCost: after, roundTripFeePct: fee,
      feeVsStopPct: feeVsStop, costDrag: fee,
      reason: `수수료를 아예 빼고도 기대값이 ${before.toFixed(4)}%입니다`,
      nextStep: '수수료를 깎거나 거래를 줄여도 해결되지 않습니다 — 진입 신호 자체를 바꿔야 합니다',
    };
  }

  if (after <= 0) {
    return {
      verdict: 'EATEN_BY_COST',
      beforeCost: before, afterCost: after, roundTripFeePct: fee,
      feeVsStopPct: feeVsStop, costDrag: fee,
      reason: `비용 전 +${before.toFixed(4)}% → 비용 후 ${after.toFixed(4)}%`
        + (feeVsStop != null ? ` · 왕복 비용이 손절 폭의 ${feeVsStop.toFixed(0)}%입니다` : ''),
      nextStep: '신호는 버릴 것이 아닙니다 — 메이커 주문, 거래 횟수 감소, TP 확대로 살릴 수 있습니다',
    };
  }

  return {
    verdict: 'SURVIVES_COST',
    beforeCost: before, afterCost: after, roundTripFeePct: fee,
    feeVsStopPct: feeVsStop, costDrag: fee,
    reason: `비용 후에도 +${after.toFixed(4)}%가 남습니다`
      + (feeVsStop != null ? ` · 왕복 비용은 손절 폭의 ${feeVsStop.toFixed(0)}%` : ''),
    nextStep: '실제 캔들 백테스트로 이 승률이 정말 나오는지 확인하세요',
  };
}

/**
 * 이 승률에서 **비용이 우위를 얼마나 먹는가.**
 *
 * 우위(%p)를 넣으면 그 우위가 만든 기대값 중 몇 %가 수수료로 나가는지
 * 돌려준다. 100%를 넘으면 비용이 우위보다 크다는 뜻이다.
 */
export function costShareOfEdge(
  p: StrategyProfile | null | undefined, winRate: number | null | undefined,
): number | null {
  const b = costBreakdown(p, winRate);
  if (b.beforeCost == null || b.roundTripFeePct == null) return null;
  // 먹을 우위가 없다. 여기서 나누면 뜻 없는 큰 수가 나온다.
  if (b.verdict === 'NO_EDGE_AT_ALL' || b.beforeCost <= 1e-9) return null;
  return (b.roundTripFeePct / b.beforeCost) * 100;
}

export const COST_VERDICT_LABEL: Record<CostVerdict, string> = {
  NO_EDGE_AT_ALL: '우위 자체가 없음',
  EATEN_BY_COST: '비용에 먹힘',
  SURVIVES_COST: '비용을 넘김',
  UNKNOWN: '판정 불가',
};

// ── 재현성 ────────────────────────────────────────────────

export interface ReproCheck {
  ok: boolean;
  reason: string;
}

/**
 * 같은 설정이 같은 결과를 내는가.
 *
 * **이게 안 맞으면 시뮬레이터를 믿을 이유가 없다.** 같은 설정을 두 번
 * 돌려 다른 답이 나오면, 두 설정을 비교한 결과도 설정 차이인지 난수
 * 차이인지 알 수 없다.
 *
 * 벽시계를 쓰는 순간 깨지므로(`Date.now()`가 시드에 섞이면 매번 다르다)
 * 이 검사를 테스트에 걸어 두는 것이 실제 방어다.
 */
export function sameResult(a: unknown, b: unknown, label = '결과'): ReproCheck {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) return { ok: true, reason: '' };
  return {
    ok: false,
    reason: `${label}가 두 번 실행에서 달랐습니다 — 같은 설정은 같은 결과를 내야 합니다`,
  };
}

/** 이 프로필의 무우위 승률. 재현성 테스트가 기준으로 쓴다 */
export function baselineWinRate(p: StrategyProfile): number {
  return noEdgeWinRate(p);
}
