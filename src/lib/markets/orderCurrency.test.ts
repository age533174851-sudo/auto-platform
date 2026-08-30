// src/lib/markets/orderCurrency.test.ts
//
// **환율이 실행에서 빠졌는가.**
//
// 예전 수식은 `qty = krwAmount / krwPx`였고 명시적 1375는 소거됐다.
// 그런데 `krwPx`가 `usdPx × 1375`라서 실효 수식은
// `qty = krwAmount / (usdPx × 1375)`였다 — 환율이 앞단에 숨어 처음부터
// 체결 크기를 정하고 있었다.
//
// 이 묶음이 지키는 것: **환율이 무엇이든 실행 수량은 같다.**

import { test, eq, assert } from '../../test/harness';
import {
  orderCurrencyOf, amountMustClear, planExchangeOrder, percentBaseFor,
  balanceStateOf, scopedValueFor,
} from './orderCurrency';

export function runOrderCurrencyTests() {
  console.log('[주문 통화 — 실행에서 환율을 없앤다]');

  test('거래소로 나가는 주문은 USDT, 연습은 원화', () => {
    eq(orderCurrencyOf('testnet'), 'USDT');
    eq(orderCurrencyOf('live'), 'USDT');
    eq(orderCurrencyOf('mock'), 'KRW');
  });

  // ── 환율이 무엇이든 수량은 같다 ──

  test('명목가 100 USDT · 가격 2500 · 10배 → 수량 0.04 · 증거금 10', () => {
    const p = planExchangeOrder({ amountUsdt: 100, nativePrice: 2500, leverage: 10 });
    eq(p.kind, 'READY');
    if (p.kind !== 'READY') return;
    eq(p.qty, 0.04);
    eq(p.notionalUsdt, 100);
    eq(p.marginUsdt, 10);
  });

  test('**환율 1200·1375·1600·없음 어디서도 수량이 같다**', () => {
    // 계획 함수는 환율을 입력으로 받지도 않는다. 그것이 이 시험의 요지다.
    const fxCases = [1200, 1375, 1600, null];
    for (const _fx of fxCases) {
      const p = planExchangeOrder({ amountUsdt: 100, nativePrice: 2500, leverage: 10 });
      assert(p.kind === 'READY', '환율과 무관하게 계획이 서야 한다');
      if (p.kind === 'READY') eq(p.qty, 0.04);
    }
  });

  test('배율이 바뀌어도 명목가와 수량은 그대로다', () => {
    for (const [lev, margin] of [[1, 100], [10, 10], [100, 1]] as Array<[number, number]>) {
      const p = planExchangeOrder({ amountUsdt: 100, nativePrice: 2500, leverage: lev });
      if (p.kind !== 'READY') { assert(false, '계획이 서지 않았습니다'); return; }
      eq(p.qty, 0.04);
      eq(p.notionalUsdt, 100);
      eq(p.marginUsdt, margin);
    }
  });

  // ── 모르는 것을 지어내지 않는다 ──

  test('거래소 가격을 못 읽으면 막는다 — 환율로 되돌려 만들지 않는다', () => {
    for (const px of [null, undefined, 0, -1, NaN]) {
      const p = planExchangeOrder({ amountUsdt: 100, nativePrice: px as any, leverage: 10 });
      eq(p.kind, 'BLOCKED');
      if (p.kind === 'BLOCKED') eq(p.code, 'NATIVE_PRICE_UNKNOWN');
    }
  });

  test('금액을 안 적었으면 기본값을 지어내지 않는다', () => {
    for (const a of [null, undefined, 0, '', NaN]) {
      const p = planExchangeOrder({ amountUsdt: a as any, nativePrice: 2500, leverage: 10 });
      eq(p.kind, 'BLOCKED');
      if (p.kind === 'BLOCKED') eq(p.code, 'NO_AMOUNT');
    }
  });

  test('최소 명목가 미만이면 막는다 — 뜻은 C4까지 그대로 보존', () => {
    const p = planExchangeOrder({ amountUsdt: 19, nativePrice: 2500, leverage: 10, minNotionalUsdt: 20 });
    eq(p.kind, 'BLOCKED');
    if (p.kind === 'BLOCKED') {
      eq(p.code, 'BELOW_MIN_NOTIONAL');
      assert(!/원/.test(p.reason), '원화 환산 문구를 넣지 않는다');
    }
  });

  test('최소값을 안 주면 그 검사는 하지 않는다', () => {
    eq(planExchangeOrder({ amountUsdt: 1, nativePrice: 2500, leverage: 10 }).kind, 'READY');
  });

  // ── 통화가 바뀌면 숫자의 뜻도 바뀐다 ──

  test('**모의 ↔ 거래소 전환에서는 금액을 비운다**', () => {
    eq(amountMustClear('mock', 'testnet'), true);
    eq(amountMustClear('mock', 'live'), true);
    eq(amountMustClear('testnet', 'mock'), true);
    eq(amountMustClear('live', 'mock'), true);
  });

  test('같은 통화끼리는 비우지 않는다', () => {
    eq(amountMustClear('testnet', 'live'), false);
    eq(amountMustClear('mock', 'mock'), false);
  });

  test('100000이 그대로 넘어가면 백 배가 넘는 주문이 된다', () => {
    // ₩100,000 ≈ 73 USDT인데, 그대로 두면 100,000 USDT 주문이다.
    assert(amountMustClear('mock', 'live'), '통화가 바뀌는데 비우지 않으면 사고다');
  });

  // ── 비율 버튼의 잔고 출처 ──

  test('연습 잔고가 거래소 비율의 근거가 되지 않는다', () => {
    const r = percentBaseFor({
      mode: 'testnet', practiceKrw: 10_000_000, balance: { kind: 'KNOWN', usdt: 250 },
    });
    eq(r.currency, 'USDT');
    eq(r.base, 250);                      // 원화 천만이 아니라 가용 USDT
    eq(r.state, 'READY');
  });

  test('모의는 연습 원화 잔고를 쓴다', () => {
    const r = percentBaseFor({ mode: 'mock', practiceKrw: 10_000_000, balance: { kind: 'KNOWN', usdt: 250 } });
    eq(r.currency, 'KRW');
    eq(r.base, 10_000_000);
  });

  test('가용 USDT를 못 읽으면 연습 잔고로 대신하지 않는다', () => {
    const r = percentBaseFor({ mode: 'live', practiceKrw: 10_000_000, balance: { kind: 'UNKNOWN' } });
    eq(r.base, null);
    eq(r.state, 'UNKNOWN');
  });

  // ── 0과 '못 읽음'은 다르다 ──
  //
  // 예전에는 `availableBalance === 0`을 null로 접었다. 그러면 "잔고가
  // 없다"와 "확인하지 못했다"가 같은 화면이 되는데, 앞은 입금하면 되고
  // 뒤는 무엇이 잘못됐는지 알아야 한다.

  test('잔고 0은 읽은 것이다 — 모름이 아니다', () => {
    eq(balanceStateOf(0).kind, 'KNOWN');
    const r = percentBaseFor({ mode: 'live', practiceKrw: null, balance: balanceStateOf(0) });
    eq(r.state, 'ZERO');
    eq(r.base, null);                     // 비율은 못 내지만 이유가 다르다
  });

  test('못 읽은 값은 UNKNOWN이다', () => {
    for (const bad of [null, undefined, NaN, -5, 'x']) {
      eq(balanceStateOf(bad).kind, 'UNKNOWN');
    }
  });

  test('500 USDT의 50%는 250이다', () => {
    const r = percentBaseFor({ mode: 'live', practiceKrw: null, balance: balanceStateOf(500) });
    eq(r.state, 'READY');
    eq((r.base as number) * 50 / 100, 250);
  });

  // ── 잔고·가격은 어느 연결에서 읽은 것인가 ──
  //
  // A 계정 잔고 1,000을 읽은 뒤 B로 바꾸고 B 조회가 실패하면, 비율
  // 버튼이 **다른 계정의 잔고**로 B 주문 크기를 정할 수 있었다.

  test('**연결을 바꾸면 이전 계정의 값을 쓰지 않는다**', () => {
    const held = { connectionId: 'A', value: balanceStateOf(1000) };
    eq(scopedValueFor(held, 'A')?.kind, 'KNOWN');
    eq(scopedValueFor(held, 'B'), null);        // B 응답 전에는 모른다
    eq(scopedValueFor(held, null), null);
    eq(scopedValueFor(null, 'A'), null);
  });

  test('B 조회 실패는 A의 값을 되살리지 않는다', () => {
    // 실패했을 때 B 귀속 UNKNOWN을 적어 두므로, A 값은 다시 보이지 않는다.
    const afterFail = { connectionId: 'B', value: balanceStateOf(null) };
    eq(scopedValueFor(afterFail, 'B')?.kind, 'UNKNOWN');
    const r = percentBaseFor({ mode: 'live', practiceKrw: null, balance: scopedValueFor(afterFail, 'B') });
    eq(r.state, 'UNKNOWN');
    eq(r.base, null);
  });
}
