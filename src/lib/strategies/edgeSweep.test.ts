// src/lib/strategies/edgeSweep.test.ts
//
// 막으려는 것:
//  1. **중앙값 수익률을 계산 안 하고 0으로 두는 것.** 실제로 한 번
//     그렇게 썼다 — `? 0 : 0`이라 언제나 0이었고, 그러면
//     COMPOUNDING_ARTIFACT 판정이 영영 안 걸린다. 수조 원짜리 결과가
//     ROBUST로 통과한다
//  2. 같은 설정이 두 번 다른 답을 내는 것 — 그러면 두 설정을 비교한
//     결과가 설정 차이인지 난수 차이인지 알 수 없다
//  3. 단조로운 우위 사다리에 plateau를 걸어 '넓다'가 언제나 나오는 것 —
//     검사가 아니라 장식이 된다
//  4. 격자 최고점을 자동 채택해도 되는 것처럼 읽히는 문구
import { test, assert, eq, gt } from '../../test/harness';
import {
  sweepEdges, sweepGrid, GRID_MULTIPLIERS,
  expectancyIdentity, EXPECTANCY_IDENTITY_NOTE,
} from './edgeSweep';
import { SCALP_HIGH_LEV, SWING_LOW_LEV, DAILY_HIGH_LEV } from './profiles';
import { requiredEdge } from './robustness';

// 경로 수는 monteCarloInputOf가 500~1,000으로 묶으므로 줄일 수 없다.
// 대신 거래 수를 줄여 테스트를 빠르게 한다 — 분포의 모양은 유지된다.
const FAST = { paths: 500, trades: 40 } as const;
const FAST_GRID = { paths: 500, trades: 30 } as const;

