// src/lib/strategies/robustness.test.ts
//
// 막으려는 것:
//  1. **가장 많이 번 설정을 고르는 것.** TP 1.03/SL 0.47에서만 좋은 건
//     전략이 좋은 게 아니라 그 격자에서 운이 좋았던 것이다
//  2. 기대값이 양수라고 안전하다고 보는 것 — 큰 베팅은 변동성을 못
//     버티고 먼저 죽는다. 연구용 10슬롯 +5%p가 40/40 파산이었다
//  3. 복리가 만든 수억 %를 실제 기대수익으로 읽는 것
//  4. seed 몇 개로 등급을 주는 것
//  5. 못 읽은 이웃을 '버텼다'로 세어 격자가 듬성듬성할수록 넓어
//     보이게 하는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  requiredEdge, edgeLadder, plateauOf, classify, GRADE_LABEL, MIN_SEEDS,
} from './robustness';

/** 스캘핑: TP 0.6 / SL 0.3 / 왕복 0.09 → 손익분기 약 43.3% */
const SCALP = {
  id: 'SCALP_HIGH_LEV', takeProfitPct: 0.6, stopLossPct: 0.3,
  feePct: 0.045, riskPercentPerTrade: 1, maxLeverage: 10,
} as any;
/** 스윙: TP 12 / SL 6 */
const SWING = {
  id: 'SWING_LOW_LEV', takeProfitPct: 12, stopLossPct: 6,
  feePct: 0.045, riskPercentPerTrade: 1, maxLeverage: 3,
} as any;

