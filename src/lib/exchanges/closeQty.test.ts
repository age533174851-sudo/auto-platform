// src/lib/exchanges/closeQty.test.ts
//
// 부분 청산 수량 계산.
//
// 여기서 틀리면 조용하다. 조금 더 닫히거나 덜 닫히는 것은 화면에서 알 수 없고,
// 그 차이가 남은 포지션의 청산가를 바꾼다. 그리고 수량을 **올려서** 계산하면
// 보유량을 넘겨 거래소가 거부하거나 반대 포지션이 열린다.

import { test, eq, assert } from '../../test/harness';
import { closeQuantityFor } from './binanceFutures';

export function runCloseQtyTests() {
  console.log('[부분 청산 수량]');

  test('50%는 절반이다', () => {
    const r = closeQuantityFor(1.0, 50, 0.001, 0.001);
    eq(r.qty, 0.5);
    eq(r.fullClose, false);
  });

  test('100%는 전량이고 fullClose다', () => {
    const r = closeQuantityFor(0.437, 100, 0.001, 0.001);
    eq(r.qty, 0.437);
    eq(r.fullClose, true);
  });

  test('내림한다 — 올리면 보유량을 넘긴다', () => {
    // 0.333 × 30% = 0.0999 → step 0.001로 내림하면 0.099
    const r = closeQuantityFor(0.333, 30, 0.001, 0.001);
    eq(r.qty, 0.099);
    assert(r.qty <= 0.333 * 0.3, '올림이 일어났다');
  });

  test('음수 수량도 절댓값으로 본다 — 숏 포지션은 음수로 온다', () => {
    eq(closeQuantityFor(-2.0, 50, 0.001, 0.001).qty, 1.0);
  });

  test('포지션이 없으면 0이고 이유를 적는다', () => {
    const r = closeQuantityFor(0, 50, 0.001, 0.001);
    eq(r.qty, 0);
    eq(r.fullClose, false);
    assert(r.reason.includes('포지션'), r.reason);
  });

  console.log('[부분 청산 — 최소 단위]');

  test('계산값이 최소 단위 미만이면 전량으로 올린다', () => {
    // 0.002의 10% = 0.0002 → minQty 0.001 미만 → 전량
    const r = closeQuantityFor(0.002, 10, 0.001, 0.001);
    eq(r.qty, 0.002);
    eq(r.fullClose, true, '전량 종료임을 알려야 한다');
  });

  test('전량으로 올렸다는 사실을 숨기지 않는다', () => {
    const r = closeQuantityFor(0.002, 10, 0.001, 0.001);
    assert(r.reason.includes('전량'), `이유에 적어야 한다: ${r.reason}`);
    assert(r.reason.includes('10%'), `요청 비율도 적어야 한다: ${r.reason}`);
  });

  test('전량조차 최소 단위 미만이면 0이다 — 닫을 수 없다', () => {
    const r = closeQuantityFor(0.0005, 100, 0.001, 0.001);
    eq(r.qty, 0);
    eq(r.fullClose, false);
    assert(r.reason.includes('최소 단위'), r.reason);
  });

  console.log('[부분 청산 — 비율 조이기]');

  test('0%·음수·NaN은 거래하지 않는다 — 추측해서 청산하지 않는다', () => {
    // 처음에는 `Number(percent) || 100`으로 두고 "0이나 음수는 전량"이라고
    // 적었는데, 실제 동작은 음수를 1%로 조이고 있었다(주석과 코드가 달랐다).
    // 어느 쪽이든 잘못된 입력으로 실제 주문을 낸다. 100%면 전량이 날아가고
    // 1%면 요청하지 않은 거래가 나간다. 그래서 둘 다 하지 않는다.
    for (const bad of [0, -50, NaN, Infinity, -Infinity]) {
      const r = closeQuantityFor(1.0, bad as number, 0.001, 0.001);
      eq(r.qty, 0, `비율 ${String(bad)}로 주문이 나갔다`);
      assert(r.reason.includes('유효하지'), `이유를 적어야 한다: ${r.reason}`);
    }
  });

  test('100% 초과는 전량으로 조인다 — 보유량보다 많이 닫을 수 없다', () => {
    const r = closeQuantityFor(1.0, 150, 0.001, 0.001);
    eq(r.qty, 1.0);
    eq(r.fullClose, true);
  });

  test('1% 미만은 1%로 올린다', () => {
    // 0.5%는 1%로 조여진다 → 100 × 1% = 1
    eq(closeQuantityFor(100, 0.5, 0.001, 0.001).qty, 1);
  });

  console.log('[부분 청산 — step이 없을 때]');

  test('stepSize가 0이면 반올림하지 않는다 — 필터를 못 읽은 경우다', () => {
    const r = closeQuantityFor(1.0, 33, 0, 0);
    eq(Math.abs(r.qty - 0.33) < 1e-9, true, `기대 0.33, 실제 ${r.qty}`);
  });

  test('큰 step도 처리한다 — 정수 단위 심볼', () => {
    // step 1, 총 7개의 50% = 3.5 → 내림 3
    const r = closeQuantityFor(7, 50, 1, 1);
    eq(r.qty, 3);
    eq(r.fullClose, false);
  });

  test('step 1에서 1개 포지션의 50%는 전량이 된다', () => {
    // 1 × 50% = 0.5 → 내림 0 → minQty 1 미만 → 전량 1
    const r = closeQuantityFor(1, 50, 1, 1);
    eq(r.qty, 1);
    eq(r.fullClose, true);
  });
}
