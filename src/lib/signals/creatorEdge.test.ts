// src/lib/signals/creatorEdge.test.ts
//
// 이 테스트가 막는 것
// ───────────────────
// **"자주 틀리니까 반대로 하면 이긴다"는 착각.**
//
// 승률 40%의 반대가 승률 60%가 되지 않는다. 두 다리 모두 수수료와
// 미끄러짐을 내기 때문에, 순방향이 -0.4R이어도 역방향이 +0.4R이 되지
// 않는다 — 둘 다 마이너스인 경우가 가장 흔하다. 그 사실이 숫자로
// 나오는지 여기서 못 박는다.
//
// 그리고 **결과를 보고 사람을 고르는 편향.** 학습 구간에서만 좋은 것은
// 그 구간을 보고 고른 결과일 수 있다. 검증 구간에서 사라지면 판정하지
// 않는다.

import { test, eq, assert, close } from '../../test/harness';
import {
  gateSignal, simulatePair, scoreR, judgeCreator, verdictLabel,
  type CreatorSignal, type PricePoint, type SimConfig,
} from './creatorEdge';

const T0 = 1_770_000_000_000;

const CFG: SimConfig = {
  feePctPerSide: 0.045,
  slippagePct: 0.02,
  delaySec: 30,
  maxHoldSec: 3600,
  takePct: null,
};

const SIG = (over: Partial<CreatorSignal> = {}): CreatorSignal => ({
  creatorId: 'c1', symbol: 'BTCUSDT', direction: 'LONG',
  saidAtMs: T0, kind: 'EXPLICIT_ENTRY', confidence: 0.9,
  stopLoss: 59400,   // 60000에서 -1%
  ...over,
});

/** t0 이후 초 단위로 가격을 늘어놓는다 */
const path = (prices: number[], stepSec = 30): PricePoint[] =>
  prices.map((p, i) => ({ t: T0 + i * stepSec * 1000, price: p }));

