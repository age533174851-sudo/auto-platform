// src/lib/strategies/monteCarlo.test.ts
//
// 막으려는 것:
//  1. 한 경로가 수익이라는 이유로 '이 전략은 된다'고 읽히는 것
//     — 같은 설정에서 40%가 손실이어도 화면에 걸린 하나는 수익일 수 있다
//  2. 기대값이 음수인데 운 좋은 경로가 통과하는 것
//  3. 실행 불가능한 크기(계좌의 수십 배 명목가)로 번 돈이 결과에 들어가는 것
//  4. 시드가 같은데 결과가 달라 "아까 그 결과"를 다시 못 보는 것
import { test, assert, eq } from '../../test/harness';
import { runMonteCarlo, verdictOf, mulberry32 } from './monteCarlo';

const BASE = {
  trades: 200, paths: 300, startEquity: 1000,
  riskPerTradePct: 1, stopLossPct: 0.3,
  winNetPct: 0.51, lossNetPct: 0.39,   // 스캘핑: TP 0.6 / SL 0.3 / 비용 0.09
  winRate: 0.45,
  seed: 12345,
};

export function runMonteCarloTests() {
  console.log('[몬테카를로 — 한 경로는 증거가 아니다]');

  test('같은 시드는 같은 결과를 준다', () => {
    // Math.random()이면 "아까 그 결과"를 다시 볼 수 없고 테스트도 못 붙인다.
    const a = runMonteCarlo(BASE);
    const b = runMonteCarlo(BASE);
    eq(a.medianEquity, b.medianEquity);
    eq(a.ruinProb, b.ruinProb);
  });

  test('시드가 다르면 경로가 다르다', () => {
    const a = runMonteCarlo(BASE);
    const b = runMonteCarlo({ ...BASE, seed: 999 });
    assert(a.medianEquity !== b.medianEquity, '시드를 무시하고 있다');
  });

  test('경로마다 다른 난수를 쓴다 — 300개가 같은 그림이면 분포가 아니다', () => {
    const r = runMonteCarlo(BASE);
    assert(r.p5Equity < r.p95Equity, `분포가 한 점이다 (${r.p5Equity} ~ ${r.p95Equity})`);
  });

  console.log('[몬테카를로 — 손익분기 승률의 의미]');

  test('손익분기 승률에서는 기대값이 0 근처다', () => {
    // 0.39 / (0.51 + 0.39) = 43.33%
    const w = 0.39 / (0.51 + 0.39);
    const r = runMonteCarlo({ ...BASE, winRate: w });
    assert(Math.abs(r.expectancyPct) < 1e-9, `기대값이 ${r.expectancyPct}다`);
  });

  test('손익분기 아래면 대부분의 경로가 진다', () => {
    // 무우위 33.3%로 돌리면 비용만큼 확실히 깎인다.
    const r = runMonteCarlo({ ...BASE, winRate: 1 / 3 });
    assert(r.expectancyPct < 0, '무우위인데 기대값이 양수다');
    assert(r.profitProb < 0.25, `수익 경로가 ${(r.profitProb * 100).toFixed(0)}%나 된다`);
  });

  test('손익분기 위면 대부분의 경로가 이긴다', () => {
    const r = runMonteCarlo({ ...BASE, winRate: 0.50 });
    assert(r.expectancyPct > 0);
    assert(r.profitProb > 0.75, `수익 경로가 ${(r.profitProb * 100).toFixed(0)}%뿐이다`);
  });

  console.log('[몬테카를로 — 파산과 크기 상한]');

  test('1회 위험이 크면 기대값이 양수여도 파산 경로가 생긴다', () => {
    // 사용자가 지적한 10슬롯의 모양: 1회 위험 10%.
    const r = runMonteCarlo({
      ...BASE, riskPerTradePct: 10, winRate: 0.45, paths: 400, maxLeverage: 100,
    });
    assert(r.ruinProb > 0, '위험 10%인데 파산 경로가 하나도 없다 — 모델이 이상하다');
  });

  test('1회 위험이 작으면 같은 승률에서 파산이 사라진다', () => {
    const r = runMonteCarlo({ ...BASE, riskPerTradePct: 0.5, winRate: 0.45, maxLeverage: 100 });
    eq(r.ruinProb, 0);
  });

  test('배율 상한에 걸린 거래를 세어 둔다', () => {
    // 위험 10% / 손절 0.3% 면 명목가가 계좌의 33배다. 5배 상한이면
    // 설정한 위험대로 실행된 거래가 **한 건도 없다.**
    const r = runMonteCarlo({
      ...BASE, riskPerTradePct: 10, stopLossPct: 0.3, maxLeverage: 5, winRate: 0.45,
    });
    assert(r.cappedTradeRatio > 0.9,
      `상한에 걸린 비율이 ${(r.cappedTradeRatio * 100).toFixed(0)}%뿐이다`);
  });

  test('명목가 상한도 센다 — 유동성 없는 크기로 번 돈은 못 번 돈이다', () => {
    const r = runMonteCarlo({
      ...BASE, winRate: 0.5, maxNotional: 100, paths: 50, trades: 50,
    });
    assert(r.cappedTradeRatio > 0, '명목가 상한이 안 걸린다');
  });

  test('파산선 아래로 가면 그 경로는 거기서 끝난다', () => {
    const r = runMonteCarlo({
      ...BASE, riskPerTradePct: 30, winRate: 0.2, paths: 50, maxLeverage: 100,
    });
    assert(r.ruinProb > 0.5, '거의 확실히 망하는 설정인데 파산이 적다');
    assert(r.p5Equity >= 0, '잔고가 음수로 내려갔다');
  });

  console.log('[몬테카를로 — 실전 연결 판정]');

  test('기대값이 음수면 통과시키지 않는다', () => {
    const v = verdictOf(runMonteCarlo({ ...BASE, winRate: 1 / 3 }));
    eq(v.ok, false);
    eq(v.code, 'NEGATIVE_EXPECTANCY');
  });

  test('기대값이 양수여도 파산 확률이 높으면 막는다', () => {
    const r = runMonteCarlo({
      ...BASE, riskPerTradePct: 15, winRate: 0.46, paths: 300, maxLeverage: 100,
    });
    assert(r.expectancyPct > 0, '이 테스트는 기대값 양수 전제다');
    const v = verdictOf(r);
    eq(v.ok, false);
    eq(v.code, 'RUIN_RISK');
  });

  test('설정한 크기로 실행된 적이 없으면 막는다', () => {
    const r = runMonteCarlo({
      ...BASE, riskPerTradePct: 10, maxLeverage: 5, winRate: 0.5, paths: 200,
    });
    const v = verdictOf(r);
    eq(v.ok, false);
    eq(v.code, 'SIZE_NOT_EXECUTABLE');
  });

  test('통과해도 진입 조건의 우위는 검증되지 않았다고 적는다', () => {
    const v = verdictOf(runMonteCarlo({ ...BASE, winRate: 0.5, maxLeverage: 100 }));
    eq(v.ok, true);
    assert(v.reason.includes('진입 조건'),
      '자금관리 검증을 전략 검증으로 읽히게 두면 안 된다');
  });

  console.log('[몬테카를로 — 난수기]');

  test('mulberry32는 0 이상 1 미만을 준다', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const v = r();
      assert(v >= 0 && v < 1, `범위를 벗어났다: ${v}`);
    }
  });

  test('난수가 한쪽으로 쏠리지 않는다', () => {
    const r = mulberry32(42);
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum += r();
    const mean = sum / 5000;
    assert(Math.abs(mean - 0.5) < 0.03, `평균이 ${mean}이다`);
  });

  test('목표를 주면 달성 확률을 센다', () => {
    const r = runMonteCarlo({
      ...BASE, winRate: 0.5, targetEquity: 1200, maxLeverage: 100,
    });
    assert(r.targetProb != null && r.targetProb > 0);
    eq(runMonteCarlo({ ...BASE, winRate: 0.5, maxLeverage: 100 }).targetProb, null,
      '목표가 없으면 확률도 없다 — 0이 아니다');
  });

  test('승률을 안 주면 조용히 전패로 돌지 않고 멈춘다', () => {
    // 실제로 이 테스트를 쓰다가 winRate를 빠뜨렸고, NaN 비교가 언제나
    // false라 300개 경로가 **전부 전패**로 수렴했다. 오류도 없었고
    // 결과는 그럴듯한 숫자 하나였다.
    let threw = false;
    try { runMonteCarlo({ ...BASE, winRate: undefined as any }); }
    catch { threw = true; }
    eq(threw, true, '조용히 틀리는 쪽이 언제나 더 나쁘다');
  });
}