export function runEdgeSweepTests() {
  console.log('[우위 사다리 — 어디서 뒤집히는가]');

  test('전략이 없으면 지어내지 않는다', () => {
    const r = sweepEdges(null);
    eq(r.points.length, 0);
    eq(r.firstRobustPp, null);
    eq(r.broadRobustZone, false);
    assert(r.summary.includes('찾지 못했'), r.summary);
  });

  test('0부터 15%p까지 1%p 간격 — 16점을 훑는다', () => {
    const r = sweepEdges(SWING_LOW_LEV, FAST);
    eq(r.points.length, 16);
    eq(r.points[0].edgePp, 0);
    eq(r.points[15].edgePp, 15);
  });

  test('무우위에서는 우위가 없다고 판정한다', () => {
    // 무우위 승률은 정의상 기대값 0이고, 수수료를 빼면 음수다.
    const r = sweepEdges(SWING_LOW_LEV, FAST);
    const zero = r.points[0];
    eq(zero.grade, 'NO_EDGE');
    eq(zero.tradable, false);
    eq(zero.costVerdict, 'NO_EDGE_AT_ALL');
    assert(zero.expectancyAfterCost < 0, String(zero.expectancyAfterCost));
  });

  test('우위가 커지면 기대값도 커진다 — 사다리는 단조롭다', () => {
    const r = sweepEdges(SWING_LOW_LEV, FAST);
    for (let i = 1; i < r.points.length; i++) {
      gt(r.points[i].expectancyAfterCost, r.points[i - 1].expectancyAfterCost,
        `+${r.points[i].edgePp}%p가 +${r.points[i - 1].edgePp}%p보다 커야 한다`);
    }
  });

  test('중앙값 수익률을 실제로 계산한다 — 0으로 두지 않는다', () => {
    // 이게 0이면 COMPOUNDING_ARTIFACT가 영영 안 걸린다.
    const r = sweepEdges(SWING_LOW_LEV, FAST);
    const nonZero = r.points.filter(pt => pt.medianReturnPct !== 0);
    gt(nonZero.length, 0, '모든 점의 중앙값 수익률이 정확히 0이면 계산을 안 한 것이다');
    // 무우위에서는 잃어야 하고 큰 우위에서는 벌어야 한다.
    assert(r.points[0].medianReturnPct < 0, String(r.points[0].medianReturnPct));
    assert(r.points[15].medianReturnPct > r.points[0].medianReturnPct,
      '우위가 커졌는데 중앙값 수익률이 안 늘었다');
  });

  test('같은 설정은 같은 결과를 낸다', () => {
    // 벽시계가 시드에 섞이면 여기서 깨진다.
    const a = sweepEdges(SCALP_HIGH_LEV, FAST);
    const b = sweepEdges(SCALP_HIGH_LEV, FAST);
    eq(JSON.stringify(a), JSON.stringify(b), '두 번 돌려 다른 답이 나왔다');
  });

  test('스캘핑은 스윙보다 훨씬 큰 우위를 요구한다', () => {
    // 손절 폭 대비 비용 비중이 크기 때문이다 — 스캘핑은 손절의 30%,
    // 스윙은 1.5%가 수수료다.
    const scalp = requiredEdge(SCALP_HIGH_LEV).breakevenPp;
    const swing = requiredEdge(SWING_LOW_LEV).breakevenPp;
    gt(scalp, swing * 2, `스캘핑 ${scalp} vs 스윙 ${swing}`);

    const s = sweepEdges(SCALP_HIGH_LEV, FAST);
    // 스캘핑은 0%p 근처에서 절대 견고할 수 없다.
    eq(s.points[0].grade, 'NO_EDGE');
    if (s.firstRobustPp != null) {
      gt(s.firstRobustPp, s.breakevenPp - 1e-9, '손익분기 아래에서 견고할 수는 없다');
    }
  });

  test('사다리에는 과최적화 판정을 걸지 않는다', () => {
    // 단조로운 축에서 "최고점 주변이 버티는가"는 언제나 참이라 검사가
    // 아니다. 그 판정은 sweepGrid가 한다.
    const r = sweepEdges(SWING_LOW_LEV, FAST);
    eq(r.points.filter(pt => pt.grade === 'OVERFIT').length, 0);
  });

  test('견고 구간은 이어진 것만 구간으로 센다', () => {
    const r = sweepEdges(SWING_LOW_LEV, FAST);
    if (r.robustFromPp == null) {
      eq(r.broadRobustZone, false);
      return;
    }
    // from~to 사이가 전부 ROBUST여야 한다.
    const inside = r.points.filter(
      pt => pt.edgePp >= r.robustFromPp! && pt.edgePp <= r.robustToPp!);
    for (const pt of inside) {
      eq(pt.grade, 'ROBUST', `+${pt.edgePp}%p가 구간 안인데 견고가 아니다`);
    }
    eq(r.broadRobustZone, inside.length >= 2);
  });

  test('요약에 손익분기와 안전 우위가 같이 나온다', () => {
    const r = sweepEdges(SWING_LOW_LEV, FAST);
    assert(r.summary.includes('손익분기') || r.summary.includes('최소 +'), r.summary);
    assert(r.summary.includes('안전 +'), r.summary);
  });

  console.log('[설정 격자 — 그 한 점에서만 좋은가]');

  test('전략이 없으면 격자도 없다', () => {
    const g = sweepGrid(null);
    eq(g.cells.length, 0);
    eq(g.best, null);
    eq(g.broad, false);
  });

  test('배수 5개면 25칸을 돌린다', () => {
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    eq(GRID_MULTIPLIERS.length, 5);
    eq(g.cells.length, 25);
    eq(g.cells.filter(c => c.isBase).length, 1, '원래 설정 칸이 정확히 하나여야 한다');
  });

  test('원래 설정 칸은 프로필 값 그대로다', () => {
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    eq(g.base!.takeProfitPct, SWING_LOW_LEV.takeProfitPct);
    eq(g.base!.stopLossPct, SWING_LOW_LEV.stopLossPct);
  });

  test('TP를 넓혀도 공짜로 벌지 않는다', () => {
    // 승률을 고정한 채 TP만 넓히면 "익절을 멀리 두면 번다"가 된다.
    // 무우위 승률이 같이 떨어져야 정직하다.
    const g = sweepGrid(SWING_LOW_LEV, { ...FAST_GRID, edgePp: 0 });
    // 무우위에서는 격자 어디에도 양의 기대값이 없어야 한다.
    const positives = g.cells.filter(c => c.expectancyAfterCost > 0);
    eq(positives.length, 0,
      `무우위인데 ${positives.length}칸이 양수다 — 승률 모델이 TP 변화를 안 따라간다`);
  });

  test('격자도 결정적이다', () => {
    const a = sweepGrid(DAILY_HIGH_LEV, FAST_GRID);
    const b = sweepGrid(DAILY_HIGH_LEV, FAST_GRID);
    eq(JSON.stringify(a), JSON.stringify(b));
  });

  test('최고점은 기대값이 가장 큰 칸이 아니다', () => {
    // 기대값 1위는 언제나 격자의 가장 넓은 모서리라, 그걸 최고점으로
    // 삼으면 격자를 돌린 뜻이 없다.
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    const expTop = g.cells.reduce((a, b) =>
      (b.expectancyAfterCost > a.expectancyAfterCost ? b : a));
    assert(g.best!.score! >= expTop.score!,
      `경로 점수 최고(${g.best!.key})가 기대값 최고(${expTop.key})보다 낮다`);
  });

  test('두 방향을 따로 보고, 나쁜 쪽으로 판정한다', () => {
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    eq(g.broad, g.alongTp.broad && g.alongSl.broad);
    eq(g.overfitRisk, !g.broad);
    assert(g.alongTp.reason.length > 0, 'TP 방향 판정 근거가 비었다');
    assert(g.alongSl.reason.length > 0, 'SL 방향 판정 근거가 비었다');
  });

  console.log('[설정 격자 — 기대값으로 줄 세우면 안 되는 이유]');

  test('기대값은 우위 × (익절 + 손절) − 비용이다 — 비율이 지워진다', () => {
    // 이게 무너지면 simModel이나 monteCarlo 중 하나가 바뀐 것이다.
    for (const p of [SCALP_HIGH_LEV, SWING_LOW_LEV, DAILY_HIGH_LEV]) {
      const r = sweepEdges(p, FAST);
      for (const pt of r.points) {
        const want = expectancyIdentity(p, pt.edgePp);
        assert(Math.abs(pt.expectancyAfterCost - want) < 1e-9,
          `${p.id} +${pt.edgePp}%p: 시뮬 ${pt.expectancyAfterCost} vs 공식 ${want}`);
      }
    }
  });

  test('익절/손절 비율을 바꿔도 기대값은 그대로다', () => {
    // 합이 같으면 기대값이 같다. 그래서 기대값으로 격자를 세울 수 없다.
    const a = expectancyIdentity({ ...SWING_LOW_LEV, takeProfitPct: 12, stopLossPct: 6 }, 5);
    const b = expectancyIdentity({ ...SWING_LOW_LEV, takeProfitPct: 15, stopLossPct: 3 }, 5);
    assert(Math.abs(a - b) < 1e-12, `${a} vs ${b} — 합이 18로 같은데 달라졌다`);
  });

  test('기대값 최고 칸은 언제나 격자의 가장 넓은 모서리다', () => {
    // 이 사실을 화면에 같이 내놓지 않으면, 다음 사람이 기대값 열을 보고
    // "익절·손절을 넓히면 되겠네"라고 읽는다. 그건 모델을 읽은 것이다.
    for (const p of [SCALP_HIGH_LEV, SWING_LOW_LEV, DAILY_HIGH_LEV]) {
      const g = sweepGrid(p, FAST_GRID);
      eq(g.expectancyWinnerIsWidest, true, `${p.id}: ${g.expectancyWinnerKey}`);
    }
  });

  test('줄 세우기는 기대값이 아니라 경로 결과로 한다', () => {
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    // 점수는 수익 경로 비율이다.
    for (const c of g.cells) {
      if (c.expectancyAfterCost > 0) eq(c.score, c.profitProb, c.key);
      else eq(c.score, null, `${c.key} — 기대값이 0 이하인데 점수가 있다`);
    }
    for (const c of g.cells) {
      if (c.score == null) continue;
      assert(c.score <= g.best!.score! + 1e-12, `${c.key}가 최고점보다 크다`);
    }
  });

  test('요약이 줄 세우기 기준을 밝힌다', () => {
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    assert(g.summary.includes('기대값이 아니라 경로 결과로'), g.summary);
    assert(g.summary.includes(EXPECTANCY_IDENTITY_NOTE), g.summary);
  });

  test('격자 전체가 음수면 최고점을 만들지 않는다', () => {
    // 무우위 격자에서 "그래도 이 칸이 제일 낫다"고 하면, 지는 설정
    // 스물다섯 개 중 하나를 고르라는 말이 된다.
    const g = sweepGrid(SWING_LOW_LEV, { ...FAST_GRID, edgePp: 0 });
    eq(g.best, null);
    eq(g.robustCells, 0);
    assert(g.summary.includes('줄 세울 것이 없습니다'), g.summary);
  });

  test('격자 최고점을 채택하라고 말하지 않는다', () => {
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    assert(!/채택|적용하세요|바꾸세요/.test(g.summary), g.summary);
    if (g.best!.key !== g.base!.key) {
      assert(g.summary.includes('근거는 여기에 없습니다'), g.summary);
    }
  });

  test('배수가 세 개 미만이면 기본 격자로 돌아간다', () => {
    // 이웃을 볼 수 없는 격자에서는 plateau 판정이 뜻을 잃는다.
    const g = sweepGrid(SWING_LOW_LEV, { ...FAST_GRID, multipliers: [1] });
    eq(g.cells.length, 25);
  });

  test('우위를 안 주면 안전 우위를 가정한다', () => {
    const g = sweepGrid(SWING_LOW_LEV, FAST_GRID);
    const safe = requiredEdge(SWING_LOW_LEV).safePp;
    assert(Math.abs(g.edgePp - safe) < 0.01, `${g.edgePp} vs ${safe}`);
  });
}
