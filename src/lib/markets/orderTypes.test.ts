// src/lib/markets/orderTypes.test.ts
//
// **화면이 고른 주문유형이 그대로 나가는가. 그리고 수량 기준가가 맞는가.**
//
// 회귀 대상: 화면은 시장가·지정가·조건부를 고르게 했는데 요청 본문은
// `type: 'MARKET'`으로 박혀 있었고 지정가는 한 번도 읽히지 않았다.

import { test, eq, assert, close } from '../../test/harness';
import {
  SERVER_ORDER_TYPES, isServerOrderType, sizingPriceOf,
} from './orderTypes';
import { supportedOrderTypes, orderTypeAllowed, planExchangeOrder } from './orderCurrency';
import { validateOrder } from '../engine/orderValidation';

export function runOrderTypesTests() {
  console.log('[주문유형 — 고른 것이 그대로 나간다]');

  test('서버가 받는 목록은 MARKET·LIMIT뿐이다', () => {
    eq(SERVER_ORDER_TYPES.length, 2);
    assert(SERVER_ORDER_TYPES.includes('MARKET'), 'MARKET 없음');
    assert(SERVER_ORDER_TYPES.includes('LIMIT'), 'LIMIT 없음');
    eq(isServerOrderType('CONDITIONAL'), false);
    eq(isServerOrderType('market'), false);   // 대문자 정본
  });

  test('**화면 선택지는 서버 목록의 부분집합이다**', () => {
    for (const mode of ['mock', 'testnet', 'live']) {
      for (const t of supportedOrderTypes(mode)) {
        assert(isServerOrderType(t), `${mode}가 서버가 안 받는 ${t}를 고르게 합니다`);
        // 서버 검증기도 같은 답을 내야 한다 — 목록이 두 벌이면 갈린다.
        const v = validateOrder({
          symbol: 'BTCUSDT', side: 'BUY', type: t, quantity: 1,
          price: t === 'LIMIT' ? 100 : undefined,
        });
        assert(v.ok, `서버가 ${t}를 거절합니다: ${v.error}`);
      }
    }
  });

  test('모의는 시장가만 낼 수 있다 — 미체결 주문을 들고 있을 장부가 없다', () => {
    eq(supportedOrderTypes('mock').join(','), 'MARKET');
    eq(orderTypeAllowed('mock', 'LIMIT'), false);
    eq(orderTypeAllowed('testnet', 'LIMIT'), true);
    eq(orderTypeAllowed('live', 'LIMIT'), true);
  });

  test('조건부는 어느 모드에서도 낼 수 없다', () => {
    for (const mode of ['mock', 'testnet', 'live']) {
      eq(orderTypeAllowed(mode, 'CONDITIONAL'), false);
    }
    const v = validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'CONDITIONAL', quantity: 1 });
    eq(v.ok, false);
    eq(v.code, 'invalid_type');
  });

  // ── 기준가 ──

  test('시장가는 거래소 선물가, 지정가는 지정가', () => {
    const m = sizingPriceOf({ orderType: 'MARKET', venuePrice: 2500, limitPrice: 2000 });
    eq(m.kind, 'READY');
    if (m.kind === 'READY') { eq(m.price, 2500); eq(m.basis, 'VENUE_MARK'); }
    const l = sizingPriceOf({ orderType: 'LIMIT', venuePrice: 2500, limitPrice: 2000 });
    eq(l.kind, 'READY');
    if (l.kind === 'READY') { eq(l.price, 2000); eq(l.basis, 'LIMIT_PRICE'); }
  });

  test('지정가는 거래소 시세가 없어도 정해진다', () => {
    const l = sizingPriceOf({ orderType: 'LIMIT', venuePrice: null, limitPrice: 2000 });
    eq(l.kind, 'READY');
    if (l.kind === 'READY') eq(l.price, 2000);
  });

  test('**못 정하면 시장가로 되돌리지 않는다**', () => {
    const noVenue = sizingPriceOf({ orderType: 'MARKET', venuePrice: null, limitPrice: 2000 });
    eq(noVenue.kind, 'BLOCKED');
    if (noVenue.kind === 'BLOCKED') eq(noVenue.code, 'NATIVE_PRICE_UNKNOWN');

    const noLimit = sizingPriceOf({ orderType: 'LIMIT', venuePrice: 2500, limitPrice: null });
    eq(noLimit.kind, 'BLOCKED');
    if (noLimit.kind === 'BLOCKED') eq(noLimit.code, 'LIMIT_PRICE_REQUIRED');

    const bad = sizingPriceOf({ orderType: 'CONDITIONAL', venuePrice: 2500, limitPrice: 2000 });
    eq(bad.kind, 'BLOCKED');
    if (bad.kind === 'BLOCKED') eq(bad.code, 'UNSUPPORTED_ORDER_TYPE');
  });

  // ── 핵심 fixture: 100 USDT · 10x · 마크가 2,500 · 지정가 2,000 ──

  test('시장가 fixture — 0.04 · 명목 100 · 증거금 10', () => {
    const p = planExchangeOrder({
      amountUsdt: 100, nativePrice: 2500, leverage: 10, orderType: 'MARKET', limitPrice: 2000 });
    eq(p.kind, 'READY');
    if (p.kind !== 'READY') return;
    eq(p.qty, 0.04);
    eq(p.notionalUsdt, 100);
    eq(p.marginUsdt, 10);
    eq(p.sizingPrice, 2500);
    eq(p.basis, 'VENUE_MARK');
  });

  test('지정가 fixture — 0.05 · 명목 100 · 증거금 10 · qty × 지정가 = 100', () => {
    const p = planExchangeOrder({
      amountUsdt: 100, nativePrice: 2500, leverage: 10, orderType: 'LIMIT', limitPrice: 2000 });
    eq(p.kind, 'READY');
    if (p.kind !== 'READY') return;
    eq(p.qty, 0.05);
    eq(p.notionalUsdt, 100);
    eq(p.marginUsdt, 10);
    eq(p.sizingPrice, 2000);
    eq(p.basis, 'LIMIT_PRICE');
    // **이게 이 작업의 요지다.** 마크가로 나눴다면 0.04 × 2000 = 80이 된다.
    close(p.qty * 2000, 100, 1e-9);
  });

  test('마크가가 어디로 움직여도 지정가 수량은 그대로다', () => {
    const seen = new Set<number>();
    for (const mark of [1000, 2500, 9999, null]) {
      const p = planExchangeOrder({
        amountUsdt: 100, nativePrice: mark, leverage: 10, orderType: 'LIMIT', limitPrice: 2000 });
      if (p.kind === 'READY') seen.add(p.qty);
    }
    eq(seen.size, 1);
    eq([...seen][0], 0.05);
  });

  // ── 서버 계약 ──

  test('서버는 지정가에 0보다 큰 가격을 요구한다', () => {
    const noPrice = validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1 });
    eq(noPrice.ok, false);
    eq(noPrice.code, 'price_required');
    const ok = validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: 2000 });
    eq(ok.ok, true);
    eq(ok.value?.type, 'LIMIT');
    eq(ok.value?.price, 2000);
  });

  // ── reduceOnly는 진입/청산을 가르는 칸이다 ──
  //
  // 라우트는 `isExit = !!reduceOnly`로 진입 점검(손절·증거금·미확정 주문)을
  // 건너뛸지 정한다. 검증기가 `!!input.reduceOnly`로 읽으면 문자열
  // `"false"`·`"0"`이 **true**가 되어, 신규 진입 요청이 청산으로 분류되고
  // 진입 점검을 통과하지 않은 채 reduceOnly 주문으로 큐에 들어간다
  // (포지션이 없으면 거래소가 -2022로 거절한다).
  test('reduceOnly: 불리언 true/false와 생략만 받는다', () => {
    const base = { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 };
    eq(validateOrder({ ...base }).value?.reduceOnly, false);
    eq(validateOrder({ ...base, reduceOnly: null }).value?.reduceOnly, false);
    eq(validateOrder({ ...base, reduceOnly: false }).value?.reduceOnly, false);
    eq(validateOrder({ ...base, reduceOnly: true }).value?.reduceOnly, true);
  });

  test('**reduceOnly "false"·"0"·1을 청산으로 바꾸지 않는다** — 막는다', () => {
    const base = { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 };
    for (const bad of ['false', '0', 'true', '', 1, 0, {}, []] as unknown[]) {
      const v = validateOrder({ ...base, reduceOnly: bad });
      eq(v.ok, false, `reduceOnly=${JSON.stringify(bad)}가 통과했습니다 (reduceOnly=${v.value?.reduceOnly})`);
      eq(v.code, 'invalid_reduce_only');
    }
  });

  test('시장가는 가격이 없어도 통과한다', () => {
    const v = validateOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 });
    eq(v.ok, true);
    eq(v.value?.type, 'MARKET');
    eq(v.value?.price, undefined);
  });
}
