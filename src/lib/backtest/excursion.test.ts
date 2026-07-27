// src/lib/backtest/excursion.test.ts
//
// MFE 상한과 실현 수익을 구분하는 것이 이 테스트의 목적이다.
// "최대 +8%까지 갔다"는 것과 "봇이 +8%를 먹었다"는 전혀 다른 말이다.
import { test, assert, eq, lt, close } from '../../test/harness';
import { measureExcursion, survivalAt, realizedAt, type Bar } from './excursion';

export function runExcursionTests() {
  console.log('[MFE 상한 vs 실현 수익]');

  // 진입 100,000 → 잠깐 눌렸다가 +8%까지 갔다가 +3%로 마감
  const upThenBack: Bar[] = [
    { high: 100_400, low:  99_700, close: 100_200 },
    { high: 103_000, low: 100_100, close: 102_800 },
    { high: 108_000, low: 102_500, close: 107_000 },   // MFE +8%
    { high: 107_200, low: 103_000, close: 103_500 },   // 되돌림
    { high: 104_000, low: 102_800, close: 103_000 },   // +3% 마감
  ];

  test('MFE는 최고점을 기록한다', () => {
    const ex = measureExcursion('LONG', 100_000, upThenBack);
    close(ex.mfePct, 8, 1e-6, `MFE가 ${ex.mfePct}`);
    close(ex.closePct, 3, 1e-6, `종가 수익률이 ${ex.closePct}`);
  });

  test('실현 수익은 MFE 상한을 넘지 않는다', () => {
    const ex = measureExcursion('LONG', 100_000, upThenBack);
    const s = survivalAt(ex, 10);
    const r = realizedAt(ex, 10);
    assert(r !== null, '봉이 보존되지 않아 실현 계산을 못 했다');
    assert(s.survived, '10배에서 청산됐다: ' + s.reason);
    lt(r!.returnPct, s.mfeUpperBoundPct! + 1e-6,
      `실현 ${r!.returnPct.toFixed(1)}%가 상한 ${s.mfeUpperBoundPct!.toFixed(1)}%를 넘었다`);
  });

  test('되돌림이 있으면 실현이 상한보다 확실히 낮다 — 최고점을 못 먹는다', () => {
    const ex = measureExcursion('LONG', 100_000, upThenBack);
    const s = survivalAt(ex, 10);
    const r = realizedAt(ex, 10)!;
    // +8%까지 갔다가 +3%로 마감했으므로 상한의 100%를 먹을 수 없다
    assert(r.captureRatio !== null, 'captureRatio가 계산되지 않았다');
    lt(r.captureRatio!, 0.999,
      `되돌림이 있는데 상한을 100% 먹었다고 나온다 (capture ${(r.captureRatio! * 100).toFixed(0)}%)`);
  });

  console.log('[봉 내부 순서 — 보수적 판정]');

  test('한 봉이 청산가와 익절가를 둘 다 스치면 청산을 먼저 적용한다', () => {
    // 100배 → 청산거리 약 0.5%. 이 봉은 저가 -1%(청산 통과)와 고가 +5%를 모두 담는다.
    // OHLC만으로는 순서를 알 수 없으므로 청산이 먼저였다고 봐야 한다.
    const bothInOneBar: Bar[] = [
      { high: 105_000, low: 99_000, close: 104_000 },
    ];
    const ex = measureExcursion('LONG', 100_000, bothInOneBar);
    const r = realizedAt(ex, 100)!;
    eq(r.liquidated, true, '같은 봉에서 청산가를 스쳤는데 청산되지 않았다 — 낙관 편향');
    lt(r.returnPct, 0, `청산됐는데 수익이 ${r.returnPct}로 나온다`);
  });

  test('MAE가 청산거리를 넘으면 생존 판정도 실패한다', () => {
    const deepDip: Bar[] = [
      { high: 100_200, low: 98_000, close: 100_100 },   // -2% → 100배 청산
    ];
    const ex = measureExcursion('LONG', 100_000, deepDip);
    const s = survivalAt(ex, 100);
    eq(s.survived, false);
    eq(s.mfeUpperBoundPct, null, '청산됐는데 상한값이 남아 있다');
  });

  test('SHORT도 같은 규칙으로 판정된다', () => {
    // 숏 진입 후 위로 2% → 100배면 청산
    const upBar: Bar[] = [{ high: 102_000, low: 99_500, close: 101_000 }];
    const ex = measureExcursion('SHORT', 100_000, upBar);
    const s = survivalAt(ex, 100);
    eq(s.survived, false, 'SHORT에서 반대 방향 이동이 청산으로 잡히지 않았다');
  });

  console.log('[손절 규칙]');

  test('손절은 청산거리 안쪽에 잡힌다', () => {
    const ex = measureExcursion('LONG', 100_000, upThenBack);
    const r = realizedAt(ex, 100)!;
    const liqDist = (1 / 100 - 0.005) * 100;   // 0.5%
    lt(r.stopPct, liqDist, `손절 ${r.stopPct}%가 청산거리 ${liqDist}% 밖에 있다 — 청산이 먼저 온다`);
  });

  test('봉이 없으면 실현 계산을 시도하지 않고 null을 돌려준다', () => {
    const ex = measureExcursion('LONG', 100_000, upThenBack);
    const stripped = { ...ex, bars: undefined };
    eq(realizedAt(stripped, 10), null, '봉이 없는데 값을 만들어냈다');
  });
}