export function runRobustnessTests() {
  console.log('[견고성 — 최소 필요 우위]');

  test('스캘핑은 큰 우위를 요구한다', () => {
    // 손절 0.3%에 왕복 비용 0.09%면 손절 폭의 30%가 비용이다.
    const r = requiredEdge(SCALP);
    close(r.noEdgePct, 33.33, 0.1);
    close(r.breakevenPct, 43.33, 0.1);
    close(r.breakevenPp, 10.0, 0.1, '+10%p를 줘야 겨우 본전이다');
    assert(r.safePp > r.breakevenPp, '손익분기 바로 위는 안전하지 않다');
  });

  test('스윙은 아주 작은 우위로도 비용을 넘는다', () => {
    const r = requiredEdge(SWING);
    close(r.noEdgePct, 33.33, 0.1);
    assert(r.breakevenPp < 1, `스윙은 1%p 미만이어야 한다: ${r.breakevenPp}`);
  });

  test('안전 우위는 손익분기보다 최소 2%p 위다', () => {
    // 비용이 조금만 어긋나도 기대값 부호가 바뀌는 구간을 피한다.
    const r = requiredEdge(SWING);
    assert(r.safePp >= r.breakevenPp + 2 - 1e-9, `${r.safePp} vs ${r.breakevenPp}`);
  });

  test('전략이 없으면 지어내지 않는다', () => {
    eq(requiredEdge(null).reason, '전략을 찾지 못했습니다');
  });

  console.log('[견고성 — 우위를 촘촘히 훑는다]');

  test('0/+5/+10 세 점은 너무 성기다', () => {
    // 10슬롯이 +5와 +10 사이에서 완전히 갈렸는데,
    // 세 점으로는 어디서 뒤집히는지 알 수 없다.
    const l = edgeLadder(15, 1);
    eq(l[0], 0);
    eq(l[l.length - 1], 15);
    eq(l.length, 16);
    assert(l.includes(7), '중간 구간이 있어야 한다');
  });

  test('간격을 좁힐 수 있다', () => {
    const l = edgeLadder(2, 0.5);
    eq(l.join(','), '0,0.5,1,1.5,2');
  });

  console.log('[견고성 — 뾰족한 점인가 넓은 구간인가]');

  test('혼자 서 있는 최고점은 과최적화로 본다', () => {
    // TP 1.03/SL 0.47에서만 좋고 양옆은 망한다.
    const p = plateauOf([
      { key: 'a', score: -0.02 },
      { key: 'b', score: 0.5 },
      { key: 'c', score: -0.03 },
    ]);
    eq(p.bestKey, 'b');
    eq(p.broad, false);
    eq(p.overfitRisk, true);
    assert(p.reason.includes('그 한 점'), p.reason);
  });

  test('주변에서도 버티면 넓은 구간이다', () => {
    const p = plateauOf([
      { key: 'a', score: 0.30 },
      { key: 'b', score: 0.40 },
      { key: 'c', score: 0.35 },
    ]);
    eq(p.broad, true);
    eq(p.overfitRisk, false);
  });

  test('못 읽은 이웃을 버틴 것으로 안 센다', () => {
    // 모르는 것을 통과로 세면 격자가 듬성듬성할수록 넓어 보인다.
    const p = plateauOf([
      { key: 'a', score: null },
      { key: 'b', score: 0.4 },
      { key: 'c', score: null },
    ]);
    eq(p.broad, false);
  });

  test('어디서도 양수가 아니면 고를 것이 없다', () => {
    const p = plateauOf([
      { key: 'a', score: -0.1 }, { key: 'b', score: -0.05 }, { key: 'c', score: -0.2 },
    ]);
    eq(p.broad, false);
    eq(p.overfitRisk, false, '고를 것이 없는 것과 과최적화는 다르다');
    assert(p.reason.includes('양수가 아닙'), p.reason);
  });

  test('격자가 좁으면 판정하지 않는다', () => {
    // '넓다'고 하면 뾰족한 점이 통과하고, '좁다'고 하면 멀쩡한 것이 막힌다.
    const p = plateauOf([{ key: 'a', score: 0.4 }, { key: 'b', score: 0.3 }]);
    eq(p.broad, false);
    eq(p.overfitRisk, false);
    eq(p.neighborRatio, null);
  });

  test('빈 격자에도 터지지 않는다', () => {
    eq(plateauOf(null).bestKey, null);
    eq(plateauOf([]).bestScore, null);
  });

  console.log('[견고성 — 등급]');

  const base = {
    seeds: 20, profitableRate: 0.9, ruinRate: 0, medianDrawdownPct: 15,
    expectancyAfterCost: 0.05, medianReturnPct: 500,
    plateau: plateauOf([{ key: 'a', score: 0.3 }, { key: 'b', score: 0.4 }, { key: 'c', score: 0.35 }]),
  };

  test('기대값이 음수면 나머지는 볼 이유가 없다', () => {
    const v = classify({ ...base, expectancyAfterCost: -0.05, ruinRate: 0, medianDrawdownPct: 5 });
    eq(v.grade, 'NO_EDGE');
    eq(v.tradable, false);
    assert(v.nextStep.includes('배율이나 위험을 올려도'), v.nextStep);
  });

  test('복리가 만든 숫자는 그 숫자로 판단하지 않는다', () => {
    const v = classify({ ...base, medianReturnPct: 1_400_000_000 });
    eq(v.grade, 'COMPOUNDING_ARTIFACT');
    eq(v.tradable, false);
  });

  test('기대값이 양수여도 파산이 잦으면 못 쓴다', () => {
    // 연구용 10슬롯 +5%p가 정확히 이랬다 — 기대값은 살짝 플러스인데
    // 40/40 파산.
    const v = classify({ ...base, ruinRate: 1.0 });
    eq(v.grade, 'OVER_RISKED');
    assert(v.reason.includes('먼저 죽습니다'), v.reason);
  });

  test('낙폭이 과해도 마찬가지다', () => {
    const v = classify({ ...base, medianDrawdownPct: 77 });
    eq(v.grade, 'OVER_RISKED');
  });

  test('그 한 점에서만 좋으면 과최적화다', () => {
    const v = classify({
      ...base,
      plateau: plateauOf([{ key: 'a', score: -0.1 }, { key: 'b', score: 0.5 }, { key: 'c', score: -0.1 }]),
    });
    eq(v.grade, 'OVERFIT');
  });

  test('seed가 모자라면 등급을 안 준다', () => {
    const v = classify({ ...base, seeds: 2 });
    eq(v.grade, 'PROMISING');
    eq(v.tradable, false);
    assert(v.nextStep.includes(String(MIN_SEEDS)), v.nextStep);
  });

  test('seed마다 갈리면 평균을 믿지 않는다', () => {
    // 10슬롯 안정화 +5%p가 이랬다 — 55% / 45%로 거의 동전 던지기.
    const v = classify({ ...base, profitableRate: 0.55 });
    eq(v.grade, 'FRAGILE_EDGE');
    assert(v.reason.includes('경로에 크게 의존'), v.reason);
  });

  test('전부 통과해야 견고다 — 그리고 그것도 끝이 아니다', () => {
    const v = classify(base);
    eq(v.grade, 'ROBUST');
    eq(v.tradable, true);
    assert(v.nextStep.includes('실제 캔들 백테스트'), v.nextStep);
    assert(v.nextStep.includes('자금관리만 검증'), '확률 시뮬의 한계를 같이 적어야 한다');
  });

  test('근거가 없으면 등급을 매기지 않는다', () => {
    eq(classify({}).grade, 'UNKNOWN');
    eq(classify(null).grade, 'UNKNOWN');
    eq(classify({ seeds: 100 }).tradable, false);
  });

  test('모든 등급에 한국어 이름이 있다', () => {
    for (const g of Object.keys(GRADE_LABEL)) {
      assert(GRADE_LABEL[g as keyof typeof GRADE_LABEL].length > 0, g);
    }
  });
}
