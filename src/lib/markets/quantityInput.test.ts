// src/lib/markets/quantityInput.test.ts
//
// 막으려는 것:
//  1. **USDT의 뜻이 둘인데 토글 하나로 두는 것.** 주문 총액 10,000과
//     초기 증거금 10,000은 5배 계좌에서 다섯 배 차이다 — 틀린 쪽이
//     다섯 배 큰 주문이다
//  2. 못 구한 수량을 0으로 돌려주는 것. 화면에 '수량 0'이 뜨면
//     사용자는 자기가 잘못 적었다고 읽는데, 실제로는 가격을 못 읽은 것이다
//  3. 배율을 1로 가정하는 것 — 5배 계좌에서 포지션이 다섯 배가 된다
//  4. **포지션을 들고 있는데 "수량이 없어 손실을 계산하지 못했습니다"**
//     라고 적는 것. 실제로 화면에 뜬 문구다
import { test, assert, eq, close } from '../../test/harness';
import {
  convertQuantity, effectiveQtyFor, percentLabel, needsEquity, needsStop,
} from './quantityInput';

export function runQuantityInputTests() {
  console.log('[수량 단위 — USDT의 뜻이 둘이다]');

  test('주문 총액은 배율과 무관하다', () => {
    const r = convertQuantity({
      mode: 'QUOTE_NOTIONAL', value: 10000, price: 65000, leverage: 5,
    });
    eq(r.ok, true, r.reason);
    eq(r.notionalUsd, 10000);
    close(r.baseQty!, 10000 / 65000, 1e-12);
    close(r.marginUsd!, 2000, 1e-9, '10,000 명목가를 5배로 열면 증거금 2,000');
  });

  test('초기 증거금은 배율을 곱한다 — 같은 숫자가 다섯 배 주문이 된다', () => {
    const r = convertQuantity({
      mode: 'INITIAL_MARGIN', value: 10000, price: 65000, leverage: 5,
    });
    eq(r.notionalUsd, 50000, '이게 토글 하나로 뭉쳐 있던 5배 차이다');
    close(r.marginUsd!, 10000, 1e-9);
  });

  test('배율을 모르면 증거금을 포지션으로 못 바꾼다', () => {
    // 1로 가정하면 5배 계좌에서 실제 포지션이 다섯 배가 된다.
    const r = convertQuantity({ mode: 'INITIAL_MARGIN', value: 1000, price: 65000 });
    eq(r.status, 'LEVERAGE_UNKNOWN');
    eq(r.baseQty, null);
  });

  console.log('[수량 단위 — 코인 수량]');

  test('코인 수량은 가격 없이도 확정이다', () => {
    const r = convertQuantity({ mode: 'BASE_ASSET', value: 0.2079 });
    eq(r.ok, true);
    eq(r.baseQty, 0.2079);
    eq(r.notionalUsd, null, '명목가는 가격을 알아야 나온다 — 0이 아니다');
  });

  test('가격이 있으면 명목가와 증거금도 같이 준다', () => {
    const r = convertQuantity({ mode: 'BASE_ASSET', value: 1, price: 65000, leverage: 5 });
    eq(r.notionalUsd, 65000);
    eq(r.marginUsd, 13000);
  });

  console.log('[수량 단위 — 못 구한 것은 0이 아니다]');

  test('가격을 모르면 USDT를 수량으로 못 바꾼다', () => {
    const r = convertQuantity({ mode: 'QUOTE_NOTIONAL', value: 10000, price: null });
    eq(r.status, 'PRICE_UNKNOWN');
    eq(r.baseQty, null, '0으로 주면 사용자가 잘못 적었다고 읽는다');
    assert(r.reason.includes('지정가'), r.reason);
  });

  test('가용자산을 모르면 비율로 정할 수 없다', () => {
    // 0으로 치면 모든 수량이 0이 되고, 사용자는 잔고가 없다고 읽는다.
    const r = convertQuantity({
      mode: 'ACCOUNT_PERCENT', value: 25, price: 65000, leverage: 5, availableUsd: null,
    });
    eq(r.status, 'EQUITY_UNKNOWN');
    eq(r.baseQty, null);
  });

  test('안 적었으면 안 적었다고 한다', () => {
    eq(convertQuantity({ mode: 'BASE_ASSET', value: null }).status, 'NO_INPUT');
    eq(convertQuantity({ mode: 'BASE_ASSET', value: 0 }).status, 'NO_INPUT');
    eq(convertQuantity({ mode: 'BASE_ASSET', value: -1 }).status, 'NO_INPUT');
    eq(convertQuantity(null).status, 'NO_INPUT');
  });

  console.log('[수량 단위 — 계좌 비율]');

  test('가용자산 비율은 증거금 기준이다', () => {
    const r = convertQuantity({
      mode: 'ACCOUNT_PERCENT', value: 20, price: 65000, leverage: 5, availableUsd: 50000,
    });
    // 50,000의 20% = 10,000 증거금 → 5배 → 명목가 50,000
    close(r.marginUsd!, 10000, 1e-9);
    eq(r.notionalUsd, 50000);
  });

  test('100%를 넘겨 적어도 100%로 자른다', () => {
    // 넘겨 적으면 있는 돈보다 큰 증거금이 된다.
    const r = convertQuantity({
      mode: 'ACCOUNT_PERCENT', value: 500, price: 65000, leverage: 1, availableUsd: 1000,
    });
    close(r.marginUsd!, 1000, 1e-9);
  });

  console.log('[수량 단위 — 계좌 위험은 여기서 안 한다]');

  test('계좌 위험은 orderSizing에 넘긴다', () => {
    // 같은 산수를 두 벌로 만들지 않는다. 그쪽에는 최소수량·수량단위·
    // 증거금 초과 검사까지 들어 있다.
    const r = convertQuantity({ mode: 'ACCOUNT_RISK', value: 1, price: 65000 });
    eq(r.status, 'DELEGATED');
    eq(r.baseQty, null);
  });

  test('어느 모드가 무엇을 필요로 하는지 말한다', () => {
    eq(needsEquity('ACCOUNT_PERCENT'), true);
    eq(needsEquity('ACCOUNT_RISK'), true);
    eq(needsEquity('BASE_ASSET'), false);
    eq(needsStop('ACCOUNT_RISK'), true);
    eq(needsStop('ACCOUNT_PERCENT'), false);
  });

  console.log('[손실 계산 — 들고 있으면 계산할 수 있다]');

  test('포지션이 있으면 입력칸이 비어도 계산한다', () => {
    // 화면에 실제로 이렇게 떴다: 포지션 0.2079를 들고 있는데
    // "수량이 없어 손실을 계산하지 못했습니다".
    const e = effectiveQtyFor({ orderQty: null, positionQty: 0.2079 });
    eq(e.qty, 0.2079);
    eq(e.source, 'POSITION');
    assert(e.label.includes('보유'), e.label);
  });

  test('주문 수량을 적었으면 그것이 우선이다', () => {
    // 지금 적고 있는 주문의 손실을 보고 싶은 것이다.
    const e = effectiveQtyFor({ orderQty: 0.5, closeQty: 0.1, positionQty: 2 });
    eq(e.qty, 0.5);
    eq(e.source, 'ORDER_INPUT');
  });

  test('부분청산을 골랐으면 그 수량이다', () => {
    const e = effectiveQtyFor({ orderQty: null, closeQty: 0.1, positionQty: 2 });
    eq(e.qty, 0.1);
    eq(e.source, 'CLOSE_SELECTION');
  });

  test('숏 포지션도 절대값으로 본다', () => {
    eq(effectiveQtyFor({ positionQty: -2 }).qty, 2);
  });

  test('정말 아무것도 없으면 없다고 한다', () => {
    const e = effectiveQtyFor({});
    eq(e.qty, null);
    eq(e.source, 'NONE');
    eq(e.label, '');
  });

  console.log('[비율 버튼 — 무엇의 비율인가]');

  test('신규와 청산의 비율은 뜻이 다르다', () => {
    // 청산 탭에서 100%가 잔고의 100%였다면, 그건 전량청산이 아니라
    // 계좌를 통째로 건 신규 주문이다.
    eq(percentLabel('ENTRY'), '가용 증거금 비율');
    eq(percentLabel('EXIT'), '포지션 청산 비율');
  });
}
