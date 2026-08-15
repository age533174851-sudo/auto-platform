// src/lib/engine/positionLifecycle.test.ts
//
// **어제 실제로 난 사고를 그대로 재현한다.**
//
// 전날 BTCUSDT SHORT · ETHUSDT SHORT가 안 닫힌 상태에서 다음 거래일
// 신호가 그대로 나갔다. BTCUSDT는 수량이 2배가 됐고, ETHUSDT는 상계되어
// 0.01 ETH 찌꺼기가 남았으며, Gate에는 조건부 주문 4개가 쌓였다.
//
// 아래 테스트는 그 입력을 그대로 넣는다. **하나라도 통과가 나오면
// 같은 사고가 다시 난다.**

import { test, eq, assert } from '../../test/harness';
import {
  openPositionOf, entryGate, reversalProgress, lifecycleGate,
  type OpenPosition,
} from './positionLifecycle';
import {
  ownedClientOrderId, parseOwnedClientOrderId, classifyOrder,
  orphanCleanupPlan, cleanupOutcome, symbolOwnershipConflict, strategyPrefixOf,
  protectiveClientOrderId, residualVerdict, ownershipTextOf,
} from './orderOwnership';
import { fillBasis, exitFromFill, roundTrigger } from './fillBasedExit';
import { readbackProtective, triggerMatches } from './protectiveReadback';
import { enteredVerdict, outcomeOf } from './entryEvidence';
import { closeVerdict } from './closeEvidence';

/** Gate 포지션 조회 응답 모양 */
const gatePos = (contract: string, size: number) => ({ contract, size });
/** 어제 남아 있던 SHORT */
const OLD_SHORT: OpenPosition = { ok: true, found: true, qty: 0.002, side: 'SHORT', error: null };
const NONE: OpenPosition = { ok: true, found: false, qty: 0, side: null, error: null };
const UNREADABLE: OpenPosition = { ok: false, found: false, qty: null, side: null, error: 'timeout' };

/** 되읽기로 확인된 보호주문 */
const FOUND = (price: number, closes: 'LONG' | 'SHORT') =>
  ({ readOk: true, found: true, orderId: 'x', triggerPrice: price, closes, reason: '' });
const NOT_FOUND = { readOk: true, found: false, orderId: null, triggerPrice: null, closes: null, reason: '' };
const READ_FAILED = { readOk: false, found: false, orderId: null, triggerPrice: null, closes: null, reason: '' };

