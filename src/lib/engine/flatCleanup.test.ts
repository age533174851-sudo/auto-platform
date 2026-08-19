// src/lib/engine/flatCleanup.test.ts
//
// **포지션이 이미 0인 길에 정리가 없었다 — 그 구멍을 값으로 막는다.**
//
// 실제 my-original-v1 TESTNET 자동매매에서 재현됐다: Gate에
// **Positions 0 / Orders 1**. 정리 코드는 있었지만 `entryGate`가 반대
// 방향 포지션을 발견했을 때의 분기 안에만 있었고, 포지션이 이미 0이면
// entryGate는 곧바로 PROCEED를 준다 — 그 길에는 정리가 한 줄도 없었다.
//
// 그래서 여기서 가장 많이 확인하는 것은 둘이다:
//   1. 포지션 0 + 내 보호주문 → **정확한 번호로 취소되는가**
//   2. 확인하지 못한 것이 **신규 진입을 막는가**

import { test, eq, assert } from '../../test/harness';
import { flatCleanupPlan, flatCleanupVerdict } from './flatCleanup';
import { cancelLedger } from './protectionLedger';
import { ownedClientOrderId } from './orderOwnership';

const MY = 'my-original-v1';
const FLAT = { ok: true, found: false, qty: 0 };

/** 실제 크기의 Gate 조건부 주문 번호 — int64라 JS number로는 못 담는다 (#139) */
const SL_ID = '2089209928026685417';
const TP_ID = '2089209928399978533';

const myText = (purpose: 'STOP_LOSS' | 'TAKE_PROFIT', strategyId = MY) =>
  ownedClientOrderId({
    owner: { strategyId, symbol: 'BTCUSDT' } as any,
    logicalKey: '2026-08-18', purpose,
  });

/** Gate price_orders 한 줄 모양 */
const order = (id: string, text: string) => ({
  id, status: 'open',
  initial: { contract: 'BTC_USDT', size: -1, price: '0', reduce_only: true, text },
  trigger: { price: '60000', rule: 1 },
});

/** 취소가 전부 확인된 장부 */
const confirmed = (ids: string[]) => cancelLedger({
  ids,
  attempts: ids.map(id => ({ id, requested: true, httpOk: true, response: null, tries: 1 })),
  leftover: [],
});

