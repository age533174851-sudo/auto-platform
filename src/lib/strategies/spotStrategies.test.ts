// src/lib/strategies/spotStrategies.test.ts
//
// 막으려는 것:
//  1. 현물 전략이 레버리지·빌린 돈으로 주문을 내는 것
//  2. 전략 하나가 계산을 틀려도 예산·보유를 넘겨 주문이 나가는 것
//  3. 데이터가 모자란데 추정치로 사는 것
import { test, assert, eq } from '../../test/harness';
import {
  runSpotStrategy, decideSpot, clampIntent,
  smaLast, rsiLast, SPOT_STRATEGY_IDS, SPOT_STRATEGY_LABEL,
  type SpotContext, type SpotIntent,
} from './spotStrategies';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const ctx = (over: Partial<SpotContext> = {}): SpotContext => ({
  symbol: 'BTCUSDT',
  price: 100,
  closes: Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5),
  heldQty: 0,
  avgPrice: null,
  budgetUsd: 1000,
  usedUsd: 0,
  portfolioValueUsd: 10_000,
  now: NOW,
  lastBuyAt: null,
  ...over,
});

export function runSpotStrategyTests() {
  console.log('[현물 전략 — 레버리지가 존재하지 않는다]');

  test('의도 객체에 레버리지 관련 필드가 없다', () => {
    // 전략 열 개를 다 돌려 나온 모든 의도를 검사한다.
    const banned = ['leverage', 'marginType', 'reduceOnly', 'margin', 'borrow'];
    for (const id of SPOT_STRATEGY_IDS) {
      const i: SpotIntent = runSpotStrategy(id, ctx({ heldQty: 1, avgPrice: 50 }));
      for (const k of Object.keys(i)) {
        assert(!banned.includes(k), `${id}가 '${k}'를 내보냈다 — 현물에 없는 개념이다`);
      }
    }
  });

  test('전략 10종이 모두 있고 이름이 겹치지 않는다', () => {
    eq(SPOT_STRATEGY_IDS.length, 10);
    eq(new Set(Object.values(SPOT_STRATEGY_LABEL)).size, 10, '이름이 겹친다');
  });

  console.log('[현물 전략 — 엔진이 자른다]');

  test('예산을 넘는 매수는 예산까지만', () => {
    const c = ctx({ budgetUsd: 100, usedUsd: 80 });
    const r = clampIntent({ action: 'BUY', quoteUsd: 500, reason: 'x' }, c);
    eq(r.intent.quoteUsd, 20, '전략이 예산을 넘겨 샀다');
    eq(r.clamped, true);
    assert(!!r.note, '조용히 줄이면 왜 적게 샀는지 모른다');
  });

  test('예산을 다 썼으면 매수하지 않는다', () => {
    const r = clampIntent({ action: 'BUY', quoteUsd: 10, reason: 'x' },
      ctx({ budgetUsd: 100, usedUsd: 100 }));
    eq(r.intent.action, 'HOLD');
  });

  test('보유를 넘는 매도는 보유까지만 — 현물에 공매도는 없다', () => {
    const r = clampIntent({ action: 'SELL', qty: 5, reason: 'x' }, ctx({ heldQty: 2 }));
    eq(r.intent.qty, 2, '없는 물량을 팔았다 — 공매도가 된다');
    assert(r.note!.includes('공매도'), r.note);
  });

  test('보유가 없으면 매도하지 않는다', () => {
    const r = clampIntent({ action: 'SELL', qty: 1, reason: 'x' }, ctx({ heldQty: 0 }));
    eq(r.intent.action, 'HOLD');
  });

  test('어떤 전략도 잘린 뒤에는 예산·보유를 넘지 않는다', () => {
    for (const id of SPOT_STRATEGY_IDS) {
      const c = ctx({ budgetUsd: 50, usedUsd: 40, heldQty: 0.1, avgPrice: 200, price: 400 });
      const r = decideSpot(id, c, { trancheUsd: 9999, sellPct: 500 });
      if (r.intent.action === 'BUY') {
        assert((r.intent.quoteUsd ?? 0) <= 10 + 1e-9, `${id}가 예산을 넘겼다: ${r.intent.quoteUsd}`);
      }
      if (r.intent.action === 'SELL') {
        assert((r.intent.qty ?? 0) <= 0.1 + 1e-9, `${id}가 보유를 넘겼다: ${r.intent.qty}`);
      }
    }
  });

  console.log('[현물 전략 — 모르면 하지 않는다]');

  test('현재가를 모르면 모든 전략이 보류한다', () => {
    for (const id of SPOT_STRATEGY_IDS) {
      const r = runSpotStrategy(id, ctx({ price: null }));
      eq(r.action, 'HOLD', `${id}가 가격 없이 주문했다`);
    }
    for (const bad of [0, -1, NaN]) {
      eq(runSpotStrategy('dca', ctx({ price: bad })).action, 'HOLD', String(bad));
    }
  });

  test('봉이 모자라면 지표 전략은 보류한다', () => {
    const few = ctx({ closes: [100, 101, 102] });
    eq(runSpotStrategy('ma-dca', few, { period: 20 }).action, 'HOLD');
    eq(runSpotStrategy('rsi-dip', few, { period: 14 }).action, 'HOLD');
    eq(runSpotStrategy('breakout', few, { period: 20 }).action, 'HOLD');
  });

  test('포트폴리오 평가액을 모르면 리밸런싱하지 않는다', () => {
    const r = runSpotStrategy('rebalance', ctx({ portfolioValueUsd: null, heldQty: 1 }));
    eq(r.action, 'HOLD', '비중을 모르는 채로 사고팔면 목표와 반대로 갈 수 있다');
  });

  console.log('[현물 전략 — 개별 동작]');

  test('적립식은 주기 안에서는 사지 않는다', () => {
    const inside = ctx({ lastBuyAt: NOW - 3 * DAY });
    eq(runSpotStrategy('dca', inside, { intervalDays: 7 }).action, 'HOLD');
    const outside = ctx({ lastBuyAt: NOW - 8 * DAY });
    eq(runSpotStrategy('dca', outside, { intervalDays: 7 }).action, 'BUY');
  });

  test('첫 실행이면 적립식이 바로 산다', () => {
    eq(runSpotStrategy('dca', ctx({ lastBuyAt: null })).action, 'BUY');
  });

  test('하락 분할매수는 기준 미달이면 안 산다', () => {
    eq(runSpotStrategy('dip-buy', ctx({ avgPrice: 100, price: 98 }), { thresholdPct: 5 }).action, 'HOLD');
    eq(runSpotStrategy('dip-buy', ctx({ avgPrice: 100, price: 94 }), { thresholdPct: 5 }).action, 'BUY');
  });

  test('상승 분할매도는 보유의 일부만 판다', () => {
    const r = runSpotStrategy('scale-out',
      ctx({ avgPrice: 100, price: 120, heldQty: 2 }), { thresholdPct: 10, sellPct: 25 });
    eq(r.action, 'SELL');
    assert(Math.abs(r.qty! - 0.5) < 1e-9, String(r.qty));
  });

  test('리밸런싱은 목표 비중으로 되돌린다', () => {
    // 보유 40개 × 100 = 4000, 전체 10000 → 40%. 목표 30%면 1000어치 매도
    const r = runSpotStrategy('rebalance',
      ctx({ heldQty: 40, price: 100, portfolioValueUsd: 10_000 }),
      { targetWeightPct: 30, driftPct: 5 });
    eq(r.action, 'SELL');
    assert(Math.abs(r.qty! - 10) < 1e-9, String(r.qty));
  });

  test('리밸런싱은 허용 오차 안이면 아무것도 하지 않는다', () => {
    const r = runSpotStrategy('rebalance',
      ctx({ heldQty: 32, price: 100, portfolioValueUsd: 10_000 }),
      { targetWeightPct: 30, driftPct: 5 });
    eq(r.action, 'HOLD', '오차 안인데 매매하면 수수료만 나간다');
  });

  test('이동평균 적립은 평균 아래에서 더 산다', () => {
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);   // 우상향
    const below = runSpotStrategy('ma-dca',
      ctx({ closes: rising, price: 50 }), { period: 20, trancheUsd: 100 });
    const above = runSpotStrategy('ma-dca',
      ctx({ closes: rising, price: 500 }), { period: 20, trancheUsd: 100 });
    assert(below.quoteUsd! > above.quoteUsd!, '평균 아래에서 덜 샀다');
    // 위에서도 적립을 멈추지는 않는다 — 멈추면 상승장에서 못 담는다
    eq(above.action, 'BUY');
  });

  test('RSI 분할매수는 과매도에서만 산다', () => {
    const falling = Array.from({ length: 40 }, (_, i) => 200 - i * 2);
    eq(runSpotStrategy('rsi-dip', ctx({ closes: falling }), { rsiBelow: 30 }).action, 'BUY');
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
    eq(runSpotStrategy('rsi-dip', ctx({ closes: rising }), { rsiBelow: 30 }).action, 'HOLD');
  });

  test('돌파 매수는 직전 최고가를 넘어야 산다', () => {
    const flat = Array.from({ length: 30 }, () => 100);
    eq(runSpotStrategy('breakout', ctx({ closes: flat, price: 100 }), { period: 20 }).action,
      'HOLD', '같은 값인데 돌파로 봤다');
    eq(runSpotStrategy('breakout', ctx({ closes: flat, price: 101 }), { period: 20 }).action, 'BUY');
  });

  test('장기 보유는 절대 팔지 않는다', () => {
    for (const price of [1, 100, 10_000]) {
      const r = runSpotStrategy('hodl', ctx({ heldQty: 1, avgPrice: 100, price }));
      assert(r.action !== 'SELL', `장기 보유가 팔았다 (가격 ${price})`);
    }
  });

  test('장기 보유는 보유가 없을 때만 산다', () => {
    eq(runSpotStrategy('hodl', ctx({ heldQty: 0 })).action, 'BUY');
    eq(runSpotStrategy('hodl', ctx({ heldQty: 1 })).action, 'HOLD');
  });

  test('그리드는 아래에서 사고 위에서 판다', () => {
    const down = runSpotStrategy('grid',
      ctx({ avgPrice: 100, price: 96, heldQty: 1 }), { gridStepPct: 3 });
    eq(down.action, 'BUY');
    const up = runSpotStrategy('grid',
      ctx({ avgPrice: 100, price: 104, heldQty: 1 }), { gridStepPct: 3, sellPct: 50 });
    eq(up.action, 'SELL');
    const mid = runSpotStrategy('grid',
      ctx({ avgPrice: 100, price: 101, heldQty: 1 }), { gridStepPct: 3 });
    eq(mid.action, 'HOLD');
  });

  test('원금 회수는 원금만 팔고 수익분은 남긴다', () => {
    // 1개를 100에 샀고 지금 200 → 수익률 100%. 원금 100어치 = 0.5개만 판다
    const r = runSpotStrategy('profit-recover',
      ctx({ heldQty: 1, avgPrice: 100, price: 200 }), { recoverAtPct: 100 });
    eq(r.action, 'SELL');
    assert(Math.abs(r.qty! - 0.5) < 1e-9, `원금만 팔아야 한다: ${r.qty}`);
    assert(r.reason.includes('수익분은 보유'), r.reason);
  });

  test('원금 회수는 기준 미달이면 팔지 않는다', () => {
    const r = runSpotStrategy('profit-recover',
      ctx({ heldQty: 1, avgPrice: 100, price: 150 }), { recoverAtPct: 100 });
    eq(r.action, 'HOLD');
  });

  console.log('[현물 전략 — 지표]');

  test('이동평균', () => {
    assert(Math.abs(smaLast([1, 2, 3, 4, 5], 5)! - 3) < 1e-9);
    eq(smaLast([1, 2], 5), null, '봉이 모자란데 값을 냈다');
    eq(smaLast([1, 2, 3], 0), null);
  });

  test('RSI는 0~100 안에 있다', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    const ru = rsiLast(up)!, rd = rsiLast(down)!;
    assert(ru > 90, `상승 일변도인데 RSI가 낮다: ${ru}`);
    assert(rd < 10, `하락 일변도인데 RSI가 높다: ${rd}`);
    assert(ru <= 100 && rd >= 0);
  });

  test('RSI는 봉이 모자라면 null', () => {
    eq(rsiLast([1, 2, 3], 14), null);
  });

  test('변화가 없으면 RSI는 중립이다', () => {
    eq(rsiLast(Array.from({ length: 30 }, () => 100)), 50);
  });
}
