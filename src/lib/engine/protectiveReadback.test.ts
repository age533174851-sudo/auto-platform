// src/lib/engine/protectiveReadback.test.ts
//
// **판별할 수 없는 조건부 주문이 있을 때 "손절 없음"으로 적지 않는다.**
//
// `readbackProtective`는 종류·방향을 읽지 못한 줄(UNKNOWN)을 "무관한 주문"
// (otherCount)으로 세고, 그 결과 손절을 찾지 못하면 `readOk:true ·
// found:false` — **확인된 없음**을 돌려줬다. 그 줄이 바로 방금 건 손절일
// 수 있는데도 그렇다.
//
// 이 판정을 받는 쪽:
//   · Gate 진입(`orderExecutor`)은 `rb.readOk && !rb.stop.found`를 "손절이
//     확인된 없음"으로 보고 REQUIRED 정책에서 **진입을 되돌린다(포지션 청산).**
//   · 스모크(`startAttempt`)는 그것을 UNKNOWN이 아니라 FAIL로 적는다.
//
// 모르는 것은 모른다고 돌려준다 — 보호 확인(found)으로도, 없음으로도 적지 않는다.

import { test, eq, assert } from '../../test/harness';
import { readbackProtective } from './protectiveReadback';

/** Gate LONG 손절 모양. rule을 빼면 손절인지 익절인지 읽을 수 없다 */
const gateRow = (id: string, rule: 1 | 2 | undefined, price: string, autoSize = 'close_long') => ({
  id, order_type: autoSize === 'close_long' ? 'close-long-order' : 'close-short-order',
  initial: { auto_size: autoSize, reduce_only: true, size: 0 },
  trigger: rule == null ? { price } : { rule, price },
});

export function runProtectiveReadbackTests() {
  console.log('[보호주문 되읽기 — 판별 불가 줄을 "없음"으로 적지 않는다]');

  test('Gate: rule을 못 읽은 손절 후보만 있으면 손절은 확인 불가(readOk:false)다', () => {
    const r = readbackProtective({
      venue: 'gate', positionSide: 'LONG',
      orders: [gateRow('1', undefined, '2993.97')],
      expectedStop: 2993.97,
    });
    eq(r.stop.found, false);
    eq(r.stop.readOk, false);
    // 진입 경로가 보는 최상위 값도 '확인된 없음'이 아니어야 한다.
    eq(r.readOk, false);
    assert(/판별/.test(r.stop.reason), r.stop.reason);
    // Gate 진입 경로의 판정을 그대로 재현한다 — 되돌림 조건이 서면 안 된다.
    const stopConfirmedMissing = r.readOk && !r.stop.found;
    eq(stopConfirmedMissing, false);
  });

  test('Binance: 방향(side)을 못 읽은 STOP은 확인 불가다', () => {
    const r = readbackProtective({
      venue: 'binance', positionSide: 'LONG',
      orders: [{ orderId: 7, type: 'STOP_MARKET', closePosition: true, stopPrice: '2993.97' }],
      expectedStop: 2993.97,
    });
    eq(r.stop.found, false);
    eq(r.stop.readOk, false);
    eq(r.readOk, false);
  });

  test('익절 후보도 같다 — rule을 못 읽으면 익절도 확인 불가', () => {
    const r = readbackProtective({
      venue: 'gate', positionSide: 'LONG',
      orders: [gateRow('1', 2, '2993.97'), gateRow('2', undefined, '3030.05')],
      expectedStop: 2993.97, expectedTakeProfit: 3030.05,
    });
    eq(r.stop.found, true);
    eq(r.takeProfit.found, false);
    eq(r.takeProfit.readOk, false);
    eq(r.readOk, false);
  });

  // ── 바꾸지 않는 것 ──

  test('손절을 찾았으면 판별 불가 줄이 있어도 손절은 확인이다', () => {
    const r = readbackProtective({
      venue: 'gate', positionSide: 'LONG',
      orders: [gateRow('1', 2, '2993.97'), gateRow('9', undefined, '2993.97')],
      expectedStop: 2993.97,
    });
    eq(r.stop.found, true); eq(r.stop.readOk, true); eq(r.stop.orderId, '1');
  });

  test('판별 불가 줄의 트리거가 기대값과 다르면 내 손절 후보가 아니다 — 확인된 없음', () => {
    const r = readbackProtective({
      venue: 'gate', positionSide: 'LONG',
      orders: [gateRow('1', undefined, '2500')],
      expectedStop: 2993.97,
    });
    eq(r.stop.found, false); eq(r.stop.readOk, true); eq(r.readOk, true);
    // 익절일 수는 있으므로 익절 칸은 정직하게 '확인 불가'다. 다만 익절을
    // 묻지 않았으니 손절의 확인된 없음을 가리지 않는다.
    eq(r.takeProfit.readOk, false);
  });

  test('익절을 기대했는데 판별 불가 줄이 그 가격이면 최상위도 확인 불가다', () => {
    const r = readbackProtective({
      venue: 'gate', positionSide: 'LONG',
      orders: [gateRow('1', undefined, '2500')],
      expectedStop: 2993.97, expectedTakeProfit: 2500,
    });
    eq(r.stop.readOk, true); eq(r.takeProfit.readOk, false); eq(r.readOk, false);
  });

  test('반대 포지션을 닫는 판별 불가 줄은 이 포지션과 무관하다 — 확인된 없음', () => {
    const r = readbackProtective({
      venue: 'gate', positionSide: 'LONG',
      orders: [gateRow('1', undefined, '2993.97', 'close_short')],
      expectedStop: 2993.97,
    });
    eq(r.stop.found, false); eq(r.stop.readOk, true); eq(r.readOk, true);
  });

  test('빈 목록은 여전히 확인된 없음이다', () => {
    const r = readbackProtective({ venue: 'gate', positionSide: 'LONG', orders: [], expectedStop: 2993.97 });
    eq(r.readOk, true); eq(r.stop.readOk, true); eq(r.stop.found, false);
  });

  test('보호주문이 아닌 줄(진입 예약)은 손절 후보가 아니다 — 확인된 없음', () => {
    const r = readbackProtective({
      venue: 'binance', positionSide: 'LONG',
      orders: [{ orderId: 99, type: 'STOP_MARKET', side: 'BUY', stopPrice: '2993.97' }],
      expectedStop: 2993.97,
    });
    eq(r.readOk, true); eq(r.stop.readOk, true); eq(r.stop.found, false);
  });

  test('목록을 못 읽은 경우는 그대로 readOk:false다', () => {
    const r = readbackProtective({ orders: null, positionSide: 'LONG', error: 'timeout' });
    eq(r.readOk, false); eq(r.stop.readOk, false);
  });
}
