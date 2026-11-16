// src/lib/engine/protectionLedger.test.ts
//
// **2026-08-15 21:16:16에 Gate에 남은 조건부 주문 2건이 이 파일의 이유다.**
//
// 포지션은 0인데 ETHUSDT 조건부 주문 2건(트리거 1870.50 · 1893.10)이
// 그대로 남았다. 남는 길이 둘이었고, 여기서 둘 다 막는다:
//   1. 되돌리기가 방금 건 SL/TP를 안 지운다
//   2. 취소를 HTTP 200만 보고 완료로 적는다

import { test, eq, assert } from '../../test/harness';
import {
  ownedOrderIds, cancelLedger, rollbackTargets, rollbackNote, orderIdOf, orphanCancelGate,
  type CancelAttempt,
} from './protectionLedger';

const A = (id: string, over: Partial<CancelAttempt> = {}): CancelAttempt =>
  ({ id, requested: true, httpOk: true, ...over });
const O = (id: string) => ({ id, initial: { contract: 'ETH_USDT' } });

export function runProtectionLedgerTests() {
  console.log('[보호주문 장부 — 소유 증거는 주문 번호가 먼저다]');

  test('등록 응답과 되읽기 번호를 둘 다 모은다', () => {
    // 하나라도 놓치면 그 주문이 거래소에 남는다.
    eq(ownedOrderIds({ placed: ['1', '2'], readback: ['2', '3'] }).join(','), '1,2,3');
  });

  test('빈 값과 문자열 null을 번호로 세지 않는다', () => {
    // DB를 거치면 null이 'null'로 온다. 그걸 취소하러 가면 404가 난다.
    eq(ownedOrderIds({ placed: [null, '', 'null', 'undefined', ' 7 '] }).join(','), '7');
  });

  test('Gate는 id, 바이낸스는 orderId', () => {
    eq(orderIdOf({ id: 55 }), '55');
    eq(orderIdOf({ orderId: 77 }), '77');
    eq(orderIdOf(null), '');
  });

  console.log('[보호주문 장부 — HTTP 200은 "지워졌다"가 아니다]');

  test('재조회에서 사라져야 취소 확인이다', () => {
    const l = cancelLedger({ ids: ['1', '2'], attempts: [A('1'), A('2')], leftover: [] });
    eq(l.ok, true); eq(l.code, 'CLEAR');
    eq(l.entries.every(e => e.state === 'CANCEL_CONFIRMED'), true);
  });

  test('200을 받았는데 남아 있으면 실패다 — 8/15에 실제로 난 일', () => {
    // 거래소가 성공을 줬다고 지워진 것이 아니다.
    const l = cancelLedger({ ids: ['1', '2'], attempts: [A('1'), A('2')], leftover: [O('1'), O('2')] });
    eq(l.ok, false); eq(l.code, 'STILL_PRESENT');
    eq(l.stillPresent.join(','), '1,2');
    assert(l.entries[0].note.includes('거래소는 성공을 줬지만'), l.entries[0].note);
  });

  test('일부만 남아도 통과가 아니다', () => {
    const l = cancelLedger({ ids: ['1', '2'], attempts: [A('1'), A('2')], leftover: [O('2')] });
    eq(l.ok, false);
    eq(l.stillPresent.join(','), '2');
  });

  test('취소 뒤 목록을 못 읽으면 UNKNOWN이다 — 0으로 읽지 않는다', () => {
    // **못 읽은 것을 "없어졌다"로 읽으면 이 판정이 있으나 마나다.**
    const l = cancelLedger({ ids: ['1'], attempts: [A('1')], leftover: null });
    eq(l.ok, false); eq(l.code, 'UNKNOWN');
    eq(l.unknown.join(','), '1');
  });

  test('취소 요청조차 못 했는데 목록에 있으면 남은 것이다', () => {
    const l = cancelLedger({ ids: ['1'], attempts: [A('1', { requested: false, httpOk: false, response: '번호 없음' })], leftover: [O('1')] });
    eq(l.code, 'STILL_PRESENT');
  });

  test('취소 전에 이미 사라졌으면 통과다 — 없애는 것이 목적이었다', () => {
    // 트리거가 발동했거나 다른 경로가 지웠다. 없는 것은 사실이다.
    const l = cancelLedger({ ids: ['9'], attempts: [], leftover: [] });
    eq(l.ok, true);
    assert(l.entries[0].note.includes('이미 사라졌습니다'), l.entries[0].note);
  });

  test('취소할 번호가 없으면 실패가 아니다', () => {
    eq(cancelLedger({ ids: [], attempts: [], leftover: [] }).code, 'NOTHING_TO_CANCEL');
  });

  test('남의 주문이 목록에 있어도 내 판정에 영향을 주지 않는다', () => {
    // 내가 요청한 번호만 본다 — 다른 전략 주문을 세면 영원히 FAIL이다.
    const l = cancelLedger({ ids: ['1'], attempts: [A('1')], leftover: [O('999')] });
    eq(l.ok, true);
  });

  // P0: 취소 후 조회된 행의 ID를 읽지 못하면 '없다'고 증명할 수 없다.
  // 취소 전 목록에 있던 주문이 정밀도 손실/namespace 차이로 같은 ID를
  // 드러내지 못해도 CLEAR를 적어서는 안 된다.
  test('★★ 재조회 ID가 정밀도를 잃으면 CLEAR가 아니라 UNKNOWN', () => {
    const l = cancelLedger({
      ids: ['9007199254740993'], attempts: [A('9007199254740993')],
      leftover: [{ id: 9007199254740993 }],
    });
    eq(l.ok, false); eq(l.code, 'UNKNOWN');
    eq(l.unknown.join(','), '9007199254740993');
  });

  test('★★ 재조회가 Algo 식별자만 주면 일반 ID 소실을 CLEAR로 적지 않는다', () => {
    const l = cancelLedger({
      ids: ['77'], attempts: [A('77')],
      leftover: [{ algoId: '999', clientAlgoId: 'smoke-999' }],
    });
    eq(l.ok, false); eq(l.code, 'UNKNOWN');
    eq(l.entries[0].state, 'CANCEL_UNKNOWN');
  });

  test('★★ 다른 번호가 확인되고 미확인 행이 함께 있으면 요청 번호는 UNKNOWN', () => {
    const l = cancelLedger({
      ids: ['77'], attempts: [A('77')],
      leftover: [O('999'), { orderId: Number.MAX_SAFE_INTEGER + 10 }],
    });
    eq(l.ok, false); eq(l.code, 'UNKNOWN');
    eq(l.unknown.join(','), '77');
  });

  console.log('[되돌리기 — 포지션만 닫고 보호주문을 남기지 않는다]');

  test('되돌릴 때 걸어 둔 SL·TP를 대상으로 잡는다', () => {
    eq(rollbackTargets({ slOrderId: '11', tpOrderId: '22' }).join(','), '11,22');
    eq(rollbackTargets({ slOrderId: '11', tpOrderId: null }).join(','), '11');
    eq(rollbackTargets({}).length, 0);
  });

  test('"되돌렸다"와 "보호주문도 지웠다"를 한 문장에 섞지 않는다', () => {
    const bad = rollbackNote({
      positionClosed: true,
      ledger: cancelLedger({ ids: ['1'], attempts: [A('1')], leftover: [O('1')] }),
    });
    assert(bad.includes('되돌렸습니다'), bad);
    assert(bad.includes('⚠'), bad);
    assert(bad.includes('남아 있습니다'), bad);

    const good = rollbackNote({
      positionClosed: true,
      ledger: cancelLedger({ ids: ['1'], attempts: [A('1')], leftover: [] }),
    });
    assert(good.includes('취소 확인'), good);
  });

  test('취소 요청이 비면 "지웠다"의 증거가 아니다 — 시도조차 안 한 것이다', () => {
    // **2026-08-16에 이걸로 다시 물어봤다.** 장부가 ok:true를 주는데
    // 거래소에는 주문이 남아 있는 경우가 정확히 이것이다: 소유 판정이
    // 내 것을 못 알아봐서 `plan.cancel`이 비었고, 그래서 취소를 한 번도
    // 요청하지 않았다. 장부는 "요청한 것이 전부 사라졌다"만 말할 수
    // 있으므로, 요청이 0건이면 그건 **정리 성공의 증거가 아니다.**
    const l = cancelLedger({ ids: [], attempts: [], leftover: [O('1'), O('2')] });
    eq(l.code, 'NOTHING_TO_CANCEL');
    // 통과 판정은 잔여 판정(residualVerdict)이 따로 해야 한다 —
    // 이 장부 하나로 ORDERS_ZERO를 PASS로 적으면 거짓 PASS가 된다.
    eq(l.entries.length, 0);
  });

  test('CANCEL_CONFIRMED는 재조회 없이는 절대 찍히지 않는다', () => {
    // leftover가 null이면 HTTP가 200이든 아니든 전부 UNKNOWN이어야 한다.
    for (const httpOk of [true, false]) {
      const l = cancelLedger({ ids: ['1'], attempts: [A('1', { httpOk })], leftover: null });
      eq(l.entries[0].state, 'CANCEL_UNKNOWN', `httpOk=${httpOk}`);
      eq(l.ok, false, `httpOk=${httpOk}`);
    }
  });


  console.log('[고아 주문 취소 — 포지션·소유권·namespace 관문]');
  const target = { id: '77', ownership: 'MINE', namespace: 'GATE_PRICE' };
  const flat = { ok: true, found: false, qty: 0 };
  const check = (over: Partial<Parameters<typeof orphanCancelGate>[0]> = {}) =>
    orphanCancelGate({ position: flat, ledgerReadable: true, orders: [target], asked: ['77'], ...over });
  test('포지션 0 + 정확한 Gate 주문 1건만 취소 대상으로 허용', () => {
    const v = check(); eq(v.ok, true); eq(v.targets.join(','), '77');
  });
  test('포지션이 열려 있으면 보호주문 취소 금지', () => {
    const v = check({ position: { ok: true, found: true, qty: 1 } });
    eq(v.code, 'POSITION_NOT_FLAT'); eq(v.targets.length, 0);
  });
  test('조회 실패에 qty 0이 있어도 취소 금지', () => {
    eq(check({ position: { ok: false, found: false, qty: 0 } }).code, 'POSITION_NOT_FLAT');
  });
  test('포지션 수량이 null이면 found false여도 취소 금지', () => {
    eq(check({ position: { ok: true, found: false, qty: null } }).code, 'POSITION_NOT_FLAT');
  });
  test('장부 또는 주문 목록 조회 실패는 취소 금지', () => {
    eq(check({ ledgerReadable: false }).code, 'LEDGER_UNREADABLE');
    eq(check({ orders: null }).code, 'ORDERS_UNREADABLE');
  });
  test('FOREIGN과 UNKNOWN 주문은 취소 금지', () => {
    for (const ownership of ['FOREIGN', 'UNKNOWN']) {
      eq(check({ orders: [{ ...target, ownership }] }).code, 'OWNERSHIP_NOT_PROVEN');
    }
  });
  test('Binance Algo ID는 일반 주문 DELETE로 보내지 않는다', () => {
    eq(check({ orders: [{ ...target, namespace: 'BINANCE_ALGO' }] }).code, 'UNSUPPORTED_NAMESPACE');
    eq(check({ orders: [{ ...target, namespace: 'UNKNOWN' }] }).code, 'UNSUPPORTED_NAMESPACE');
  });
  test('Binance 일반 주문은 명확한 ID일 때만 허용', () => {
    eq(check({ orders: [{ ...target, namespace: 'BINANCE_REGULAR' }] }).ok, true);
  });
  test('번호 없음·목록 누락·중복 번호는 취소 금지', () => {
    eq(check({ asked: [] }).code, 'IDS_REQUIRED');
    eq(check({ orders: [] }).code, 'TARGET_NOT_UNIQUE');
    eq(check({ orders: [target, target] }).code, 'TARGET_NOT_UNIQUE');
  });

  test('지울 것이 없으면 되돌리기 문구만 남는다', () => {
    const s = rollbackNote({ positionClosed: false, ledger: cancelLedger({ ids: [], attempts: [], leftover: [] }) });
    assert(s.includes('되돌리기 실패'), s);
  });
}
