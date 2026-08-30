// src/lib/markets/orderPreview.test.ts
//
// **주문 전에 본 숫자와 실제로 나가는 주문이 같은 뜻인가.**
//
// 회귀 대상: 실행에서 환율을 없앤 뒤에도 확인창이 옛 원화 계산을 그대로
// 쓰고 있었다. 100 USDT·2,500 USDT짜리 종목에서 화면은 `0.000029 ETH`,
// 실제 주문은 `0.04 ETH` — 약 1,375배 다른 숫자를 보고 승인했다.

import { test, eq, assert } from '../../test/harness';
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

  test('최소 명목가 미만은 BLOCKED이고 이유가 남는다', () => {
    const p = orderPreviewOf({
      mode: 'testnet', amount: 5, venuePrice: 2500, krwPrice: null, leverage: 10,
      minNotionalUsdt: 20 });
    eq(p.state, 'BLOCKED');
    eq(p.qty, null);
    assert(!!p.reason && p.reason.includes('20'), `이유에 기준이 없습니다: ${p.reason}`);
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
}
