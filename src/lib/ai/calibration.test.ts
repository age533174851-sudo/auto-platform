import { test, eq } from '../../test/harness';
import { calibrate, outcomeFromPrices, MIN_SCORED, type PredictionRecord } from './calibration';

export function runCalibrationTests() {
  console.log('[AI 캘리브레이션 — 확신도가 실제로 맞는가]');

  /** 확신도 c로 n건, 그중 hits건이 맞은 기록 */
  function make(n: number, hits: number, c: number): PredictionRecord[] {
    const out: PredictionRecord[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        source: 'consensus', direction: 'bullish', confidence: c,
        outcome: i < hits ? 'bullish' : 'bearish',
      });
    }
    return out;
  }

  test('기록이 없으면 empty — 0%가 아니다', () => {
    const r = calibrate([]);
    eq(r.status, 'empty');
    eq(r.hitRatePct, null);
  });

  test('표본이 부족하면 적중률을 내지 않는다 — 3전 3승이 100%로 적히면 안 된다', () => {
    const r = calibrate(make(3, 3, 90));
    eq(r.status, 'insufficient');
    eq(r.hitRatePct, null);
    eq(r.scored, 3);
    eq(r.summary.includes(`필요 ${MIN_SCORED}건`), true);
  });

  test('결과를 기다리는 것은 맞춘 것도 틀린 것도 아니다', () => {
    const recs: PredictionRecord[] = [
      ...make(20, 20, 90),
      { source: 'c', direction: 'bullish', confidence: 90, outcome: null },
      { source: 'c', direction: 'bullish', confidence: 90, outcome: null },
    ];
    const r = calibrate(recs);
    eq(r.scored, 20);
    eq(r.pending, 2);
    // 대기 중인 것이 분모에 들어가면 100%가 아니게 된다
    eq(r.hitRatePct, 100);
    eq(r.summary.includes('2건 결과 대기'), true);
  });

  test('확신도가 없으면 채점에서 뺀다 — 0으로 채우지 않는다', () => {
    const recs: PredictionRecord[] = [
      ...make(20, 10, 50),
      { source: 'c', direction: 'bullish', confidence: null, outcome: 'bullish' },
    ];
    const r = calibrate(recs);
    eq(r.scored, 20);
    eq(r.unusable, 1);
  });

  test('확신도가 빈 문자열이어도 0으로 읽지 않는다', () => {
    const recs: PredictionRecord[] = [
      ...make(20, 10, 50),
      { source: 'c', direction: 'bullish', confidence: '' as any, outcome: 'bullish' },
    ];
    eq(calibrate(recs).unusable, 1);
  });

  test('방향이 없으면 채점하지 않는다', () => {
    const recs: PredictionRecord[] = [
      ...make(20, 10, 50),
      { source: 'c', direction: null, confidence: 80, outcome: 'bullish' },
    ];
    eq(calibrate(recs).unusable, 1);
  });

  test('90%라 말하고 50%만 맞히면 과신이라고 말한다', () => {
    const r = calibrate(make(20, 10, 90));
    eq(r.status, 'ok');
    eq(r.hitRatePct, 50);
    eq(r.overconfidencePct, 40);
    eq(r.summary.includes('과신'), true);
    // 과신이면서 동시에 기준선보다 나쁘다. 둘 다 적혀야 한다 —
    // 하나만 적으면 '얼마나 나쁜지'나 '왜 나쁜지' 중 하나가 빠진다.
    eq(r.summary.includes('나쁩니다'), true);
  });

  test('60%라 말하고 90% 맞히면 낮춰 말하고 있다고 한다', () => {
    const r = calibrate(make(20, 18, 60));
    eq(r.hitRatePct, 90);
    eq(r.overconfidencePct, -30);
    eq(r.summary.includes('낮게 말하고'), true);
  });

  test('말한 대로 맞으면 잘 맞는다고 한다', () => {
    const r = calibrate(make(20, 16, 80));
    eq(r.hitRatePct, 80);
    eq(r.overconfidencePct, 0);
    eq(r.summary.includes('대체로 맞습니다'), true);
  });

  test('Brier가 0.25보다 나쁘면 "말 안 하는 것만 못하다"고 적는다', () => {
    // 95%라 말하고 30%만 맞으면 Brier는 0.25를 크게 넘는다
    const r = calibrate(make(20, 6, 95));
    eq(r.brier != null && r.brier > 0.25, true);
    eq(r.brierBaseline, 0.25);
    eq(r.summary.includes('나쁩니다'), true);
  });

  test('완벽하면 Brier가 0에 가깝다', () => {
    const r = calibrate(make(20, 20, 100));
    eq(r.brier, 0);
  });

  test('Brier는 방향뿐 아니라 확신 크기도 벌한다', () => {
    // 같은 적중률(50%)인데 확신만 다르다
    const humble = calibrate(make(20, 10, 50));
    const cocky = calibrate(make(20, 10, 95));
    eq(humble.hitRatePct, cocky.hitRatePct);
    eq((cocky.brier as number) > (humble.brier as number), true);
  });

  test('확신도 구간별로 실제 적중률을 나눠 본다', () => {
    const r = calibrate([...make(10, 9, 85), ...make(10, 3, 55)]);
    const b80 = r.buckets.find(b => b.lo === 80)!;
    const b50 = r.buckets.find(b => b.lo === 50)!;
    eq(b80.n, 10);
    eq(b80.actualPct, 90);
    eq(b50.n, 10);
    eq(b50.actualPct, 30);
    // 55라 말하고 30% 맞았으면 과신 25
    eq(b50.gap, 25);
  });

  test('빈 구간은 0%가 아니라 null이다', () => {
    const r = calibrate(make(20, 10, 55));
    const b90 = r.buckets.find(b => b.lo === 90)!;
    eq(b90.n, 0);
    eq(b90.actualPct, null);
    eq(b90.gap, null);
  });

  test('100%는 마지막 구간에 들어간다 — 어느 구간에도 안 들어가면 안 된다', () => {
    const r = calibrate(make(20, 20, 100));
    const total = r.buckets.reduce((a, b) => a + b.n, 0);
    eq(total, 20);
  });

  // ── 정답지 ────────────────────────────────────────────────
  test('가격을 모르면 결과도 모른다 — 보합으로 적지 않는다', () => {
    eq(outcomeFromPrices(null, 100), null);
    eq(outcomeFromPrices(100, null), null);
    eq(outcomeFromPrices(0, 100), null);
  });

  test('거의 안 움직인 것은 보합이다 — 0.01% 올랐다고 상승 적중이 아니다', () => {
    eq(outcomeFromPrices(100, 100.01), 'neutral');
    eq(outcomeFromPrices(100, 99.99), 'neutral');
  });

  test('기준을 넘어야 방향이 된다', () => {
    eq(outcomeFromPrices(100, 100.6, 0.5), 'bullish');
    eq(outcomeFromPrices(100, 99.4, 0.5), 'bearish');
    // 정확히 기준이면 보합 — 경계에서 방향을 만들지 않는다
    eq(outcomeFromPrices(100, 100.5, 0.5), 'neutral');
  });


}