export function runPositionLifecycleTests() {
  console.log('[포지션 생명주기 — 어제 난 사고 재현]');

  test('A. 기존 SHORT + 다음날 SHORT 신호 → 추가 숏을 내지 않는다', () => {
    // BTCUSDT에서 실제로 난 일이다. 이 주문이 나가서 수량이 2배가 됐다.
    const v = entryGate({ read: OLD_SHORT, desiredSide: 'SHORT' });
    eq(v.ok, false, '같은 방향 추가진입이 통과했다 — 수량이 2배가 된다');
    eq(v.code, 'SAME_SIDE_BLOCKED');
    eq(v.needsReversal, false, '같은 방향은 반전으로 풀 문제가 아니다');
    assert(v.reason.includes('2배'), v.reason);
  });

  test('A-2. 피라미딩을 전략이 명시 허용했을 때만 통과한다', () => {
    eq(entryGate({ read: OLD_SHORT, desiredSide: 'SHORT', pyramiding: true }).ok, true);
    // 기본값은 금지다 — 안 넘긴 호출부의 동작이 느슨해지면 안 된다.
    eq(entryGate({ read: OLD_SHORT, desiredSide: 'SHORT' }).ok, false);
    eq(entryGate({ read: OLD_SHORT, desiredSide: 'SHORT', pyramiding: false as any }).ok, false);
  });

  test('B. 기존 SHORT + 다음날 LONG 신호 → 먼저 전량청산을 요구한다', () => {
    // ETHUSDT에서 실제로 난 일이다. 이 LONG이 그냥 나가서 상계됐고,
    // 0.01 ETH LONG 찌꺼기가 남았다.
    const v = entryGate({ read: OLD_SHORT, desiredSide: 'LONG' });
    eq(v.ok, false, '반대 주문이 그냥 나갔다 — netting 찌꺼기가 남는다');
    eq(v.code, 'REVERSAL_REQUIRED');
    eq(v.needsReversal, true);
    assert(v.reason.includes('상계'), v.reason);
  });

  test('B-2. 반전은 청산 → 0 확인 → 보호주문 정리 순서를 전부 지나야 열린다', () => {
    const stages: any[] = [
      [{}, 'CLOSE_NOT_REQUESTED'],
      [{ closeRequested: true }, 'CLOSE_UNKNOWN'],
      [{ closeRequested: true, closeAccepted: false }, 'CLOSE_NOT_ACCEPTED'],
      [{ closeRequested: true, closeAccepted: true }, 'CLOSE_UNKNOWN'],
    ];
    for (const [ev, code] of stages) eq(reversalProgress(ev).code, code, JSON.stringify(ev));

    const closed = closeVerdict({
      before: { ok: true, found: true, amount: 0.002 },
      order: { attempted: true, ok: true },
      after: { ok: true, found: false, amount: 0 },
    });
    eq(closed.closed, true);
    // 포지션은 0인데 보호주문 정리가 아직이면 여전히 막힌다.
    eq(reversalProgress({ closeRequested: true, closeAccepted: true, closeVerdict: closed }).code,
      'PROTECTION_UNKNOWN');
    const done = reversalProgress({
      closeRequested: true, closeAccepted: true, closeVerdict: closed, protectionCleaned: true,
    });
    eq(done.ok, true); eq(done.stage, 'READY_TO_OPEN');
  });

  test('C. close API가 200이어도 재조회에 실패하면 신규 LONG을 내지 않는다', () => {
    // **접수는 체결이 아니다.** 이걸 통과시키면 아직 열려 있는 SHORT 위로
    // LONG이 들어간다 — ETHUSDT 찌꺼기가 그대로 재현된다.
    const cv = closeVerdict({
      before: { ok: true, found: true, amount: 0.002 },
      order: { attempted: true, ok: true },
      after: { ok: false, found: false, amount: null, error: 'timeout' },
    });
    eq(cv.closed, false);
    eq(cv.code, 'RECONCILE_REQUIRED');

    const g = lifecycleGate({
      read: OLD_SHORT, desiredSide: 'LONG',
      reversal: { closeRequested: true, closeAccepted: true, closeVerdict: cv, protectionCleaned: true },
    });
    eq(g.ok, false, '재조회 실패 위에서 신규 진입이 통과했다');
    eq(g.code, 'CLOSE_UNKNOWN');
  });

  test('C-2. 청산 주문 뒤에도 포지션이 남아 있으면 열지 않는다', () => {
    const cv = closeVerdict({
      before: { ok: true, found: true, amount: 0.002 },
      order: { attempted: true, ok: true },
      after: { ok: true, found: true, amount: 0.0005 },   // 부분 체결
    });
    eq(reversalProgress({ closeRequested: true, closeAccepted: true, closeVerdict: cv }).code, 'STILL_OPEN');
  });

  test('포지션 조회 실패를 "포지션 없음"으로 읽지 않는다', () => {
    const v = entryGate({ read: UNREADABLE, desiredSide: 'LONG' });
    eq(v.ok, false); eq(v.code, 'POSITION_UNKNOWN');
  });

  test('방향이나 수량을 못 읽은 포지션 위에서는 들어가지 않는다', () => {
    eq(entryGate({ read: { ok: true, found: true, qty: 0.1, side: null }, desiredSide: 'LONG' }).code,
      'POSITION_AMBIGUOUS');
    eq(entryGate({ read: { ok: true, found: true, qty: null, side: 'LONG' }, desiredSide: 'LONG' }).code,
      'POSITION_AMBIGUOUS');
  });

  test('열린 것이 없을 때만 바로 통과한다', () => {
    const v = entryGate({ read: NONE, desiredSide: 'LONG' });
    eq(v.ok, true); eq(v.code, 'PROCEED');
  });

  console.log('[포지션 생명주기 — 거래소 응답 읽기]');

  test('Gate size 부호가 방향이다', () => {
    const short = openPositionOf({ ok: true, positions: [gatePos('ETH_USDT', -3)] }, 'ETHUSDT');
    eq(short.found, true); eq(short.side, 'SHORT'); eq(short.qty, 3);
    const long = openPositionOf({ ok: true, positions: [gatePos('BTC_USDT', 2)] }, 'BTCUSDT');
    eq(long.side, 'LONG'); eq(long.qty, 2);
  });

  test('0짜리 줄은 포지션이 아니다', () => {
    const r = openPositionOf({ ok: true, positions: [gatePos('ETH_USDT', 0)] }, 'ETHUSDT');
    eq(r.ok, true); eq(r.found, false);
  });

  test('배열이 아닌 응답을 "없음"으로 읽지 않는다', () => {
    for (const bad of [null, {}, { success: false, message: 'auth' }, { ok: true }]) {
      const r = openPositionOf(bad, 'ETHUSDT');
      eq(r.ok, false, JSON.stringify(bad));
    }
  });

  test('줄은 있는데 수량을 못 읽으면 "있다 · 모른다"다', () => {
    const r = openPositionOf({ ok: true, positions: [{ contract: 'ETH_USDT', size: 'x' }] }, 'ETHUSDT');
    eq(r.ok, true); eq(r.found, true); eq(r.qty, null);
  });

  console.log('[보호주문 소유권 — 남의 손절을 지우지 않는다]');

  const MINE = { id: '111', initial: { text: 't-mo1-20260814ETHUSDS0' } };
  const FOREIGN = { id: '222', initial: { text: 't-dl-20260814ETHUSDS0' } };
  const NAMELESS = { id: '333', initial: {} };

  test('D. 포지션 0을 확인한 뒤 이 전략의 SL/TP를 정리한다', () => {
    const plan = orphanCleanupPlan({
      position: { ok: true, found: false, qty: 0 },
      orders: [MINE, { id: '444', initial: { text: 't-mo1-20260814ETHUSDP0' } }],
      myStrategyId: 'my-original-v1',
    });
    eq(plan.ok, true); eq(plan.code, 'CLEAN');
    eq(plan.cancel.join(','), '111,444');
  });

  test('E. 다른 전략이 만든 보호주문은 보존한다', () => {
    const plan = orphanCleanupPlan({
      position: { ok: true, found: false, qty: 0 },
      orders: [MINE, FOREIGN, NAMELESS],
      myStrategyId: 'my-original-v1',
    });
    eq(plan.cancel.join(','), '111');
    eq(plan.keep.length, 2);
    eq(plan.keep.find(k => k.id === '222')!.class, 'FOREIGN');
    // 소유권을 못 읽은 것도 건드리지 않는다 — cancelAll과 같아진다.
    eq(plan.keep.find(k => k.id === '333')!.class, 'UNKNOWN');
  });

  test('포지션이 남아 있으면 아무것도 취소하지 않는다 — 그건 방어선이다', () => {
    const plan = orphanCleanupPlan({
      position: { ok: true, found: true, qty: 0.002 },
      orders: [MINE], myStrategyId: 'my-original-v1',
    });
    eq(plan.ok, false); eq(plan.code, 'POSITION_OPEN'); eq(plan.cancel.length, 0);
  });

  test('포지션 조회 실패 상태에서는 취소하지 않는다', () => {
    const plan = orphanCleanupPlan({
      position: { ok: false, found: false }, orders: [MINE], myStrategyId: 'my-original-v1',
    });
    eq(plan.ok, false); eq(plan.code, 'POSITION_UNKNOWN'); eq(plan.cancel.length, 0);
  });

  test('주문 목록을 못 읽은 것과 0건은 다르다', () => {
    eq(orphanCleanupPlan({ position: { ok: true, found: false }, orders: null, myStrategyId: 'x' }).code,
      'ORDERS_UNKNOWN');
    eq(orphanCleanupPlan({ position: { ok: true, found: false }, orders: [], myStrategyId: 'x' }).code,
      'NOTHING_TO_DO');
  });

  test('취소에 실패한 것을 "정리 완료"로 적지 않는다', () => {
    const plan = orphanCleanupPlan({
      position: { ok: true, found: false }, orders: [MINE, { id: '444', initial: { text: 't-mo1-20260814ETHUSDP0' } }],
      myStrategyId: 'my-original-v1',
    });
    eq(cleanupOutcome({ plan, cancelled: ['111'] }).cleaned, false);
    eq(cleanupOutcome({ plan, cancelled: null }).cleaned, null);
    eq(cleanupOutcome({ plan, cancelled: ['111', '444'] }).cleaned, true);
    // 정리 못 했으면 반전도 안 열린다.
    const cv = closeVerdict({ before: { ok: true, found: false } });
    eq(reversalProgress({
      closeRequested: true, closeAccepted: true, closeVerdict: cv,
      protectionCleaned: cleanupOutcome({ plan, cancelled: ['111'] }).cleaned,
    }).code, 'PROTECTION_NOT_CLEANED');
  });

  console.log('[주문 소유권 — 같은 행동은 같은 id]');

  test('J. 같은 논리적 행동은 언제 불러도 같은 id다', () => {
    const owner = { strategyId: 'my-original-v1', symbol: 'ETHUSDT' };
    const a = ownedClientOrderId({ owner, logicalKey: '2026-08-14', purpose: 'ENTRY' });
    const b = ownedClientOrderId({ owner, logicalKey: '2026-08-14', purpose: 'ENTRY' });
    eq(a, b, '재시도마다 id가 달라지면 그건 멱등이 아니라 중복이다');
    // 목적이 다르면 다른 주문이다.
    assert(a !== ownedClientOrderId({ owner, logicalKey: '2026-08-14', purpose: 'STOP_LOSS' }), a);
    // 날짜가 다르면 다른 거래다.
    assert(a !== ownedClientOrderId({ owner, logicalKey: '2026-08-15', purpose: 'ENTRY' }), a);
  });

  test('J-2. id가 Gate 길이 제한 안에 들어간다 — 잘리면 소유권을 잃는다', () => {
    const id = ownedClientOrderId({
      owner: { strategyId: 'my-original-v1', symbol: 'ETHUSDT' },
      logicalKey: '2026-08-14', purpose: 'STOP_LOSS',
    });
    assert(id.length <= 28, `${id} (${id.length}자)`);
    const p = parseOwnedClientOrderId(`t-${id}`);
    eq(p.ok, true); eq(p.purpose, 'STOP_LOSS'); eq(p.strategyPrefix, 'mo1');
  });

  test('J-3. 잘린 id에서 목적을 짐작하지 않는다', () => {
    eq(parseOwnedClientOrderId('t-mo1-20260814ETHUSD-a1b2c3').ok, false);
    eq(parseOwnedClientOrderId('').ok, false);
    eq(parseOwnedClientOrderId('LD20260101').ok, false);
  });

  test('전략마다 다른 머리글자를 갖는다', () => {
    const seen = new Set(['my-original-v1', 'daily-ladder', 'scalp'].map(strategyPrefixOf));
    eq(seen.size, 3, '머리글자가 겹치면 남의 주문을 내 것으로 읽는다');
  });

  test('내 것 · 남의 것 · 모르는 것을 가른다', () => {
    eq(classifyOrder(MINE, 'my-original-v1').class, 'MINE');
    eq(classifyOrder(FOREIGN, 'my-original-v1').class, 'FOREIGN');
    eq(classifyOrder(NAMELESS, 'my-original-v1').class, 'UNKNOWN');
    eq(classifyOrder(MINE, 'daily-ladder').class, 'FOREIGN');
  });

  console.log('[스모크 cleanup P0 — 실제로 남은 ETHUSDT 2건]');

  // ETHUSDT 스모크가 만든 SL/TP. 진입 id는 `smo-…ETHUSDE0`이고,
  // 실행기가 거기에 'SL'/'TP'를 이어 붙이면 `…E0SL`이 되어 소유권
  // 형식이 깨진다 — 그래서 UNKNOWN이 되고, 안전을 이유로 안 지워졌다.
  const ENTRY_ID = ownedClientOrderId({
    owner: { strategyId: 'smoke-test', symbol: 'ETHUSDT' },
    logicalKey: 'abcdef1234', purpose: 'ENTRY',
  });

  /** Gate `price_orders` 응답 한 줄의 실제 모양 */
  const gatePriceOrder = (id: string, autoSize: string, rule: 1 | 2, price: string, text?: string) => ({
    id,
    user: 12345,
    status: 'open',
    order_type: autoSize === 'close_long' ? 'close-long-order' : 'close-short-order',
    initial: {
      contract: 'ETH_USDT', size: 0, price: '0', tif: 'ioc',
      reduce_only: true, auto_size: autoSize,
      ...(text === undefined ? {} : { text }),
    },
    trigger: { strategy_type: 0, price_type: 1, price, rule },
  });

  test('P0-1. 옛 방식(문자열 이어 붙이기)은 소유권을 잃는다 — 이게 원인이었다', () => {
    eq(parseOwnedClientOrderId(`t-${ENTRY_ID}SL`).ok, false, '이게 통과하면 원인 재현이 안 된 것이다');
    eq(parseOwnedClientOrderId(`t-${ENTRY_ID}TP`).ok, false);
    // 그래서 Gate에 남은 두 줄이 UNKNOWN으로 분류됐다.
    eq(classifyOrder(gatePriceOrder('1', 'close_long', 2, '1870.6', `t-${ENTRY_ID}SL`), 'smoke-test').class,
      'UNKNOWN');
  });

  test('P0-1. 목적 글자를 바꿔 끼우면 왕복이 보장된다', () => {
    const slId = protectiveClientOrderId(ENTRY_ID, 'STOP_LOSS');
    const tpId = protectiveClientOrderId(ENTRY_ID, 'TAKE_PROFIT');
    // 길이가 안 늘어난다 — Gate 28자에서 잘리면 소유권을 잃는다.
    eq(slId.length, ENTRY_ID.length);
    assert(slId.length <= 28, `${slId} (${slId.length}자)`);

    const sp = parseOwnedClientOrderId(`t-${slId}`);
    eq(sp.ok, true); eq(sp.purpose, 'STOP_LOSS'); eq(sp.strategyPrefix, 'smo');
    const tp = parseOwnedClientOrderId(`t-${tpId}`);
    eq(tp.ok, true); eq(tp.purpose, 'TAKE_PROFIT');
    // 진입·손절·익절이 서로 다른 id다.
    eq(new Set([ENTRY_ID, slId, tpId]).size, 3);
  });

  test('P0-1. 형식이 아닌 옛 id는 예전처럼 이어 붙인다 — 기존 호출부를 깨지 않는다', () => {
    eq(protectiveClientOrderId('LD20260814BTC', 'STOP_LOSS'), 'LD20260814BTCSL');
    eq(protectiveClientOrderId('LD20260814BTC', 'TAKE_PROFIT'), 'LD20260814BTCTP');
  });

  test('P0-1. Gate 실제 응답 모양에서 소유권이 읽힌다 (fixture)', () => {
    const slId = protectiveClientOrderId(ENTRY_ID, 'STOP_LOSS');
    const row = gatePriceOrder('444213', 'close_long', 2, '1870.6', `t-${slId}`);
    eq(ownershipTextOf(row), `t-${slId}`);
    const c = classifyOrder(row, 'smoke-test');
    eq(c.class, 'MINE'); eq(c.purpose, 'STOP_LOSS'); eq(c.id, '444213');
  });

  test('P0-1. Gate가 채워 넣는 기본 text를 우리 식별자로 읽지 않는다', () => {
    for (const t of ['api', 'web', 'apiv4', '']) {
      eq(classifyOrder(gatePriceOrder('9', 'close_long', 2, '1870.6', t), 'smoke-test').class, 'UNKNOWN', t);
    }
  });

  test('P0-2. 판별 못 한 주문 2건이 남았는데 PASS로 읽지 않는다', () => {
    // **이것이 거짓 PASS의 정체다.** 예전 판정은 "내 것으로 판별된
    // 개수"만 셌고, 둘 다 UNKNOWN이면 0이 되어 통과로 찍혔다.
    const leftover = [
      gatePriceOrder('1', 'close_long', 2, '1870.6', `t-${ENTRY_ID}SL`),
      gatePriceOrder('2', 'close_long', 1, '1893.2', `t-${ENTRY_ID}TP`),
    ];
    // 옛 판정 방식이 왜 0을 줬는지 그대로 보여 둔다.
    eq(orphanCleanupPlan({
      position: { ok: true, found: false }, orders: leftover, myStrategyId: 'smoke-test',
    }).cancel.length, 0, '옛 방식은 0을 준다 — 그래서 PASS였다');

    // 새 판정은 통과시키지 않는다.
    const rv = residualVerdict({
      position: { ok: true, found: false }, orders: leftover, myStrategyId: 'smoke-test',
    });
    eq(rv.ok, false, '실제 잔여 2건인데 통과로 읽었다');
    eq(rv.code, 'UNKNOWN_PRESENT');
    eq(rv.unknown.length, 2);
  });

  test('P0-2. 걸었던 주문 번호가 아직 있으면 무조건 FAIL이다', () => {
    const leftover = [gatePriceOrder('444213', 'close_long', 2, '1870.6')];
    const rv = residualVerdict({
      position: { ok: true, found: false }, orders: leftover,
      myStrategyId: 'smoke-test', ownedIds: ['444213', '444214'],
    });
    eq(rv.ok, false); eq(rv.code, 'KNOWN_ORDER_PRESENT');
    eq(rv.knownStillPresent.join(','), '444213');
    assert(rv.reason.includes('취소 응답이 성공이어도'), rv.reason);
  });

  test('P0-3. SL/TP 둘 다 취소되고 재조회 0이면 PASS다', () => {
    const rv = residualVerdict({
      position: { ok: true, found: false, qty: 0 }, orders: [],
      myStrategyId: 'smoke-test', ownedIds: ['444213', '444214'],
    });
    eq(rv.ok, true); eq(rv.code, 'CLEAR');
  });

  test('P0-3. 포지션이 0이 아니면 잔여 판정 자체가 통과가 아니다', () => {
    eq(residualVerdict({ position: { ok: true, found: true, qty: 0.01 }, orders: [], myStrategyId: 'smoke-test' }).code,
      'POSITION_NOT_ZERO');
    eq(residualVerdict({ position: { ok: false, found: false }, orders: [], myStrategyId: 'smoke-test' }).code,
      'POSITION_NOT_ZERO');
    eq(residualVerdict({ position: { ok: true, found: false }, orders: null, myStrategyId: 'smoke-test' }).code,
      'ORDERS_UNKNOWN');
  });

  test('P0-2. text가 없어도 저장해 둔 주문 번호로 그 둘만 취소한다', () => {
    const rows = [
      gatePriceOrder('444213', 'close_long', 2, '1870.6'),          // text 없음
      gatePriceOrder('444214', 'close_long', 1, '1893.2'),          // text 없음
      gatePriceOrder('999', 'close_short', 1, '2100', 't-dl-20260814ETHUSDS0'), // 남의 것
    ];
    const plan = orphanCleanupPlan({
      position: { ok: true, found: false }, orders: rows,
      myStrategyId: 'smoke-test', ownedIds: ['444213', '444214'],
    });
    eq(plan.cancel.join(','), '444213,444214', '저장된 번호로도 못 지웠다');
    eq(plan.keep.length, 1);
    eq(plan.keep[0].class, 'FOREIGN', '남의 주문을 지우려 했다');
  });

  test('P0-4. 무관한 주문만 남으면 보존하고 PASS다 — Cancel All을 쓰지 않는다', () => {
    const foreign = [gatePriceOrder('999', 'close_short', 1, '2100', 't-dl-20260814ETHUSDS0')];
    const plan = orphanCleanupPlan({
      position: { ok: true, found: false }, orders: foreign,
      myStrategyId: 'smoke-test', ownedIds: [],
    });
    eq(plan.cancel.length, 0, '남의 손절을 취소 목록에 넣었다');
    const rv = residualVerdict({
      position: { ok: true, found: false }, orders: foreign, myStrategyId: 'smoke-test',
    });
    eq(rv.ok, true); eq(rv.foreign.join(','), '999');
  });

  test('P0-4. 판별 못 한 무관한 주문도 자동으로 지우지 않는다 (FAIL로만 적는다)', () => {
    const unknownRow = [gatePriceOrder('777', 'close_long', 2, '1500')];
    const plan = orphanCleanupPlan({
      position: { ok: true, found: false }, orders: unknownRow,
      myStrategyId: 'smoke-test', ownedIds: [],
    });
    eq(plan.cancel.length, 0, 'UNKNOWN을 취소했다 — Cancel All과 같아진다');
    const rv = residualVerdict({
      position: { ok: true, found: false }, orders: unknownRow, myStrategyId: 'smoke-test',
    });
    eq(rv.ok, false); eq(rv.code, 'UNKNOWN_PRESENT');
    assert(rv.reason.includes('자동으로 지우지도 않습니다'), rv.reason);
  });

  console.log('[같은 종목 다중 전략 — L]');

  const SCHED = (over: any = {}) => ({
    symbol: 'BTCUSDT', connection_id: 'conn-1', strategy_id: 'daily-ladder', enabled: true, ...over,
  });

  test('L. daily-ladder와 my-original-v1이 같은 종목에 동시 ON이면 BLOCK_CONFLICT', () => {
    const v = symbolOwnershipConflict({
      rows: [SCHED(), SCHED({ strategy_id: 'my-original-v1' })],
      myStrategyId: 'my-original-v1', symbol: 'BTCUSDT', connectionId: 'conn-1',
    });
    eq(v.ok, false); eq(v.code, 'BLOCK_CONFLICT');
    eq(v.others.join(','), 'daily-ladder');
  });

  test('L-2. 지금 DB 상태(둘 다 꺼짐)에서는 충돌이 아니다', () => {
    // 사용자가 Supabase에서 직접 껐다. 꺼진 예약은 겹치는 것이 아니다.
    const v = symbolOwnershipConflict({
      rows: [SCHED({ enabled: false }), SCHED({ strategy_id: 'my-original-v1', enabled: false })],
      myStrategyId: 'my-original-v1', symbol: 'BTCUSDT', connectionId: 'conn-1',
    });
    eq(v.ok, true); eq(v.code, 'CLEAR');
  });

  test('L-3. enabled가 true가 아닌 값은 켜진 것이 아니다', () => {
    const v = symbolOwnershipConflict({
      rows: [SCHED({ enabled: 'true' })],
      myStrategyId: 'my-original-v1', symbol: 'BTCUSDT', connectionId: 'conn-1',
    });
    eq(v.ok, true);
  });

  test('L-4. 연결이 다르면 계좌가 다르다 — 겹치지 않는다', () => {
    const v = symbolOwnershipConflict({
      rows: [SCHED({ connection_id: 'conn-2' })],
      myStrategyId: 'my-original-v1', symbol: 'BTCUSDT', connectionId: 'conn-1',
    });
    eq(v.ok, true);
  });

  test('L-5. 예약을 못 읽으면 통과가 아니다', () => {
    const v = symbolOwnershipConflict({ rows: null, myStrategyId: 'x', symbol: 'BTCUSDT' });
    eq(v.ok, false); eq(v.code, 'SCHEDULES_UNKNOWN');
  });

  console.log('[실제 체결가 기준 보호주문 — F]');

  test('F. 판단 참고가가 아니라 실제 체결가에서 SL/TP를 만든다', () => {
    // 참고가 3000, 실제 체결 3006(+0.2% 미끄러짐).
    const basis = fillBasis({ avgPrice: 3006, filledQty: 0.33, settled: true });
    eq(basis.ok, true);
    const e = exitFromFill({
      side: 'LONG', basis, stopPct: 0.4, takeProfitPct: 0.8,
      tickSize: 0.01, referencePrice: 3000,
    });
    eq(e.ok, true);
    eq(e.basisPrice, 3006, '참고가로 계산했다');
    // 3006 × 0.996 = 2993.976 → LONG 손절은 내림 → 2993.97
    eq(e.stop, 2993.97);
    // 3006 × 1.008 = 3030.048 → LONG 익절은 올림 → 3030.05
    eq(e.takeProfit, 3030.05);
    eq(e.slippagePct, 0.2);
  });

  test('F-2. 체결가를 못 읽으면 참고가로 대신하지 않는다', () => {
    for (const bad of [null, 0, '', undefined, NaN]) {
      const b = fillBasis({ avgPrice: bad, filledQty: 1, settled: true });
      eq(b.ok, false, String(bad));
      eq(exitFromFill({ side: 'LONG', basis: b, stopPct: 0.4 }).ok, false, String(bad));
    }
  });

  test('F-3. 체결 수량 0이나 미확정에서는 보호주문 가격을 만들지 않는다', () => {
    eq(fillBasis({ avgPrice: 3000, filledQty: 0, settled: true }).code, 'NO_FILL_QTY');
    eq(fillBasis({ avgPrice: 3000, filledQty: 1, settled: false }).code, 'NOT_SETTLED');
  });

  test('F-4. SHORT는 부호가 반대다 — 한 곳에서만 정한다', () => {
    const basis = fillBasis({ avgPrice: 3006, filledQty: 1, settled: true });
    const e = exitFromFill({ side: 'SHORT', basis, stopPct: 0.4, takeProfitPct: 0.8, tickSize: 0.01 });
    assert(e.stop! > 3006, `SHORT 손절이 위에 있어야 한다 (${e.stop})`);
    assert(e.takeProfit! < 3006, `SHORT 익절이 아래에 있어야 한다 (${e.takeProfit})`);
  });

  test('F-5. 호가 단위 보정은 불리한 쪽으로 민다', () => {
    // 손절은 멀어지는 쪽(늦게 터짐), 익절도 멀어지는 쪽(늦게 체결).
    eq(roundTrigger(2993.976, 'LONG', 'STOP', 0.01).price, 2993.97);
    eq(roundTrigger(3030.042, 'LONG', 'TAKE_PROFIT', 0.01).price, 3030.05);
    eq(roundTrigger(3018.024, 'SHORT', 'STOP', 0.01).price, 3018.03);
    eq(roundTrigger(2981.952, 'SHORT', 'TAKE_PROFIT', 0.01).price, 2981.95);
    // 이미 격자에 맞으면 밀지 않는다.
    eq(roundTrigger(3000.01, 'LONG', 'STOP', 0.01).price, 3000.01);
  });

  console.log('[보호주문 되읽기 — G · H]');

  const priceOrder = (id: string, autoSize: string, rule: 1 | 2, price: string, text?: string) => ({
    id, order_type: autoSize === 'close_long' ? 'close-long-order' : 'close-short-order',
    initial: { auto_size: autoSize, reduce_only: true, size: 0, ...(text ? { text } : {}) },
    trigger: { rule, price },
  });

  test('G. Gate SL을 걸고 나서 되읽기로 확인한다', () => {
    // LONG 손절 = close_long + rule 2
    const r = readbackProtective({
      orders: [priceOrder('1', 'close_long', 2, '2993.97')],
      positionSide: 'LONG', expectedStop: 2993.97,
    });
    eq(r.stop.found, true); eq(r.stop.orderId, '1'); eq(r.stop.triggerPrice, 2993.97);
  });

  test('H. Gate TP를 걸고 나서 되읽기로 확인한다', () => {
    // LONG 익절 = close_long + rule 1
    const r = readbackProtective({
      orders: [
        priceOrder('1', 'close_long', 2, '2993.97'),
        priceOrder('2', 'close_long', 1, '3030.05'),
      ],
      positionSide: 'LONG', expectedStop: 2993.97, expectedTakeProfit: 3030.05,
    });
    eq(r.stop.found, true);
    eq(r.takeProfit.found, true); eq(r.takeProfit.orderId, '2');
  });

  test('되읽기 실패를 "0건"으로 읽지 않는다', () => {
    const r = readbackProtective({ orders: null, positionSide: 'LONG', error: 'timeout' });
    eq(r.readOk, false);
    eq(r.stop.readOk, false); eq(r.stop.found, false);
    assert(r.reason.includes('0건과 다릅니다'), r.reason);
  });

  test('반대 포지션을 닫는 주문을 내 보호주문으로 세지 않는다', () => {
    const r = readbackProtective({
      orders: [priceOrder('9', 'close_short', 1, '3100')],
      positionSide: 'LONG',
    });
    eq(r.stop.found, false);
    eq(r.otherCount, 1);
  });

  test('트리거 가격이 다르면 내가 건 그 주문이 아니다', () => {
    const r = readbackProtective({
      orders: [priceOrder('1', 'close_long', 2, '2500')],
      positionSide: 'LONG', expectedStop: 2993.97,
    });
    eq(r.stop.found, false);
    // 한 틱 차이는 허용한다 — 호가 단위 보정으로 생긴다.
    eq(triggerMatches(2993.96, 2993.97), true);
    eq(triggerMatches(2500, 2993.97), false);
  });

  test('바이낸스 모양도 같은 판정으로 읽는다 — 거래소마다 갈리지 않게', () => {
    const r = readbackProtective({
      venue: 'binance', positionSide: 'LONG',
      orders: [
        { orderId: 77, type: 'STOP_MARKET', side: 'SELL', closePosition: true, stopPrice: '2993.97' },
        { orderId: 88, type: 'TAKE_PROFIT_MARKET', side: 'SELL', reduceOnly: true, stopPrice: '3030.05' },
        // 신규 진입 예약 — 보호주문이 아니다. 손절로 세면 없는 방어선이 생긴다.
        { orderId: 99, type: 'STOP_MARKET', side: 'BUY', stopPrice: '3100' },
      ],
      expectedStop: 2993.97, expectedTakeProfit: 3030.05,
    });
    eq(r.stop.found, true); eq(r.stop.orderId, '77');
    eq(r.takeProfit.found, true); eq(r.takeProfit.orderId, '88');
    eq(r.otherCount, 1);
  });

  console.log('[ENTERED 판정 — I]');

  const FULL = {
    expectedSide: 'LONG' as const, settled: true, filledQty: 0.33, avgPrice: 3006,
    position: { ok: true, found: true, qty: 0.33, side: 'LONG' as const, error: null },
    leverageConfirmed: true, positionModeConfirmed: true,
    stop: FOUND(2993.97, 'LONG'), takeProfit: FOUND(3030.05, 'LONG'),
    takeProfitRequired: true,
  };

  test('증거가 전부 있을 때만 ENTERED다', () => {
    const v = enteredVerdict(FULL);
    eq(v.entered, true); eq(v.code, 'ENTERED');
    eq(outcomeOf(v), 'ENTERED');
  });

  test('I. 손절만 있고 익절이 필수인데 없으면 ENTERED가 아니다', () => {
    const v = enteredVerdict({ ...FULL, takeProfit: NOT_FOUND });
    eq(v.entered, false, 'TP 없이 진입 성공으로 적혔다');
    eq(v.code, 'ENTERED_UNPROTECTED');
    eq(outcomeOf(v), 'UNPROTECTED');
    assert(v.retryable === false, '보호 없는 포지션 위에서 재시도를 열었다');
  });

  test('I-2. 익절이 필수가 아니면 없어도 ENTERED다', () => {
    const v = enteredVerdict({ ...FULL, takeProfit: NOT_FOUND, takeProfitRequired: false });
    eq(v.entered, true);
  });

  test('exec.ok만으로는 ENTERED가 되지 않는다 — 되읽기가 없으면 UNKNOWN', () => {
    const v = enteredVerdict({
      ...FULL, position: { ok: false, found: false, qty: null, side: null },
      stop: READ_FAILED, takeProfit: READ_FAILED,
    });
    eq(v.entered, false); eq(v.code, 'UNKNOWN');
    eq(v.retryable, false, 'UNKNOWN에서 재시도를 열면 중복 진입이 된다');
    eq(outcomeOf(v), 'RECONCILE_REQUIRED');
  });

  test('방향이 어긋나면 ENTERED가 아니다', () => {
    const v = enteredVerdict({
      ...FULL, position: { ok: true, found: true, qty: 0.33, side: 'SHORT', error: null },
    });
    eq(v.entered, false);
    assert(v.missing.some(m => m.includes('방향 불일치')), v.missing.join(','));
  });

  test('체결 0 + 재조회 포지션 없음은 확실히 "안 들어갔다"다', () => {
    const v = enteredVerdict({
      ...FULL, filledQty: 0,
      position: { ok: true, found: false, qty: 0, side: null, error: null },
      stop: NOT_FOUND, takeProfit: NOT_FOUND,
    });
    eq(v.code, 'NOT_ENTERED');
    eq(v.retryable, true, '확실히 안 들어갔으면 다시 볼 수 있어야 한다');
  });

  test('배율·포지션 모드를 확인 못 하면 ENTERED가 아니다', () => {
    eq(enteredVerdict({ ...FULL, leverageConfirmed: null }).entered, false);
    eq(enteredVerdict({ ...FULL, positionModeConfirmed: null }).entered, false);
  });

  console.log('[멱등성 — K · M]');

  test('K. HTTP timeout 뒤 재시도해도 같은 id라 진입은 1회다', () => {
    const owner = { strategyId: 'my-original-v1', symbol: 'ETHUSDT' };
    const ids = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt++) {
      ids.add(ownedClientOrderId({ owner, logicalKey: '2026-08-14', purpose: 'ENTRY' }));
    }
    eq(ids.size, 1, '재시도마다 새 id가 나가면 그만큼 주문이 중복된다');
  });

  test('M. Worker와 GitHub이 동시에 깨워도 같은 id다 — 진입 최대 1회', () => {
    const owner = { strategyId: 'my-original-v1', symbol: 'BTCUSDT' };
    const fromWorker = ownedClientOrderId({ owner, logicalKey: '2026-08-14', purpose: 'ENTRY' });
    const fromGithub = ownedClientOrderId({ owner, logicalKey: '2026-08-14', purpose: 'ENTRY' });
    eq(fromWorker, fromGithub);
    // 그리고 UNKNOWN 상태에서는 애초에 재시도가 안 열린다(위 테스트).
    eq(enteredVerdict({
      ...FULL, settled: null, position: { ok: false, found: false, qty: null, side: null },
      stop: READ_FAILED,
    }).retryable, false);
  });

  console.log('[청산은 진입 관문에 걸리지 않는다 — N]');

  test('N. 신규진입이 막힌 상태에서도 reduceOnly 청산은 막지 않는다', () => {
    // 못 여는 것은 불편이고 못 닫는 것은 사고다.
    const blocked = entryGate({ read: UNREADABLE, desiredSide: 'LONG' });
    eq(blocked.ok, false);
    // 청산 판정은 진입 관문을 읽지 않는다 — closeEvidence만 본다.
    const cv = closeVerdict({
      before: { ok: true, found: true, amount: 0.002 },
      order: { attempted: true, ok: true },
      after: { ok: true, found: false, amount: 0 },
    });
    eq(cv.closed, true, '진입이 막혔다고 청산까지 막혔다');
  });
}
