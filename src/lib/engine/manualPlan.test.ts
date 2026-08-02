// src/lib/engine/manualPlan.test.ts
//
// 이 테스트가 막는 것: **위험 계층을 우회하는 통로가 조용히 열리는 것.**
//
// `executeOrder`는 `plan.approved`만 보고 주문을 보낸다. 수동 주문에 아무
// 조건 없이 true를 박으면 riskManager를 지나지 않는 길이 생기고, 그 길은
// 코드에서 보이지 않는다. 그래서 approved가 언제 나오는지를 못 박는다.

import { test, eq, assert } from '../../test/harness';
import { buildManualPlan, MANUAL_MAX_LEVERAGE, type ManualOrderInput } from './manualPlan';

/** 통과하는 진입 입력 */
function entry(over: Partial<ManualOrderInput> = {}): ManualOrderInput {
  return {
    symbol: 'BTCUSDT', side: 'BUY', quantity: 0.01, leverage: 10,
    refPrice: 60000, stopPrice: 58000, liquidationPrice: 55000,
    ...over,
  };
}

export function runManualPlanTests() {
  console.log('[수동 주문 계획 — 승인 조건]');

  test('정상 진입은 승인된다', () => {
    const r = buildManualPlan(entry());
    eq(r.plan.approved, true, r.reason);
    eq(r.plan.side, 'LONG');
    eq(r.plan.quantity, 0.01);
    eq(r.plan.leverage, 10);
  });

  test('수동 주문임을 notes에 남긴다 — riskManager 산출과 섞이면 안 된다', () => {
    const notes = buildManualPlan(entry()).plan.notes;
    assert(notes.some(n => n.includes('수동 주문')), `표시가 없다: ${notes.join(' / ')}`);
  });

  test('수량이 0이거나 음수면 승인하지 않는다', () => {
    for (const q of [0, -1, NaN, Infinity]) {
      const r = buildManualPlan(entry({ quantity: q as number }));
      eq(r.plan.approved, false, `수량 ${q}가 통과했다`);
    }
  });

  test('배율이 1 미만이면 승인하지 않는다', () => {
    for (const l of [0, 0.5, -3, NaN]) {
      eq(buildManualPlan(entry({ leverage: l as number })).plan.approved, false, `배율 ${l}이 통과했다`);
    }
  });

  // 배율은 '얼마나 크게 들어가는가'다. 나가는 주문에는 그 질문이 없다.
  // 예전에는 배율 검사가 청산보다 먼저 있어서, 거래소에서 배율을 못 읽으면
  // (0으로 내려오면) 청산까지 `배율이 유효하지 않습니다 (0)`로 막혔다.
  // 청산 화면은 배율을 아예 보내지도 않으므로 이건 상시 위험이었다.
  test('배율을 몰라도 청산은 막지 않는다 — 못 닫는 것이 못 여는 것보다 위험하다', () => {
    for (const l of [0, NaN, undefined as any, null as any]) {
      const r = buildManualPlan(entry({ leverage: l, reduceOnly: true, stopPrice: null }));
      eq(r.plan.approved, true, `배율 ${l}에서 청산이 막혔다: ${r.reason}`);
    }
  });

  test('배율을 못 읽었으면 청산 notes에 그 사실을 남긴다', () => {
    const notes = buildManualPlan(entry({ leverage: 0, reduceOnly: true, stopPrice: null })).plan.notes;
    assert(notes.some(n => n.includes('배율을 확인하지 못')), `표시가 없다: ${notes.join(' / ')}`);
  });

  test('배율이 1 미만이면 진입은 이유를 적고 거부한다', () => {
    const r = buildManualPlan(entry({ leverage: 0 }));
    eq(r.plan.approved, false);
    // "(0)"만 적으면 무엇을 고쳐야 하는지 알 수 없다
    assert(r.reason.includes('확인하지 못'), `무엇을 하라는지가 없다: ${r.reason}`);
  });

  test('배율 상한을 넘으면 승인하지 않는다', () => {
    eq(buildManualPlan(entry({ leverage: MANUAL_MAX_LEVERAGE })).plan.approved, true);
    const over = buildManualPlan(entry({ leverage: MANUAL_MAX_LEVERAGE + 1 }));
    eq(over.plan.approved, false);
    assert(over.reason.includes('상한'), `이유를 적어야 한다: ${over.reason}`);
  });

  test('심볼이 없으면 승인하지 않는다', () => {
    eq(buildManualPlan(entry({ symbol: '' })).plan.approved, false);
  });

  test('심볼의 슬래시를 없애고 대문자로 — BTC/USDT는 거래소에 없는 심볼이다', () => {
    eq(buildManualPlan(entry({ symbol: 'btc/usdt' })).plan.symbol, 'BTCUSDT');
  });

  console.log('[수동 주문 계획 — 손절]');

  test('진입에 손절이 없으면 승인하지 않는다 — 가장 흔한 계좌 소멸 경로다', () => {
    for (const sp of [null, undefined, 0, -5, NaN]) {
      const r = buildManualPlan(entry({ stopPrice: sp as number }));
      eq(r.plan.approved, false, `손절 ${String(sp)}이 통과했다`);
    }
    assert(buildManualPlan(entry({ stopPrice: null })).reason.includes('손절'),
      '이유에 손절을 적어야 한다');
  });

  test('LONG인데 손절이 진입가 위면 승인하지 않는다 — 즉시 체결된다', () => {
    const r = buildManualPlan(entry({ side: 'BUY', refPrice: 60000, stopPrice: 61000 }));
    eq(r.plan.approved, false);
    assert(r.reason.includes('즉시 체결'), `이유를 적어야 한다: ${r.reason}`);
  });

  test('SHORT인데 손절이 진입가 아래면 승인하지 않는다', () => {
    const r = buildManualPlan(entry({ side: 'SELL', refPrice: 60000, stopPrice: 59000 }));
    eq(r.plan.approved, false);
  });

  test('SHORT의 정상 손절은 진입가 위다', () => {
    eq(buildManualPlan(entry({ side: 'SELL', refPrice: 60000, stopPrice: 62000 })).plan.approved, true);
  });

  test('기준가를 모르면 방향 검사를 건너뛴다 — 손절 자체는 여전히 필요하다', () => {
    eq(buildManualPlan(entry({ refPrice: null })).plan.approved, true);
    eq(buildManualPlan(entry({ refPrice: null, stopPrice: null })).plan.approved, false);
  });

  console.log('[수동 주문 계획 — 청산]');

  test('청산은 손절 없이도 승인된다 — 나가는 주문이다', () => {
    const r = buildManualPlan(entry({ reduceOnly: true, stopPrice: null }));
    eq(r.plan.approved, true, r.reason);
  });

  test('청산 SELL은 LONG 포지션을 다룬다 — 뒤집어 기록한다', () => {
    // executeOrder가 reduceOnly를 보고 다시 뒤집어 SELL로 보낸다.
    // 여기서 뒤집지 않으면 롱을 닫으려는 주문이 숏 진입으로 기록된다.
    eq(buildManualPlan(entry({ reduceOnly: true, side: 'SELL' })).plan.side, 'LONG');
    eq(buildManualPlan(entry({ reduceOnly: true, side: 'BUY' })).plan.side, 'SHORT');
  });

  test('진입은 뒤집지 않는다', () => {
    eq(buildManualPlan(entry({ side: 'BUY' })).plan.side, 'LONG');
    eq(buildManualPlan(entry({ side: 'SELL', stopPrice: 62000 })).plan.side, 'SHORT');
  });

  // 수량은 청산에도 필요하다 — 얼마를 닫을지 모르면 주문 자체가 성립하지
  // 않는다. 배율은 아니다(위 '배율을 몰라도 청산은 막지 않는다' 참고).
  test('청산도 수량 검사는 받는다', () => {
    eq(buildManualPlan(entry({ reduceOnly: true, quantity: 0 })).plan.approved, false);
    eq(buildManualPlan(entry({ reduceOnly: true, quantity: NaN as any })).plan.approved, false);
  });

  console.log('[수동 주문 계획 — 방향 왕복 (틀리면 청산이 아니라 두 배가 된다)]');

  // executeOrder는 reduceOnly일 때 plan.side를 **다시 뒤집어** 보낸다.
  // 여기서 뒤집고 거기서 또 뒤집어 원래 방향으로 돌아오는 구조다.
  // 두 곳 중 한 곳만 바뀌면 청산 주문이 같은 방향 진입이 되어 포지션이
  // 두 배가 된다 — 100배 격리에서 그건 즉시 청산이다. 그래서 왕복을 못 박는다.
  const exchangeSideFromPlan = (planSide: 'LONG' | 'SHORT', reduceOnly: boolean) => {
    const posSide = planSide === 'LONG' ? 'BUY' : 'SELL';
    return reduceOnly ? (posSide === 'BUY' ? 'SELL' : 'BUY') : posSide;
  };

  test('롱 청산: SELL로 들어와 SELL로 나간다', () => {
    const p = buildManualPlan(entry({ reduceOnly: true, side: 'SELL', stopPrice: null })).plan;
    eq(p.side, 'LONG', '롱 포지션을 다루는 주문이다');
    eq(exchangeSideFromPlan(p.side, true), 'SELL', '거래소로는 SELL이 나가야 한다');
  });

  test('숏 청산: BUY로 들어와 BUY로 나간다', () => {
    const p = buildManualPlan(entry({ reduceOnly: true, side: 'BUY', stopPrice: null })).plan;
    eq(p.side, 'SHORT');
    eq(exchangeSideFromPlan(p.side, true), 'BUY');
  });

  test('롱 진입: BUY로 들어와 BUY로 나간다', () => {
    const p = buildManualPlan(entry({ side: 'BUY' })).plan;
    eq(p.side, 'LONG');
    eq(exchangeSideFromPlan(p.side, false), 'BUY');
  });

  test('숏 진입: SELL로 들어와 SELL로 나간다', () => {
    const p = buildManualPlan(entry({ side: 'SELL', stopPrice: 62000 })).plan;
    eq(p.side, 'SHORT');
    eq(exchangeSideFromPlan(p.side, false), 'SELL');
  });

  test('네 조합 모두 들어온 방향과 나가는 방향이 같다', () => {
    for (const side of ['BUY', 'SELL'] as const) {
      for (const reduceOnly of [false, true]) {
        const r = buildManualPlan(entry({
          side, reduceOnly,
          // 숏 진입은 손절이 위여야 하고, 청산은 손절이 필요 없다
          stopPrice: reduceOnly ? null : (side === 'BUY' ? 58000 : 62000),
        }));
        eq(r.plan.approved, true, `${side}/${reduceOnly}: ${r.reason}`);
        eq(exchangeSideFromPlan(r.plan.side, reduceOnly), side,
          `${side} ${reduceOnly ? '청산' : '진입'}에서 방향이 뒤집혔다`);
      }
    }
  });

  console.log('[수동 주문 계획 — 계산값]');

  test('명목가와 필요 증거금을 채운다', () => {
    const p = buildManualPlan(entry({ quantity: 0.1, refPrice: 60000, leverage: 10 })).plan;
    eq(p.positionSize, 6000);
    eq(p.requiredMargin, 600);
  });

  test('기준가를 모르면 명목가는 0이다 — 추측하지 않는다', () => {
    const p = buildManualPlan(entry({ refPrice: null })).plan;
    eq(p.positionSize, 0);
    eq(p.requiredMargin, 0);
  });

  test('수량을 다시 계산하지 않는다 — 화면에 적은 숫자와 나간 주문이 같아야 한다', () => {
    eq(buildManualPlan(entry({ quantity: 0.037 })).plan.quantity, 0.037);
  });

  test('청산가는 거래소 값을 그대로 쓰고, 없으면 0이다', () => {
    eq(buildManualPlan(entry({ liquidationPrice: 55000 })).plan.liquidationPrice, 55000);
    eq(buildManualPlan(entry({ liquidationPrice: null })).plan.liquidationPrice, 0);
  });

  test('거부할 때는 항상 사유가 있다', () => {
    for (const bad of [
      entry({ quantity: 0 }), entry({ leverage: 0 }), entry({ symbol: '' }),
      entry({ stopPrice: null }), entry({ leverage: 999 }),
    ]) {
      const r = buildManualPlan(bad);
      eq(r.plan.approved, false);
      assert(r.reason.length > 0, '사유가 없다');
      assert((r.plan as any).rejectReason === r.reason, 'plan에도 사유가 담겨야 한다');
    }
  });
}
