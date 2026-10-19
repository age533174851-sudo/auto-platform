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
import { loadOwnedProtectionIds } from './protectionCleanup';
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

/**
 * `loadOwnedProtectionIds`가 쓰는 Supabase 체인만 흉내 낸다.
 *
 * `limit()`이 실제 조회다 — 거기까지 가야 `onRead`가 불린다. 그래서
 * "체인을 만들었다"와 "장부를 읽었다"를 구별할 수 있다.
 */
const chain = (reply: { data: any; error: any }, onRead?: () => void): any => {
  const c: any = {
    select: () => c, eq: () => c, order: () => c,
    limit: async () => { onRead?.(); return reply; },
  };
  return c;
};

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

  // ══════════════════════════════════════════════════════════
  // 소유 번호를 **못 읽은** 회차 — 0건과 같지 않다
  // ══════════════════════════════════════════════════════════
  //
  //   `loadOwnedProtectionIds`는 `live_orders`에서 걸어 둔 보호주문 번호를
  //   읽는다. 그 조회가 실패하면 빈 배열이 나오고, 그러면 **내 주문이
  //   UNKNOWN으로 분류되어 `keep`에 남는다.** 그 상태의 판정이
  //   `NOTHING_TO_DO`(blockEntry: false)여서 신규 진입이 그 위로 나갔다.
  //
  //   이 파일 머리말의 규칙 그대로다: "목록을 못 읽었거나 취소를 확인
  //   못 했으면 신규 진입을 막는다." 소유 번호 목록도 그 목록이다.

  test('★ 소유 번호를 못 읽었는데 불명 주문이 남아 있으면 신규 진입을 막는다', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, 'api')], myStrategyId: MY,
      ownedIds: [], ownedIdsKnown: false,
    });
    eq(plan.blockEntry, true,
      '★ 내 것일 수도 있는 보호주문 위로 신규 진입이 나갔다');
    eq(plan.cancel.length, 0, '모르는 주문을 취소하지도 않는다');
    assert(plan.reason.includes('읽지 못'), plan.reason);
  });

  test('★ 그 판정이 CLEAN으로 뒤집히지 않는다', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, 'api')], myStrategyId: MY,
      ownedIds: [], ownedIdsKnown: false,
    });
    const v = flatCleanupVerdict({ plan, ledger: null });
    eq(v.ok, false);
    eq(v.blockEntry, true, '★ 최종 판정이 진입을 열었다');
    eq(v.code, 'OWNERSHIP_UNKNOWN');
  });

  test('못 읽었어도 **남은 주문이 없으면** 막지 않는다', () => {
    // 치울 것도 없고 모를 것도 없다. 여기서 막으면 영원히 못 여는 상태가 된다.
    const plan = flatCleanupPlan({
      position: FLAT, orders: [], myStrategyId: MY,
      ownedIds: [], ownedIdsKnown: false,
    });
    eq(plan.blockEntry, false);
    eq(plan.code, 'NOTHING_TO_DO');
    eq(flatCleanupVerdict({ plan, ledger: null }).blockEntry, false);
  });

  test('못 읽었어도 남은 것이 **남의 것으로 증명되면** 막지 않는다', () => {
    // FOREIGN은 소유 번호와 무관하게 확정이다 — 그것 때문에 영원히 막으면
    // 남의 주문 하나가 내 전략을 멈춘다.
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(TP_ID, myText('TAKE_PROFIT', 'someone-else'))],
      myStrategyId: MY, ownedIds: [], ownedIdsKnown: false,
    });
    eq(plan.keep.length, 1);
    eq(plan.keep[0].class, 'FOREIGN');
    eq(plan.blockEntry, false);
  });

  test('읽었는데 정말 0건이면 예전과 같다 (하위 호환)', () => {
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, 'api')], myStrategyId: MY,
      ownedIds: [], ownedIdsKnown: true,
    });
    eq(plan.blockEntry, false, '읽은 결과가 0건인 것은 모르는 것이 아니다');
    const noFlag = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, 'api')], myStrategyId: MY, ownedIds: [],
    });
    eq(noFlag.blockEntry, false, '플래그를 안 주면 "읽었다"로 본다');
  });

  test('★ 소유 번호를 못 읽었어도 **취소는 번호로만** 한다', () => {
    // 막는 것과 지우는 것은 다른 질문이다. 모르면 막되, 모른다고
    // 아무 번호나 지우지 않는다 — Cancel All 금지가 여기서도 그대로다.
    const plan = flatCleanupPlan({
      position: FLAT, orders: [order(SL_ID, myText('STOP_LOSS'))], myStrategyId: MY,
      ownedIds: [], ownedIdsKnown: false,
    });
    eq(plan.cancel.length, 0, '★ 모르는 회차에 취소가 나갔다');
  });

  console.log('[고아 정리 — 소유 번호 조회 실패]');

  test('★ 조회가 실패하면 idsKnown이 false다 — 빈 배열과 구별된다', async () => {
    const failing: any = { from: () => chain({ data: null, error: { message: '조회 실패' } }) };
    const r = await loadOwnedProtectionIds(failing, { connectionId: 'c1', symbol: 'BTCUSDT' });
    eq(r.ids.length, 0);
    eq(r.idsKnown, false, '★ 못 읽은 것이 "번호 없음"과 같아졌다');
  });

  test('★ 조회가 던져도 idsKnown이 false다', async () => {
    const thrower: any = { from: () => { throw new Error('연결 끊김'); } };
    const r = await loadOwnedProtectionIds(thrower, { connectionId: 'c1', symbol: 'BTCUSDT' });
    eq(r.idsKnown, false);
  });

  test('읽혔으면 idsKnown이 true다 — 0건이어도 그렇다', async () => {
    const empty: any = { from: () => chain({ data: [], error: null }) };
    const r = await loadOwnedProtectionIds(empty, { connectionId: 'c1', symbol: 'BTCUSDT' });
    eq(r.ids.length, 0);
    eq(r.idsKnown, true);
  });

  test('연결도 사용자도 없으면 장부를 읽지 않는다 — 그때도 "모른다"다', async () => {
    let awaited = false;
    const watch: any = { from: () => chain({ data: [], error: null }, () => { awaited = true; }) };
    const r = await loadOwnedProtectionIds(watch, { symbol: 'BTCUSDT' });
    eq(awaited, false, '누구 것인지 모르는 채로 장부를 읽지 않는다');
    eq(r.idsKnown, false, '묻지 않았으면 "없다"가 아니라 "모른다"다');
    eq(r.ids.length, 0);
  });
}