export function runCreatorEdgeTests() {
  console.log('[공개 트레이더 — 발언을 신호로 태울 수 있는가]');

  test('실제 진입 발언만 태운다', () => {
    eq(gateSignal(SIG()).tradeable, true);
    for (const k of ['OPINION', 'LONG_TERM', 'RECAP', 'QUESTION', 'AD', 'JOKE', 'UNKNOWN'] as const) {
      const g = gateSignal(SIG({ kind: k }));
      eq(g.tradeable, false, `${k}가 신호로 통과했다`);
    }
  });

  // "비트는 언젠가 오를 것 같습니다"를 숏 신호로 읽으면 안 된다.
  test('장기 전망을 매매 신호로 세지 않는다 — 이유까지 말한다', () => {
    const g = gateSignal(SIG({ kind: 'LONG_TERM' }));
    assert(g.reason.includes('진입 발언이 아닙'), g.reason);
  });

  test('확신도를 안 적었으면 모르는 것이다 — 1로 치지 않는다', () => {
    const g = gateSignal(SIG({ confidence: undefined }));
    eq(g.tradeable, false);
    assert(g.missing.includes('confidence'), g.missing.join(','));
  });

  test('확신도가 기준에 못 미치면 안 태운다', () => {
    eq(gateSignal(SIG({ confidence: 0.5 })).tradeable, false);
    eq(gateSignal(SIG({ confidence: 0.5 }), { minConfidence: 0.4 }).tradeable, true);
  });

  // 손절을 우리가 정해 주면 그 성과는 그 사람의 성과가 아니다.
  test('손절을 말하지 않으면 기본적으로 안 태운다', () => {
    const g = gateSignal(SIG({ stopLoss: null }));
    eq(g.tradeable, false);
    assert(g.reason.includes('손절 정책의 성과'), g.reason);
    eq(gateSignal(SIG({ stopLoss: null }), { allowMissingStop: true }).tradeable, true);
  });

  test('필수 값이 없으면 무엇이 없는지 적는다', () => {
    const g = gateSignal({ creatorId: '', symbol: '', saidAtMs: 0 } as any);
    eq(g.tradeable, false);
    assert(g.missing.length >= 3, g.missing.join(','));
  });

  console.log('[공개 트레이더 — 순방향·역방향 짝 시뮬레이션]');

  // ── 이 파일의 핵심 ──
  //
  // 순방향이 손절로 끝났다고 해서 역방향이 그만큼 벌지 않는다.
  // 두 다리가 각자 비용을 내기 때문이다.
  test('같은 지점에서 끝나면 두 다리 합은 반드시 음수다 — 비용을 낸다', () => {
    // 손절에 안 닿고 둘 다 시간 청산 → 같은 가격에서 끝난다.
    // **부호 반전이면 합이 정확히 0이다.** 수수료·미끄러짐 때문에 음수여야 한다.
    const r = simulatePair(SIG(), path([60000, 60000, 60050, 60100]), { ...CFG, maxHoldSec: 60 });
    const f = r.follow!, i = r.inverse!;
    eq(f.exitReason, 'TIME');
    eq(i.exitReason, 'TIME');
    assert(f.rMultiple + i.rMultiple < 0,
      `두 다리 합이 0 이상이다 — 비용이 안 들어갔다: ${f.rMultiple + i.rMultiple}`);
  });

  // 한쪽이 손절되면 다른 쪽은 그만큼 벌지 않는다. 손절은 정해진 자리에서
  // 끊기고 반대쪽은 계속 가기 때문에, 두 다리는 **대칭이 아니다.**
  // "승률 40%의 반대는 60%"가 성립하지 않는 이유가 정확히 이것이다.
  test('한쪽이 손절되면 두 다리는 대칭이 아니다', () => {
    const r = simulatePair(SIG(), path([60000, 60000, 59900, 59300, 59000]), CFG);
    const f = r.follow!, i = r.inverse!;
    eq(f.exitReason, 'STOP', '롱이 손절되지 않았다');
    eq(i.exitReason, 'TIME', '숏은 계속 갔어야 한다');
    assert(Math.abs(Math.abs(f.rMultiple) - Math.abs(i.rMultiple)) > 0.1,
      `크기가 같다 — 부호만 뒤집고 있다: ${f.rMultiple} / ${i.rMultiple}`);
  });

  // 양쪽이 다 손실인 경우가 가장 흔하다. 그게 나오는지 본다.
  test('둘 다 손절되는 경우가 있다 — 왕복하면 양쪽 다 잃는다', () => {
    // 위로 1% 넘게 갔다가(숏 손절) 아래로 1% 넘게 간다(롱 손절)
    const r = simulatePair(SIG(), path([60000, 60700, 59300]), { ...CFG, delaySec: 0 });
    eq(r.follow!.exitReason, 'STOP');
    eq(r.inverse!.exitReason, 'STOP');
    assert(r.follow!.rMultiple < 0 && r.inverse!.rMultiple < 0,
      '양쪽 다 손실이어야 한다');
  });

  test('두 다리는 완전히 같은 조건을 쓴다 — 진입 시각·위험거리가 같다', () => {
    const r = simulatePair(SIG(), path([60000, 60100, 60200, 60300]), CFG);
    // 지연 30초 · 간격 30초 → 두 번째 점(60100)이 기준가다.
    // 위험거리가 같으므로 R의 절대 스케일이 같고, 진입가도 같은 기준가에서 나온다.
    close(r.follow!.entryPrice, 60100 * 1.0002, 1e-6);   // 롱은 불리하게 위로
    close(r.inverse!.entryPrice, 60100 * 0.9998, 1e-6);  // 숏은 불리하게 아래로
  });

  // 방송은 늦게 나간다. 지연을 0으로 두면 볼 수 없었던 가격에 체결한다.
  test('방송 지연만큼 늦게 체결한다 — 볼 수 없었던 가격을 쓰지 않는다', () => {
    // 30초 간격 · 지연 30초 → 두 번째 점(60500)에 체결
    const r = simulatePair(SIG(), path([60000, 60500, 60600]), CFG);
    close(r.follow!.entryPrice, 60500 * 1.0002, 1e-6);
  });

  test('지연 뒤의 가격이 없으면 체결가를 지어내지 않는다', () => {
    const r = simulatePair(SIG(), [{ t: T0 - 1000, price: 60000 }], { ...CFG, delaySec: 30 });
    eq(r.follow, null);
    assert(r.skipped.includes('지어내지 않'), r.skipped);
  });

  test('가격 경로가 없으면 돌리지 않는다', () => {
    eq(simulatePair(SIG(), [], CFG).follow, null);
  });

  // 같은 봉에서 손절과 익절에 다 닿았으면 나쁜 쪽으로 센다.
  test('손절과 익절이 함께 닿으면 손절로 센다 — 유리하게 읽지 않는다', () => {
    const cfg = { ...CFG, takePct: 1, delaySec: 0 };
    // 한 점에서 아래로 크게 빠진다. 롱은 손절이어야 한다.
    const r = simulatePair(SIG(), path([60000, 58000]), cfg);
    eq(r.follow!.exitReason, 'STOP');
  });

  test('최대 보유시간을 넘으면 시장가로 끝낸다', () => {
    const r = simulatePair(SIG(), path([60000, 60050, 60100, 60150]), { ...CFG, maxHoldSec: 60 });
    eq(r.follow!.exitReason, 'TIME');
  });

  test('손절가가 없으면 기본 손절 %로 위험거리를 만든다', () => {
    const r = simulatePair(SIG({ stopLoss: null }), path([60000, 60000, 59000]),
      { ...CFG, defaultStopPct: 1 });
    assert(r.follow != null, r.skipped);
    eq(r.follow!.exitReason, 'STOP');
  });

  test('손절가도 기본 %도 없으면 돌리지 않는다', () => {
    const r = simulatePair(SIG({ stopLoss: null }), path([60000, 61000]), CFG);
    eq(r.follow, null);
    assert(r.skipped.includes('위험거리'), r.skipped);
  });

  console.log('[공개 트레이더 — 성과 집계]');

  test('기대값·승률·손익비·최대낙폭', () => {
    const s = scoreR([1, -1, 2, -1]);
    eq(s.n, 4);
    close(s.expectancyR, 0.25, 1e-9);
    close(s.winRate, 0.5, 1e-9);
    close(s.profitFactor!, 1.5, 1e-9);
    close(s.totalR, 1, 1e-9);
  });

  test('최대 낙폭은 누적 곡선의 고점 대비로 센다', () => {
    // 누적: 3, 1, 0, 2 → 고점 3에서 0까지 = 3
    close(scoreR([3, -2, -1, 2]).maxDrawdownR, 3, 1e-9);
  });

  // Infinity를 성과로 적으면 화면이 '무한히 좋다'로 그린다.
  test('손실이 없으면 손익비는 null이다 — Infinity를 적지 않는다', () => {
    eq(scoreR([1, 2, 3]).profitFactor, null);
  });

  test('표본이 없으면 0으로 채우되 n도 0이다', () => {
    eq(scoreR([]).n, 0);
    eq(scoreR([NaN as any, undefined as any]).n, 0);
  });

  console.log('[공개 트레이더 — 최종 판정]');

  const many = (v: number, n: number) => Array.from({ length: n }, () => v);

  // **표본 부족은 '우위 없음'이 아니다.**
  test('표본이 모자라면 판정하지 않는다 — 우위 없음과 다른 말이다', () => {
    const j = judgeCreator({
      inSample: { follow: many(0.5, 20), inverse: many(-0.6, 20) },
      outOfSample: { follow: many(0.5, 20), inverse: many(-0.6, 20) },
    });
    eq(j.verdict, 'INSUFFICIENT_DATA');
    assert(j.reason.includes('20건'), j.reason);
  });

  test('검증 구간이 모자라도 판정하지 않는다', () => {
    const j = judgeCreator({
      inSample: { follow: many(0.5, 120), inverse: many(-0.6, 120) },
      outOfSample: { follow: many(0.5, 5), inverse: many(-0.6, 5) },
    });
    eq(j.verdict, 'INSUFFICIENT_DATA');
    assert(j.reason.includes('보고 고른'), j.reason);
  });

  test('두 구간 모두 순방향이 우위면 FOLLOW', () => {
    const j = judgeCreator({
      inSample: { follow: many(0.3, 120), inverse: many(-0.4, 120) },
      outOfSample: { follow: many(0.25, 40), inverse: many(-0.35, 40) },
    });
    eq(j.verdict, 'FOLLOW');
  });

  test('두 구간 모두 역방향이 우위면 INVERSE', () => {
    const j = judgeCreator({
      inSample: { follow: many(-0.4, 120), inverse: many(0.2, 120) },
      outOfSample: { follow: many(-0.35, 40), inverse: many(0.15, 40) },
    });
    eq(j.verdict, 'INVERSE');
  });

  // ── 이 파일의 두 번째 핵심 ──
  //
  // 학습 구간에서만 좋은 것은 그 구간을 보고 고른 결과일 수 있다.
  test('검증 구간에서 사라지면 판정하지 않고, 왜인지 말한다', () => {
    const j = judgeCreator({
      inSample: { follow: many(-0.5, 150), inverse: many(0.4, 150) },
      outOfSample: { follow: many(-0.1, 50), inverse: many(-0.08, 50) },
    });
    eq(j.verdict, 'NO_EDGE');
    assert(j.reason.includes('검증 구간에서 사라졌'), j.reason);
    assert(j.reason.includes('역방향'), j.reason);
  });

  // 가장 흔한 결과다. 이게 제대로 나와야 한다.
  test('둘 다 비용을 못 넘으면 NO_EDGE — 가장 흔한 결과다', () => {
    const j = judgeCreator({
      inSample: { follow: many(-0.2, 120), inverse: many(-0.15, 120) },
      outOfSample: { follow: many(-0.18, 40), inverse: many(-0.12, 40) },
    });
    eq(j.verdict, 'NO_EDGE');
    assert(j.reason.includes('비용을 넘지 못'), j.reason);
  });

  // 같은 신호를 양방향으로 돌렸는데 둘 다 벌 수는 없다.
  test('양쪽 다 우위로 나오면 시뮬레이션을 의심한다', () => {
    const j = judgeCreator({
      inSample: { follow: many(0.3, 120), inverse: many(0.3, 120) },
      outOfSample: { follow: many(0.3, 40), inverse: many(0.3, 40) },
    });
    eq(j.verdict, 'NO_EDGE');
    assert(j.reason.includes('성립할 수 없'), j.reason);
  });

  // **사람을 단정하지 않는다.** 분쟁 위험이 있고, 무엇보다 사실이 아니다.
  test('화면 문구가 사람을 단정하지 않는다', () => {
    for (const v of ['FOLLOW', 'INVERSE', 'NO_EDGE', 'INSUFFICIENT_DATA'] as const) {
      const s = verdictLabel(v);
      assert(s.length > 0);
      assert(!/틀리는|실패한|청산 전문|무조건/.test(s), '단정하는 표현이다: ' + s);
    }
    assert(verdictLabel('INVERSE').includes('관측 구간'),
      '언제나 그렇다는 뜻으로 읽힌다: ' + verdictLabel('INVERSE'));
  });
}
