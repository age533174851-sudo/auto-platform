// src/lib/markets/orderPreview.test.ts
//
// **주문 전에 본 숫자와 실제로 나가는 주문이 같은 뜻인가.**
//
// 회귀 대상: 실행에서 환율을 없앤 뒤에도 확인창이 옛 원화 계산을 그대로
// 쓰고 있었다. 100 USDT·2,500 USDT짜리 종목에서 화면은 `0.000029 ETH`,
// 실제 주문은 `0.04 ETH` — 약 1,375배 다른 숫자를 보고 승인했다.

import { test, eq, assert, close } from '../../test/harness';
import { orderPreviewOf, exchangePreviewOf, practicePreviewOf } from './orderPreview';

export function runOrderPreviewTests() {
  console.log('[주문 미리보기 — 승인 화면이 실행과 같은 뜻인가]');

  test('테스트넷 100 USDT · 선물가 2500 · 10배 → 0.04 · 명목 100 · 증거금 10', () => {
    const p = orderPreviewOf({
      mode: 'testnet', amount: '100', venuePrice: 2500, krwPrice: 3_437_500, leverage: 10,
    });
    eq(p.state, 'READY');
    eq(p.currency, 'USDT');
    eq(p.qty, 0.04);
    eq(p.notional, 100);
    eq(p.margin, 10);
    eq(p.price, 2500);
  });

  test('실전도 같은 계산이다', () => {
    const p = orderPreviewOf({
      mode: 'live', amount: 100, venuePrice: 2500, krwPrice: 3_437_500, leverage: 10 });
    eq(p.qty, 0.04);
    eq(p.notional, 100);
  });

  // ── 옛 고장의 정확한 반례 ──

  test('**원화 표시가가 있어도 미리보기가 그 값으로 수량을 만들지 않는다**', () => {
    // 옛 계산: qty = 100 / 3,437,500 ≈ 0.0000291 — 실제의 1/1375이다.
    const wrong = 100 / 3_437_500;
    const p = orderPreviewOf({
      mode: 'testnet', amount: 100, venuePrice: 2500, krwPrice: 3_437_500, leverage: 10 });
    assert(p.qty != null && Math.abs(p.qty - wrong) > 0.03,
      `옛 원화 계산이 남아 있습니다: ${p.qty}`);
    eq(p.qty, 0.04);
  });

  test('원화 표시가가 무엇이든 거래소 미리보기는 같다', () => {
    const seen = new Set<number>();
    for (const krw of [3_000_000, 3_437_500, 4_000_000, null]) {
      const p = exchangePreviewOf({ amountUsdt: 100, venuePrice: 2500, leverage: 10 });
      // krwPrice는 거래소 경로의 입력이 아니다 — 넣을 자리가 없다.
      void krw;
      seen.add(p.qty as number);
    }
    eq(seen.size, 1);
  });

  // ── 못 읽은 것을 만들어 채우지 않는다 ──

  test('거래소 가격을 못 읽으면 수량을 만들지 않는다', () => {
    for (const px of [null, undefined, 0, -1, NaN]) {
      const p = orderPreviewOf({
        mode: 'testnet', amount: 100, venuePrice: px as any, krwPrice: 3_437_500, leverage: 10 });
      eq(p.state, 'PRICE_UNKNOWN');
      eq(p.qty, null);
      eq(p.notional, null);
      eq(p.margin, null);
      assert(!!p.reason, '이유가 없습니다');
    }
  });

  test('가격을 못 읽었을 때 원화 표시가로 대신 채우지 않는다', () => {
    const p = orderPreviewOf({
      mode: 'live', amount: 100, venuePrice: null, krwPrice: 3_437_500, leverage: 10 });
    eq(p.qty, null);
    eq(p.price, null);
  });

  test('금액이 없으면 NO_AMOUNT다 — 0으로 적지 않는다', () => {
    const p = orderPreviewOf({
      mode: 'testnet', amount: '', venuePrice: 2500, krwPrice: null, leverage: 10 });
    eq(p.state, 'NO_AMOUNT');
    eq(p.qty, null);
  });

  test('작은 금액도 미리보기는 계산한다 — 최소 금액 판정은 서버 몫이다', () => {
    const p = orderPreviewOf({
      mode: 'testnet', amount: 5, venuePrice: 2500, krwPrice: null, leverage: 10 });
    eq(p.state, 'READY');
    eq(p.qty, 0.002);
    eq(p.notional, 5);
  });

  test('배율을 모르면 증거금은 null이다 — 0이 아니다', () => {
    const p = exchangePreviewOf({ amountUsdt: 100, venuePrice: 2500, leverage: null });
    eq(p.state, 'READY');
    eq(p.notional, 100);
    eq(p.margin, null);
  });

  test('배율이 바뀌어도 명목가와 수량은 그대로다', () => {
    const a = exchangePreviewOf({ amountUsdt: 100, venuePrice: 2500, leverage: 1 });
    const b = exchangePreviewOf({ amountUsdt: 100, venuePrice: 2500, leverage: 20 });
    eq(a.qty, b.qty);
    eq(a.notional, b.notional);
    eq(a.margin, 100);
    eq(b.margin, 5);
  });

  // ── 연습 장부는 원화 표시를 유지한다 ──

  test('모의는 원화 명목가·원화 증거금을 그대로 쓴다', () => {
    const p = orderPreviewOf({
      mode: 'mock', amount: 100_000, venuePrice: null, krwPrice: 3_437_500, leverage: 10 });
    eq(p.state, 'READY');
    eq(p.currency, 'KRW');
    eq(p.notional, 100_000);
    eq(p.margin, 10_000);
    assert(p.qty != null && Math.abs(p.qty - 100_000 / 3_437_500) < 1e-12, `수량: ${p.qty}`);
    assert(p.refUsdt != null, '연습 표시의 참고 환산이 없습니다');
  });

  test('모의도 가격을 못 읽으면 수량을 지어내지 않는다', () => {
    const p = practicePreviewOf({ amountKrw: 100_000, krwPrice: 0, leverage: 10 });
    eq(p.state, 'PRICE_UNKNOWN');
    eq(p.qty, null);
  });

  test('거래소 미리보기에는 참고 환산이 없다 — 두 통화를 섞지 않는다', () => {
    const p = exchangePreviewOf({ amountUsdt: 100, venuePrice: 2500, leverage: 10 });
    eq(p.refUsdt, null);
  });

  // ── 주문유형이 수량 기준가를 정한다 (C3.5) ──

  test('시장가는 거래소 선물가로 나눈다', () => {
    const p = orderPreviewOf({
      mode: 'testnet', amount: 100, venuePrice: 2500, krwPrice: null, leverage: 10,
      orderType: 'MARKET', limitPrice: 2000 });
    eq(p.state, 'READY');
    eq(p.price, 2500);
    eq(p.basis, 'VENUE_MARK');
    eq(p.qty, 0.04);
    eq(p.notional, 100);
    eq(p.margin, 10);
  });

  test('**지정가는 지정가로 나눈다 — 마크가로 나누면 명목가가 어긋난다**', () => {
    const p = orderPreviewOf({
      mode: 'testnet', amount: 100, venuePrice: 2500, krwPrice: null, leverage: 10,
      orderType: 'LIMIT', limitPrice: 2000 });
    eq(p.state, 'READY');
    eq(p.price, 2000);
    eq(p.basis, 'LIMIT_PRICE');
    eq(p.qty, 0.05);
    eq(p.notional, 100);
    eq(p.margin, 10);
    // 마크가로 나눴다면 0.04가 나오고, 실제 체결 명목은 0.04 × 2000 = 80이다.
    close(p.qty! * 2000, 100, 1e-9);
    assert(p.qty !== 0.04, '마크가 기준 수량이 나왔습니다');
  });

  test('지정가는 거래소 시세를 못 읽어도 계산된다', () => {
    const p = orderPreviewOf({
      mode: 'live', amount: 100, venuePrice: null, krwPrice: null, leverage: 10,
      orderType: 'LIMIT', limitPrice: 2000 });
    eq(p.state, 'READY');
    eq(p.qty, 0.05);
    eq(p.basis, 'LIMIT_PRICE');
  });

  test('지정가에 가격이 없으면 시장가로 되돌리지 않는다', () => {
    for (const lp of [null, undefined, 0, -1, '', 'abc']) {
      const p = orderPreviewOf({
        mode: 'testnet', amount: 100, venuePrice: 2500, krwPrice: null, leverage: 10,
        orderType: 'LIMIT', limitPrice: lp as any });
      eq(p.state, 'PRICE_UNKNOWN');
      eq(p.qty, null);
      // 마크가로 계산된 0.04가 새어 나오면 안 된다.
      eq(p.price, null);
    }
  });

  test('지원하지 않는 유형은 막는다 — 조용히 시장가가 되지 않는다', () => {
    for (const t of ['CONDITIONAL', 'STOP', 'trigger', '']) {
      const p = orderPreviewOf({
        mode: 'testnet', amount: 100, venuePrice: 2500, krwPrice: null, leverage: 10,
        orderType: t, limitPrice: 2000 });
      assert(p.state !== 'READY', `${t}가 통과했습니다`);
      eq(p.qty, null);
    }
  });

  test('유형을 안 주면 시장가다 — 기존 호출부가 그대로 동작한다', () => {
    const p = orderPreviewOf({
      mode: 'testnet', amount: 100, venuePrice: 2500, krwPrice: null, leverage: 10 });
    eq(p.qty, 0.04);
    eq(p.basis, 'VENUE_MARK');
  });
}