export function runFlatCleanupTests() {
  console.log('[포지션 0 정리 — 무엇을 지우는가]');

  test('**포지션 0 + 내 손절 1건 → 그 번호를 정확히 취소한다**', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
    });
    eq(plan.code, 'CLEAN');
    eq(plan.cancel.join(','), SL_ID);
    eq(plan.blockEntry, false);

    const v = flatCleanupVerdict({ plan, ledger: confirmed(plan.cancel) });
    eq(v.code, 'CLEAN'); eq(v.ok, true); eq(v.blockEntry, false);
    eq(v.cancelled.join(','), SL_ID);
  });

  test('**포지션 0 + 내 익절 1건 → 그 번호를 정확히 취소한다**', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(TP_ID, myText('TAKE_PROFIT'))], myStrategyId: MY,
    });
    eq(plan.cancel.join(','), TP_ID);
    eq(flatCleanupVerdict({ plan, ledger: confirmed(plan.cancel) }).blockEntry, false);
  });

  test('**둘 다 남아 있으면 둘 다 취소한다**', () => {
    const plan = flatCleanupPlan({
      position: FLAT, myStrategyId: MY,
      orders: [order(SL_ID, myText('STOP_LOSS')), order(TP_ID, myText('TAKE_PROFIT'))],
    });
    eq(plan.cancel.length, 2);
    const v = flatCleanupVerdict({ plan, ledger: confirmed(plan.cancel) });
    eq(v.code, 'CLEAN'); eq(v.cancelled.length, 2);
  });

  test('치울 것이 없으면 그냥 통과한다 — 진입을 막지 않는다', () => {
    const plan = flatCleanupPlan({ position: FLAT, orders: [], myStrategyId: MY });
    eq(plan.code, 'NOTHING_TO_DO'); eq(plan.blockEntry, false);
    const v = flatCleanupVerdict({ plan, ledger: null });
    eq(v.code, 'NOTHING_TO_DO'); eq(v.ok, true); eq(v.blockEntry, false);
  });

  console.log('[포지션 0 정리 — 남의 주문은 절대 안 지운다]');

  test('**다른 전략의 주문은 취소 목록에 들어가지 않는다**', () => {
    const foreign = order('9001', myText('STOP_LOSS', 'scalp'));
    const plan = flatCleanupPlan({ position: FLAT, orders: [foreign], myStrategyId: MY });
    eq(plan.cancel.length, 0);
    eq(plan.keep.length, 1);
    eq(plan.keep[0].class, 'FOREIGN');
    // **남의 손절이 남아 있다고 내 진입을 영원히 막지는 않는다.**
    // 못 여는 것은 불편이고 못 닫는 것은 사고다 — 다만 무엇을 두고
    // 가는지는 사유에 적는다.
    eq(plan.blockEntry, false);
    assert(/그대로 둡니다/.test(plan.reason), plan.reason);
  });

  test('소유를 못 읽은 주문도 건드리지 않는다', () => {
    const plan = flatCleanupPlan({ position: FLAT, orders: [order('9002', 'api')], myStrategyId: MY });
    eq(plan.cancel.length, 0);
    eq(plan.keep[0].class, 'UNKNOWN');
  });

  test('**번호로만 증명하라고 하면 식별자만으로는 안 지운다**', () => {
    // 청산 감시는 전략 id를 들고 있지 않다. 그때는 적어 둔 번호만 믿는다.
    const mine = order(SL_ID, myText('STOP_LOSS'));
    const plan = flatCleanupPlan({
      position: FLAT, orders: [mine], myStrategyId: MY, ownedIds: [], ownedOnly: true,
    });
    eq(plan.cancel.length, 0);
    eq(plan.keep.length, 1);
  });

  test('번호가 일치하면 식별자가 깨져 있어도 지운다', () => {
    // 2026-08-15에 실제로 이랬다 — text 형식이 깨져 UNKNOWN이 됐고,
    // UNKNOWN은 안전을 이유로 안 지워서 거래소에 2건이 남았다.
    const broken = order(SL_ID, 'api');
    const plan = flatCleanupPlan({
      position: FLAT, orders: [broken], myStrategyId: MY, ownedIds: [SL_ID], ownedOnly: true,
    });
    eq(plan.cancel.join(','), SL_ID);
  });

  console.log('[포지션 0 정리 — 모르면 진입하지 않는다]');

  test('**조건부 주문 목록을 못 읽으면 신규 진입을 막는다**', () => {
    const plan = flatCleanupPlan({ position: FLAT, orders: null, myStrategyId: MY });
    eq(plan.code, 'ORDERS_UNKNOWN');
    eq(plan.blockEntry, true);
    eq(flatCleanupVerdict({ plan, ledger: null }).blockEntry, true);
  });

  test('포지션을 못 읽으면 아무것도 취소하지 않고 진입도 막는다', () => {
    const plan = flatCleanupPlan({
      position: { ok: false, found: false }, orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
    });
    eq(plan.code, 'POSITION_UNKNOWN');
    eq(plan.cancel.length, 0);
    eq(plan.blockEntry, true);
  });

  test('**취소했는데 아직 있으면 신규 진입을 막는다**', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
    });
    const ledger = cancelLedger({
      ids: plan.cancel,
      attempts: [{ id: SL_ID, requested: true, httpOk: true, response: null, tries: 3 }],
      leftover: [order(SL_ID, myText('STOP_LOSS'))],   // 재조회에 아직 있다
    });
    const v = flatCleanupVerdict({ plan, ledger });
    eq(v.code, 'STILL_PRESENT'); eq(v.ok, false); eq(v.blockEntry, true);
    assert(/다음 진입을 예상치 못하게 닫습니다/.test(v.reason), v.reason);
  });

  test('**취소 뒤 목록을 못 읽었으면 신규 진입을 막는다** — 모르는 것은 0이 아니다', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
    });
    const ledger = cancelLedger({
      ids: plan.cancel,
      attempts: [{ id: SL_ID, requested: true, httpOk: true, response: null, tries: 1 }],
      leftover: null,   // 재조회 실패
    });
    const v = flatCleanupVerdict({ plan, ledger });
    eq(v.code, 'CANCEL_UNKNOWN'); eq(v.blockEntry, true);
  });

  test('취소를 했는데 결과 기록이 없으면 통과로 적지 않는다', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
    });
    const v = flatCleanupVerdict({ plan, ledger: null });
    eq(v.code, 'CANCEL_UNKNOWN'); eq(v.blockEntry, true);
  });

  console.log('[포지션 0 정리 — 포지션이 남아 있을 때]');

  test('**포지션이 있으면 그 보호주문은 고아가 아니다** — 반전 판단은 entryGate가 한다', () => {
    const plan = flatCleanupPlan({
      position: { ok: true, found: true, qty: 0.01 },
      orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
    });
    eq(plan.code, 'NOT_FLAT');
    eq(plan.cancel.length, 0);
    // 여기서 막지 않는다 — 같은 방향/반대 방향 판단은 entryGate의 몫이다.
    eq(plan.blockEntry, false);
    assert(/방어선/.test(plan.reason), plan.reason);
  });

  console.log('[포지션 0 정리 — int64 주문번호 (#139)]');

  test('**19자리 번호가 문자열 그대로 취소 목록에 실린다**', () => {
    assert(!Number.isSafeInteger(Number(SL_ID)), 'SL_ID는 안전 정수 범위를 넘어야 한다');
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
    });
    eq(plan.cancel[0], SL_ID);
    eq(plan.cancel[0].length, 19);
  });

  test('**반올림된 번호는 내 것으로 인정되지 않는다**', () => {
    // JSON.parse가 int64를 Number로 만들면 끝자리가 반올림된다.
    // 그 값으로 취소를 보내면 거래소는 "그런 주문 없다"고 답한다.
    const rounded = String(Number(SL_ID));
    assert(rounded !== SL_ID, '반올림된 값과 원래 값이 달라야 한다');
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, 'api')], myStrategyId: MY,
      ownedIds: [rounded], ownedOnly: true,
    });
    eq(plan.cancel.length, 0);
  });

  test('숫자로 들어온 int64는 번호로 쓰지 않는다', () => {
    // 파서가 뚫린 경로가 하나라도 있으면 여기서 걸린다.
    const numeric = { id: Number(SL_ID), initial: { text: myText('STOP_LOSS') }, trigger: {} };
    const plan = flatCleanupPlan({ position: FLAT, orders: [numeric], myStrategyId: MY });
    eq(plan.cancel.length, 0);
  });
}
