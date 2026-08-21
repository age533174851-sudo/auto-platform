// src/lib/strategies/tradeIdentity.test.ts
//
// **"100배"라는 이름과 실제 숫자가 맞는가.**
//
// 화면에 100배라고 적혀 있어도 증거금 → 명목 → 가격변화 → 수수료 →
// 손익이 서로 맞지 않으면 이름만 100배다. 그리고 레버리지는 기대값을
// 만들지 않는다 — 손익을 확대할 뿐이다. 1회 기대값이 음수면 100배는
// 파산을 앞당긴다.
//
// 우위도 같다. 화면의 `우위 +10%p`는 **입력한 가정**이다. 켜면 수익이
// 나고 끄면 청산이 쏟아지는 것은 전략의 성질이 아니라 산수의 성질이다.

import { test, eq, assert } from '../../test/harness';
import { tradeIdentity, edgeClaimOf, edgeFragility } from './tradeIdentity';

export function runTradeIdentityTests() {
  console.log('[100배 — 숫자가 서로 맞는가]');

  test('**증거금 $10 × 100배 = 명목 $1,000**', () => {
    // BTC 60,000에서 명목 1,000이면 수량은 1/60이다.
    const r = tradeIdentity({
      marginUsd: 10, requestedLeverage: 100, actualLeverage: 100,
      quantity: 1000 / 60000, entryPrice: 60000,
    });
    eq(r.code, 'OK');
    assert(Math.abs(r.notionalUsd! - 1000) < 1e-6, String(r.notionalUsd));
    assert(Math.abs(r.effectiveLeverage! - 100) < 1e-3, String(r.effectiveLeverage));
  });

  test('**증거금 × 배율과 실제 명목이 다르면 잡는다**', () => {
    // 100배라고 적혀 있는데 명목은 500뿐 — 둘 중 하나는 화면에 잘못 적혔다.
    const r = tradeIdentity({
      marginUsd: 10, requestedLeverage: 100, actualLeverage: 100,
      quantity: 500 / 60000, entryPrice: 60000,
    });
    eq(r.code, 'NOTIONAL_MISMATCH');
    eq(r.ok, false);
    assert(/잘못 적힌/.test(r.reason), r.reason);
  });

  test('**요청 100배인데 거래소가 75배만 걸었으면 그 사실을 말한다**', () => {
    const r = tradeIdentity({
      marginUsd: 10, requestedLeverage: 100, actualLeverage: 75,
      quantity: 750 / 60000, entryPrice: 60000,
    });
    eq(r.code, 'LEVERAGE_MISMATCH');
    assert(r.notes.some(n => /요청 100배 · 실제 75배/.test(n)), JSON.stringify(r.notes));
  });

  test('**이름은 100배인데 실질 노출이 작으면 숨기지 않는다**', () => {
    // 명목 상한이나 수량 규격 때문에 실제로는 5배 수준인 경우.
    const r = tradeIdentity({
      marginUsd: 100, requestedLeverage: 100, actualLeverage: 5,
      quantity: 500 / 60000, entryPrice: 60000,
    });
    assert(r.notes.some(n => /실질 배율/.test(n)), JSON.stringify(r.notes));
    eq(r.effectiveLeverage, 5);
  });

  test('**모르는 값이 있으면 통과가 아니다**', () => {
    // 실제 배율을 모른다고 요청값으로 대신하지 않는다 —
    // 그 대입이 "이름만 100배"를 만든다.
    eq(tradeIdentity({ marginUsd: 10, requestedLeverage: 100 }).code, 'INCOMPLETE');
    eq(tradeIdentity({ marginUsd: 10, quantity: 1, entryPrice: 0 }).code, 'INCOMPLETE');
    eq(tradeIdentity({}).ok, false);
  });

  console.log('[100배 — 손절 한 번에 얼마가 사라지는가]');

  test('손절 거리와 손실이 증거금 대비로 나온다', () => {
    // 명목 1,000 · 손절 1% · 왕복 수수료 0.1% → 손실 10 + 1 = 11
    const r = tradeIdentity({
      marginUsd: 10, requestedLeverage: 100, actualLeverage: 100,
      quantity: 1000 / 60000, entryPrice: 60000,
      stopPrice: 59400, side: 'LONG', roundTripFeePct: 0.1,
    });
    assert(Math.abs(r.stopMovePct! - 1) < 1e-6, String(r.stopMovePct));
    assert(Math.abs(r.lossAtStopUsd! - 11) < 1e-6, String(r.lossAtStopUsd));
    eq(r.lossOfMarginPct, 110);
  });

  test('**손절보다 청산이 먼저 오면 그렇게 말한다**', () => {
    const r = tradeIdentity({
      marginUsd: 10, requestedLeverage: 100, actualLeverage: 100,
      quantity: 1000 / 60000, entryPrice: 60000,
      stopPrice: 59400, side: 'LONG', roundTripFeePct: 0.1,
    });
    assert(r.notes.some(n => /청산이 먼저/.test(n)), JSON.stringify(r.notes));
  });

  test('손절이 방향과 안 맞으면 잡는다 — 진입 즉시 맞거나 영원히 안 맞는다', () => {
    const r = tradeIdentity({
      marginUsd: 10, actualLeverage: 100, quantity: 1000 / 60000, entryPrice: 60000,
      stopPrice: 61000, side: 'LONG',
    });
    eq(r.code, 'STOP_SIDE_WRONG');
  });

  console.log('[우위 — 가정을 측정처럼 말하지 않는다]');

  test('**입력한 우위는 언제나 가정이다**', () => {
    const c = edgeClaimOf({ edgePp: 10 });
    eq(c.proven, false);
    eq(c.source, 'ASSUMED');
    assert(/가정/.test(c.label), c.label);
    assert(/증거는 아직 없습니다/.test(c.reason), c.reason);
  });

  test('무우위 기준선은 가정이 아니라 보수적 기준이다', () => {
    const c = edgeClaimOf({ edgePp: 0 });
    eq(c.proven, true);
    assert(/보수적/.test(c.reason), c.reason);
  });

  test('백테스트·실거래에서 나온 값은 출처를 밝힌다', () => {
    eq(edgeClaimOf({ edgePp: 7, source: 'BACKTEST' }).proven, true);
    eq(edgeClaimOf({ edgePp: 7, source: 'REALIZED' }).source, 'REALIZED');
  });

  test('모르는 출처를 증명된 것으로 눕히지 않는다', () => {
    eq(edgeClaimOf({ edgePp: 10, source: 'GUESS' as any }).source, 'ASSUMED');
  });

  console.log('[우위 — 한 점에서만 좋은 것은 우위가 아니다]');

  test('**+10%p 한 점에서만 좋으면 위험 신호다**', () => {
    const v = edgeFragility([
      { edgePp: 8, tradable: false }, { edgePp: 9, tradable: false },
      { edgePp: 10, tradable: true },
      { edgePp: 11, tradable: false }, { edgePp: 12, tradable: false },
    ]);
    eq(v.code, 'SINGLE_POINT');
    eq(v.ok, false);
    assert(/난수나 임계값/.test(v.reason), v.reason);
  });

  test('**좋은 점이 흩어져 있으면 구간이 아니다**', () => {
    const v = edgeFragility([
      { edgePp: 0, tradable: true }, { edgePp: 1, tradable: false },
      { edgePp: 2, tradable: false }, { edgePp: 3, tradable: true },
      { edgePp: 4, tradable: false }, { edgePp: 5, tradable: true },
    ]);
    eq(v.code, 'SCATTERED');
    eq(v.ok, false);
  });

  test('이어지는 구간이 있으면 통과다 — 조금 달라져도 유지된다', () => {
    const v = edgeFragility([
      { edgePp: 8, tradable: false },
      { edgePp: 9, tradable: true }, { edgePp: 10, tradable: true }, { edgePp: 11, tradable: true },
    ]);
    eq(v.code, 'ROBUST_ZONE');
    eq(v.ok, true);
  });

  test('아무 데서도 안 좋으면 그렇게 말한다', () => {
    eq(edgeFragility([{ edgePp: 0, tradable: false }]).code, 'NONE');
    eq(edgeFragility([]).code, 'NONE');
  });

  test('ROBUST 등급도 좋은 지점으로 센다', () => {
    const v = edgeFragility([
      { edgePp: 5, grade: 'ROBUST' }, { edgePp: 6, grade: 'ROBUST' },
    ]);
    eq(v.code, 'ROBUST_ZONE');
  });
}
