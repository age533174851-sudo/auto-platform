// src/lib/strategies/costAnalysis.test.ts
//
// 막으려는 것:
//  1. **"기대값 -0.05%" 하나로 끝내는 것.** 그 숫자로는 진입 로직에
//     우위가 없는 것인지, 약한 우위가 비용에 먹힌 것인지 알 수 없다.
//     둘은 다음에 할 일이 완전히 다르다
//  2. 비용 전 값을 '진짜 기대값'으로 쓰는 것 — 실제로 나가는 돈에는
//     수수료가 포함된다
//  3. 같은 설정이 두 번 다른 답을 내는 것. 그러면 두 설정을 비교한
//     결과도 설정 차이인지 난수 차이인지 알 수 없다
import { test, assert, eq, close } from '../../test/harness';
import {
  costBreakdown, costShareOfEdge, sameResult, COST_VERDICT_LABEL,
} from './costAnalysis';
import { noEdgeWinRate } from './simModel';
import { seedFor, monteCarloInputOf } from './profileMonteCarlo';

/** 스캘핑: TP 0.6 / SL 0.3 / 왕복 0.09 — 손절 폭의 30%가 비용 */
const SCALP = {
  id: 'SCALP_HIGH_LEV', takeProfitPct: 0.6, stopLossPct: 0.3,
  feePct: 0.045, riskPercentPerTrade: 1, maxLeverage: 10,
} as any;
/** 스윙: TP 12 / SL 6 — 같은 비용이 손절 폭의 1.5% */
const SWING = {
  id: 'SWING_LOW_LEV', takeProfitPct: 12, stopLossPct: 6,
  feePct: 0.045, riskPercentPerTrade: 1, maxLeverage: 3,
} as any;

export function runCostAnalysisTests() {
  console.log('[비용 분석 — 원인을 가른다]');

  test('무우위면 비용 전에도 정확히 본전이다', () => {
    // 무우위 승률은 TP/SL 비율로 정의되므로 비용 전 기대값이 0이다.
    const b = costBreakdown(SCALP, noEdgeWinRate(SCALP));
    close(b.beforeCost!, 0, 1e-9);
    eq(b.verdict, 'NO_EDGE_AT_ALL', '비용 전이 0 이하면 우위 자체가 없다');
    assert(b.nextStep.includes('진입 신호 자체를 바꿔야'), b.nextStep);
  });

  test('약한 우위가 비용에 먹히는 경우를 따로 판정한다', () => {
    // 스캘핑 무우위 33.3% · 손익분기 43.3%. 그 사이면 비용 전에는
    // 양수인데 비용 후에는 음수다 — 신호는 버릴 것이 아니다.
    const b = costBreakdown(SCALP, 0.38);
    assert(b.beforeCost! > 0, `비용 전이 양수여야 한다: ${b.beforeCost}`);
    assert(b.afterCost! < 0, `비용 후는 음수여야 한다: ${b.afterCost}`);
    eq(b.verdict, 'EATEN_BY_COST');
    assert(b.nextStep.includes('메이커'), b.nextStep);
    assert(b.nextStep.includes('버릴 것이 아닙니다'), b.nextStep);
  });

  test('비용을 넘기면 그렇게 말한다', () => {
    const b = costBreakdown(SCALP, 0.5);
    eq(b.verdict, 'SURVIVES_COST');
    assert(b.afterCost! > 0);
    assert(b.nextStep.includes('실제 캔들 백테스트'), b.nextStep);
  });

  test('비용 전 = 비용 후 + 왕복 수수료', () => {
    // 수수료는 이기든 지든 나가므로 거래 한 건당 정확히 그만큼이다.
    const b = costBreakdown(SWING, 0.45);
    close(b.beforeCost! - b.afterCost!, b.roundTripFeePct!, 1e-12);
  });

  console.log('[비용 분석 — 두 전략의 운명이 갈린 이유]');

  test('같은 수수료가 스캘핑에는 30%, 스윙에는 1.5%다', () => {
    // 이 한 줄이 왜 스캘핑은 +10%p를 줘도 본전이고 스윙은 +0.5%p로
    // 사는지를 설명한다.
    const s = costBreakdown(SCALP, 0.5);
    const w = costBreakdown(SWING, 0.5);
    close(s.feeVsStopPct!, 30, 0.5);
    close(w.feeVsStopPct!, 1.5, 0.1);
    assert(s.feeVsStopPct! > w.feeVsStopPct! * 10, '차이가 한 자릿수여선 안 된다');
  });

  test('비용이 우위의 몇 %를 먹는지 잰다', () => {
    const share = costShareOfEdge(SCALP, 0.38);
    assert(share != null && share > 100, `비용이 우위보다 크다: ${share}`);
    const ok = costShareOfEdge(SWING, 0.45);
    assert(ok != null && ok < 100, `스윙은 우위가 비용보다 커야 한다: ${ok}`);
  });

  test('먹을 우위가 없으면 비율을 내지 않는다', () => {
    // 0으로 나누거나 음수 비율을 내면 화면에 뜻 없는 숫자가 뜬다.
    eq(costShareOfEdge(SCALP, noEdgeWinRate(SCALP)), null);
  });

  console.log('[비용 분석 — 모르는 것 위에서 판정하지 않는다]');

  test('승률이 없으면 판정하지 않는다', () => {
    eq(costBreakdown(SCALP, null).verdict, 'UNKNOWN');
    eq(costBreakdown(SCALP, 1.5).verdict, 'UNKNOWN', '1을 넘는 승률은 없다');
    eq(costBreakdown(SCALP, -0.1).verdict, 'UNKNOWN');
    eq(costBreakdown(null, 0.5).verdict, 'UNKNOWN');
  });

  test('모든 판정에 한국어 이름이 있다', () => {
    for (const k of Object.keys(COST_VERDICT_LABEL)) {
      assert(COST_VERDICT_LABEL[k as keyof typeof COST_VERDICT_LABEL].length > 0, k);
    }
  });

  console.log('[재현성 — 같은 설정은 같은 결과]');

  test('같은 설정은 같은 시드를 만든다', () => {
    // 벽시계를 쓰는 순간 깨진다. 그러면 "아까 그 결과"를 다시 볼 수 없고,
    // 두 설정을 비교한 결과도 설정 차이인지 난수 차이인지 알 수 없다.
    const a = seedFor(SCALP, 5, 'STABILIZE');
    const b = seedFor(SCALP, 5, 'STABILIZE');
    eq(a, b);
  });

  test('설정이 다르면 시드도 다르다', () => {
    assert(seedFor(SCALP, 5, 'STABILIZE') !== seedFor(SCALP, 6, 'STABILIZE'), '우위');
    assert(seedFor(SCALP, 5, 'STABILIZE') !== seedFor(SCALP, 5, 'RESEARCH'), '프리셋');
    assert(seedFor(SCALP, 5, 'STABILIZE') !== seedFor(SWING, 5, 'STABILIZE'), '전략');
  });

  test('같은 설정은 같은 몬테카를로 입력을 만든다', () => {
    const a = monteCarloInputOf(SCALP, { edgePp: 5, preset: 'STABILIZE' });
    const b = monteCarloInputOf(SCALP, { edgePp: 5, preset: 'STABILIZE' });
    const r = sameResult(a, b, '몬테카를로 입력');
    assert(r.ok, r.reason);
  });

  test('다른 것을 같다고 하지 않는다', () => {
    const r = sameResult({ x: 1 }, { x: 2 }, '입력');
    eq(r.ok, false);
    assert(r.reason.includes('같은 설정은 같은 결과'), r.reason);
  });
}
