// src/lib/engine/exitPlan.test.ts
// 분할 익절 수량이 틀리면 거래소가 주문을 거부하거나(단위 불일치),
// 보유량보다 많이 청산하려 든다. 그 경계를 고정한다.
import { test, assert, eq, close } from '../../test/harness';
import { buildExitPlan, DEFAULT_PARTIAL_LADDER } from './exitPlan';

export function runExitPlanTests() {
  console.log('[비대칭 청산 계획]');

  const base = {
    side: 'LONG' as const,
    entryPrice: 100_000,
    stopPrice: 99_000,      // 1R = 1,000
    quantity: 1,
  };

  test('손절은 항상 전량이다 (수량 미지정 = closePosition)', () => {
    const p = buildExitPlan(base);
    const stops = p.orders.filter(o => o.kind === 'STOP');
    eq(stops.length, 1, '손절 주문이 1건이 아니다');
    eq(stops[0].quantity, undefined, '손절에 수량이 지정됐다 — 분할 체결 후 잔량과 어긋난다');
    eq(stops[0].price, base.stopPrice);
  });

  test('분할 익절 가격이 R 배수와 일치한다', () => {
    const p = buildExitPlan(base);
    const partials = p.orders.filter(o => o.kind === 'PARTIAL_TP');
    eq(partials.length, DEFAULT_PARTIAL_LADDER.length);
    // 1R = 1,000이므로 1.5R = 101,500 / 3R = 103,000
    close(partials[0].price, 101_500, 1e-6, `1.5R 가격이 ${partials[0].price}`);
    close(partials[1].price, 103_000, 1e-6, `3R 가격이 ${partials[1].price}`);
  });

  test('SHORT은 반대 방향으로 계산된다', () => {
    const p = buildExitPlan({ ...base, side: 'SHORT', stopPrice: 101_000 });
    const partials = p.orders.filter(o => o.kind === 'PARTIAL_TP');
    // 1R = 1,000, SHORT이므로 아래로
    close(partials[0].price, 98_500, 1e-6, `SHORT 1.5R 가격이 ${partials[0].price}`);
  });

  test('분할 수량 합계가 보유량을 넘지 않는다', () => {
    const p = buildExitPlan(base);
    const sum = p.orders
      .filter(o => o.kind === 'PARTIAL_TP')
      .reduce((a, o) => a + (o.quantity ?? 0), 0);
    assert(sum < base.quantity, `분할 합계 ${sum}이 보유량 ${base.quantity} 이상이다`);
    close(sum + p.trailingQty, base.quantity, 1e-9, '분할 + 트레일링 잔량이 보유량과 다르다');
  });

  test('수량 단위(stepSize)에 맞춰 내림한다', () => {
    // 0.37 * 30% = 0.111 → step 0.01이면 0.11
    const p = buildExitPlan({ ...base, quantity: 0.37, qtyStep: 0.01 });
    const partials = p.orders.filter(o => o.kind === 'PARTIAL_TP');
    for (const o of partials) {
      const q = o.quantity ?? 0;
      const remainder = Math.abs(q / 0.01 - Math.round(q / 0.01));
      assert(remainder < 1e-6, `수량 ${q}가 단위 0.01의 배수가 아니다`);
    }
  });

  test('최소 주문 수량 미만인 분할은 건너뛰고 이유를 남긴다', () => {
    // 0.003 * 30% = 0.0009 < minQty 0.001
    const p = buildExitPlan({ ...base, quantity: 0.003, qtyStep: 0.001, minQty: 0.001 });
    const partials = p.orders.filter(o => o.kind === 'PARTIAL_TP');
    eq(partials.length, 0, '최소 수량 미만인데 분할 주문이 생성됐다');
    assert(p.notes.length > 0, '건너뛴 이유가 기록되지 않았다');
    close(p.trailingQty, 0.003, 1e-9, '분할이 없으면 전량이 트레일링 잔량이어야 한다');
    // 손절은 그래도 걸린다 — 손실은 고정된다
    eq(p.orders.filter(o => o.kind === 'STOP').length, 1, '분할이 없어도 손절은 있어야 한다');
  });

  test('트레일링 잔량이 남으면 감시가 필요하다고 남긴다', () => {
    const p = buildExitPlan(base);
    assert(p.trailingQty > 0, '기본 사다리(30+30)면 40%가 남아야 한다');
    assert(p.notes.some(n => n.includes('트레일링')), '트레일링 안내가 없다');
    assert(p.trailStartR > 0 && p.trailDistanceR > 0, '트레일링 파라미터가 비어 있다');
  });
}
