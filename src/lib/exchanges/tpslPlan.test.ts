// src/lib/exchanges/tpslPlan.test.ts
//
// 이 테스트가 막는 것: **걸었는데 보호가 안 되는 상태.**
//
// 익절·손절은 방향이 틀려도 거래소가 받아 준다. 롱인데 손절을 현재가
// 위에 걸면 주문은 정상 접수되고 다음 틱에 발동한다. 화면에는 그때까지
// '설정됨'으로 떠 있다 — 사용자는 보호가 걸린 줄 안다.

import { test, eq, assert } from '../../test/harness';
import {
  checkTakeProfit, checkStopLoss, checkTrailing, portionQty, pnlAt,
  normalizeTrigger, CALLBACK_MIN, CALLBACK_MAX,
} from './tpslPlan';

export function runTpslPlanTests() {
  console.log('[TP/SL·트레일링 — 걸었는데 보호가 안 되는 상태를 막는다]');

  // ── 익절 ────────────────────────────────────────────────
  test('롱 익절은 기준가 위여야 한다', () => {
    eq(checkTakeProfit(110, 100, 'LONG').ok, true);
    eq(checkTakeProfit(90, 100, 'LONG').ok, false);
    eq(checkTakeProfit(100, 100, 'LONG').ok, false, '같은 값도 즉시 발동이다');
  });

  test('숏 익절은 기준가 아래여야 한다', () => {
    eq(checkTakeProfit(90, 100, 'SHORT').ok, true);
    eq(checkTakeProfit(110, 100, 'SHORT').ok, false);
  });

  // ── 손절 ────────────────────────────────────────────────
  test('롱 손절은 기준가 아래여야 한다', () => {
    eq(checkStopLoss(90, 100, 'LONG', null).ok, true);
    eq(checkStopLoss(110, 100, 'LONG', null).ok, false);
  });

  test('숏 손절은 기준가 위여야 한다', () => {
    eq(checkStopLoss(110, 100, 'SHORT', null).ok, true);
    eq(checkStopLoss(90, 100, 'SHORT', null).ok, false);
  });

  // **손절이 청산가 너머면 손절은 작동할 기회가 없다.**
  // 거래소도 경고만 하고 받아 준다 — 화면에는 둘 다 '설정됨'으로 보인다.
  test('손절이 청산가 너머면 막는다', () => {
    // 롱: 청산가 80. 손절을 79에 걸면 청산이 먼저 온다
    eq(checkStopLoss(79, 100, 'LONG', 80).ok, false);
    eq(checkStopLoss(85, 100, 'LONG', 80).ok, true);
    // 숏: 청산가 120. 손절 121은 청산 너머
    eq(checkStopLoss(121, 100, 'SHORT', 120).ok, false);
    eq(checkStopLoss(115, 100, 'SHORT', 120).ok, true);
  });

  test('청산가를 모르면 방향만 본다', () => {
    eq(checkStopLoss(90, 100, 'LONG', null).ok, true);
    eq(checkStopLoss(90, 100, 'LONG', NaN as any).ok, true);
  });

  // 기준가를 모르면 방향을 판단할 수 없다. 여기서 봐주면 조회가 실패한
  // 순간에만 위험한 값이 걸리는 길이 생긴다.
  test('기준가를 모르면 통과시키지 않는다', () => {
    eq(checkTakeProfit(110, null, 'LONG').ok, false);
    eq(checkStopLoss(90, null, 'LONG', null).ok, false);
    eq(checkStopLoss(90, 0, 'LONG', null).ok, false);
  });

  test('값이 이상하면 거부하고 이유를 적는다', () => {
    for (const v of [0, -1, NaN]) {
      const r = checkTakeProfit(v as number, 100, 'LONG');
      eq(r.ok, false, `익절 ${v}이 통과했다`);
      assert(r.reason.length > 0, '이유가 비어 있다');
    }
  });

  // ── 트레일링 ────────────────────────────────────────────
  test('콜백 비율은 거래소 허용 범위 안이어야 한다', () => {
    eq(checkTrailing(CALLBACK_MIN, null, 100, 'LONG').ok, true);
    eq(checkTrailing(CALLBACK_MAX, null, 100, 'LONG').ok, true);
    eq(checkTrailing(CALLBACK_MIN - 0.01, null, 100, 'LONG').ok, false);
    eq(checkTrailing(CALLBACK_MAX + 0.01, null, 100, 'LONG').ok, false);
    eq(checkTrailing(NaN, null, 100, 'LONG').ok, false);
  });

  test('발동가는 선택이다 — 없으면 통과', () => {
    eq(checkTrailing(1, null, 100, 'LONG').ok, true);
    eq(checkTrailing(1, null, null, 'LONG').ok, true, '발동가가 없으면 기준가도 필요 없다');
  });

  // 발동가 방향이 틀리면 추적이 영원히 시작되지 않거나 즉시 시작된다.
  // 앞은 '걸었는데 안 도는' 상태이고, 화면에서는 걸린 것처럼 보인다.
  test('롱 발동가는 기준가 위여야 한다', () => {
    eq(checkTrailing(1, 110, 100, 'LONG').ok, true);
    eq(checkTrailing(1, 90, 100, 'LONG').ok, false);
  });

  test('숏 발동가는 기준가 아래여야 한다', () => {
    eq(checkTrailing(1, 90, 100, 'SHORT').ok, true);
    eq(checkTrailing(1, 110, 100, 'SHORT').ok, false);
  });

  test('발동가를 줬는데 기준가를 모르면 거부한다', () => {
    eq(checkTrailing(1, 110, null, 'LONG').ok, false);
  });

  // ── 부분 수량 ───────────────────────────────────────────
  //
  // null(전량)과 0을 섞으면 안 된다. 거래소는 quantity가 없으면
  // closePosition=true(전량)로 걸고, 0을 보내면 거부한다.
  test('전량은 null이다 — 0이 아니다', () => {
    eq(portionQty(2, null).qty, null);
    eq(portionQty(2, 100).qty, null);
  });

  test('비율만큼 자른다', () => {
    eq(portionQty(2, 50).qty, 1);
    eq(portionQty(0.5, 25).qty, 0.125);
  });

  test('0%나 범위 밖은 거부하고 이유를 적는다', () => {
    for (const p of [0, -10, 101, NaN]) {
      const r = portionQty(2, p as number);
      eq(r.qty, null, `비율 ${p}`);
      assert(r.reason.length > 0, `비율 ${p}에 이유가 없다`);
    }
  });

  test('포지션 수량을 모르면 거부한다', () => {
    const r = portionQty(0, 50);
    eq(r.qty, null);
    assert(r.reason.length > 0, '이유가 비어 있다');
  });

  // ── 예상 손익 ───────────────────────────────────────────
  //
  // 모르면 null이다. 0으로 두면 '손익 없음'이 되는데, 손절을 걸면서
  // 얼마를 잃는지 0으로 보게 된다.
  test('손익을 계산한다', () => {
    eq(pnlAt(110, 100, 2, 'LONG'), 20);
    eq(pnlAt(90, 100, 2, 'LONG'), -20);
    eq(pnlAt(90, 100, 2, 'SHORT'), 20);
    eq(pnlAt(110, 100, 2, 'SHORT'), -20);
  });

  test('하나라도 모르면 null — 0으로 두지 않는다', () => {
    eq(pnlAt(110, null, 2, 'LONG'), null);
    eq(pnlAt(110, 100, null, 'LONG'), null);
    eq(pnlAt(0, 100, 2, 'LONG'), null);
  });

  // ── 트리거 기준 ─────────────────────────────────────────
  test('Last는 CONTRACT_PRICE로 보낸다', () => {
    eq(normalizeTrigger('LAST'), 'CONTRACT_PRICE');
    eq(normalizeTrigger('last_price'), 'CONTRACT_PRICE');
    eq(normalizeTrigger('CONTRACT_PRICE'), 'CONTRACT_PRICE');
  });

  // 모르는 값이 Last로 떨어지면, 얇은 호가의 한 틱 꼬리에 손절이 털린다.
  // 기본은 더 안전한 쪽(MARK)이어야 한다.
  test('모르는 값은 MARK로 떨어진다', () => {
    eq(normalizeTrigger(''), 'MARK_PRICE');
    eq(normalizeTrigger(null), 'MARK_PRICE');
    eq(normalizeTrigger('아무거나'), 'MARK_PRICE');
  });
}
