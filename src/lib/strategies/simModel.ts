// src/lib/strategies/simModel.ts
//
// 모의 승패를 무엇으로 정하는가
// ─────────────────────────────
// 예전에는 `Math.random() < 0.5`였다. 익절 1.5% / 손절 0.5%짜리 전략을
// 동전 던지기로 돌린 것이다. 그건 돈 찍는 기계다 — 한 건의 기대값이
// 명목가의 +0.5%이고, 복리로 1000번 돌리면 화면에 이런 게 뜬다.
//
//   누적손익 +238,790,256,334,269,830,000,000,000,000,000,000
//
// 숫자가 커서 이상한 게 아니라 **전제가 틀려서** 이상한 것이다. 이 화면을
// 보고 "이 전략은 되는구나"라고 읽으면, 그 판단은 시뮬이 아니라 시뮬의
// 버그를 근거로 한 것이 된다.
//
// 우위가 없으면 승률은 이미 정해져 있다
// ──────────────────────────────────────
// 방향을 못 맞히는 사람이 익절 T / 손절 S를 걸면, 익절이 먼저 닿을 확률은
// 대략 S / (S + T)다. 1.5% 익절에 0.5% 손절이면 25%다. 50%가 아니다.
// 그 25%에서 기대값은 정확히 0이고, 수수료를 빼면 마이너스다.
//
// 그래서 여기서는 **무우위 승률을 기준선으로 놓고**, 사용자가 "내 신호가
// 이만큼 낫다"고 가정한 만큼만 더한다. 그 가정이 화면에 숫자로 적힌다.
// 그러면 시뮬이 답을 주는 대신 질문을 준다 — "이 전략이 되려면 승률이
// 몇 %p 더 높아야 하는가."

import type { StrategyProfile } from './profiles';

/** 왕복 수수료(테이커 진입 + 테이커 청산). 명목가 대비 %. */
export function roundTripFeePct(p: StrategyProfile): number {
  const t = p.takerFeePct > 0 ? p.takerFeePct : 0.045;   // 바이낸스 선물 테이커 기본
  return t * 2;
}

/**
 * 우위가 없을 때의 승률(0~1).
 *
 * 익절이 손절보다 멀수록 먼저 닿을 확률이 낮다. 이게 "손익비가 좋으면
 * 승률이 낮아도 된다"의 뒷면이다 — 좋은 손익비는 공짜가 아니라 **낮은
 * 승률과 맞바꾼 것**이다.
 */
export function noEdgeWinRate(p: StrategyProfile): number {
  const s = Number(p.stopLossPct), t = Number(p.takeProfitPct);
  if (!(s > 0) || !(t > 0)) return 0.5;
  return s / (s + t);
}

/** 실제로 쓸 승률 = 무우위 기준선 + 가정한 우위(%p). 0~1로 자른다. */
export function assumedWinRate(p: StrategyProfile, edgePp = 0): number {
  const w = noEdgeWinRate(p) + (Number(edgePp) || 0) / 100;
  return Math.max(0, Math.min(1, w));
}

/**
 * 한 건의 기대값 — **명목가 대비 %**.
 *
 * 자산 대비가 아니다. 명목가는 증거금 × 배율이라, 자산 대비 기대값은
 * 이 값에 (증거금 비중 × 배율)을 곱한 것이다. 100배를 쓰면 여기 적힌
 * 0.1%가 자산의 1%가 된다 — 우위가 커지는 게 아니라 손실도 같이 커진다.
 */
export function expectancyPctOfNotional(p: StrategyProfile, winRate: number): number {
  const w = Math.max(0, Math.min(1, Number(winRate) || 0));
  return w * p.takeProfitPct - (1 - w) * p.stopLossPct - roundTripFeePct(p);
}

/**
 * 기대값이 0이 되는 승률(0~1) — "이 전략이 본전이라도 하려면 얼마나
 * 맞혀야 하는가". 수수료를 포함하므로 무우위 기준선보다 항상 높다.
 */
export function breakevenWinRate(p: StrategyProfile): number {
  const denom = p.takeProfitPct + p.stopLossPct;
  if (!(denom > 0)) return 1;
  const w = (p.stopLossPct + roundTripFeePct(p)) / denom;
  return Math.max(0, Math.min(1, w));
}

/** 이 거래의 손익 — 명목가 대비 %. 수수료는 이기든 지든 나간다. */
export function tradePnlPctOfNotional(p: StrategyProfile, win: boolean): number {
  return (win ? p.takeProfitPct : -p.stopLossPct) - roundTripFeePct(p);
}

/** 화면에 적을 우위 선택지. 기준선(0%p)이 기본이다. */
// **이 목록은 전부 '가정'이다.**
//
// 사용자가 이렇게 읽었다: "우위 10%를 넣으면 수익이 나고 빼면 청산이
// 쏟아진다." 맞는 관찰이지만, 그건 전략의 성질이 아니라 **산수의
// 성질**이다 — 승률을 올려 넣었으니 결과가 좋아지는 것이 당연하다.
//
// 그래서 이름에 '가정'을 박아 넣는다. 한 점에서만 좋은지도 봐야 하므로
// 촘촘하게 둔다(2·15·20 추가) — +10에서만 좋고 +9·+11에서 나쁘면 그건
// 난수나 임계값이 만든 무늬다(`edgeFragility` 참고).
export const EDGE_CHOICES: Array<{ pp: number; label: string; note: string }> = [
  { pp: 0,  label: '무우위',        note: '방향을 못 맞힌다고 가정 — 수수료만큼 진다. 가장 보수적인 기준선' },
  { pp: 2,  label: '가정 +2%p',     note: '신호가 기준선보다 2%p 더 맞힌다고 **가정**' },
  { pp: 5,  label: '가정 +5%p',     note: '신호가 기준선보다 5%p 더 맞힌다고 **가정**' },
  { pp: 10, label: '가정 +10%p',    note: '신호가 기준선보다 10%p 더 맞힌다고 **가정** — 측정값이 아닙니다' },
  { pp: 15, label: '가정 +15%p',    note: '이 정도 우위가 실제로 있는 전략은 드뭅니다' },
  { pp: 20, label: '가정 +20%p',    note: '이 가정에서만 좋아 보인다면 그건 전략이 아니라 가정의 힘입니다' },
];
