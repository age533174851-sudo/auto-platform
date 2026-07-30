// src/lib/engine/preTradeChecklist.test.ts
//
// 이 테스트가 지키는 것 하나: **확인하지 못한 것이 통과로 새지 않는가.**
//
// 빨간 X는 사용자가 본다. 확인 못 한 항목을 초록으로 그리는 것은 아무도
// 못 본다 — 그래서 그쪽을 더 많이 적었다.

import { test, eq, assert } from '../../test/harness';
import {
  runChecklist, checkClockSkew, checkMarginIsolated, checkLiquidationDistance,
  CHECK_SPECS, type ChecklistInput, type CheckId,
} from './preTradeChecklist';

/** 전부 통과하는 입력 */
function goodInput(): ChecklistInput {
  return {
    mode: { disposition: 'SEND', reason: '실전 소액' },
    clock: { localMs: 1_000_000, serverMs: 1_000_050 },
    reconcile: { reachable: true, blockNewOrders: false, summary: '일치' },
    unresolvedOrderCount: 0,
    marginType: 'ISOLATED',
    leverage: { actual: 10, intended: 10 },
    existingPositionQty: 0,
    todayEntry: { alreadyTraded: false },
    stopPrice: 60000,
    liquidationPrice: 58000,
    side: 'LONG',
    margin: { required: 100, available: 500 },
  };
}

function statusOf(v: ReturnType<typeof runChecklist>, id: CheckId) {
  return v.results.find(r => r.id === id)!;
}

export function runPreTradeChecklistTests() {
  console.log('[거래 전 점검 — 시계 오차]');

  test('오차가 작으면 통과', () => {
    const r = checkClockSkew(1_000_000, 1_000_100);
    eq(r.status, 'pass');
    eq(r.blocks, false);
  });

  test('recvWindow의 60%를 넘으면 막는다 — 경계에 붙은 값은 실제로 매번 실패한다', () => {
    // recvWindow 5000 → 허용 3000ms
    eq(checkClockSkew(1_000_000, 1_000_000 - 2_900).status, 'pass');
    eq(checkClockSkew(1_000_000, 1_000_000 - 3_100).status, 'fail');
  });

  test('앞서든 뒤처지든 막는다', () => {
    const ahead = checkClockSkew(1_010_000, 1_000_000);
    const behind = checkClockSkew(1_000_000, 1_010_000);
    eq(ahead.status, 'fail');
    eq(behind.status, 'fail');
    assert(ahead.detail.includes('앞서'), `방향을 적어야 한다: ${ahead.detail}`);
    assert(behind.detail.includes('뒤처져'), `방향을 적어야 한다: ${behind.detail}`);
  });

  test('-1021을 미리 알려준다 — 주문 뒤에 알면 원인을 못 찾는다', () => {
    assert(checkClockSkew(1_010_000, 1_000_000).detail.includes('-1021'), '거절 코드를 적어야 한다');
  });

  test('서버 시각을 못 읽으면 unknown이고 막는다', () => {
    const r = checkClockSkew(1_000_000, null);
    eq(r.status, 'unknown');
    eq(r.blocks, true, '모르는 채로 주문하면 안 된다');
  });

  test('숫자가 아니면 unknown', () => {
    eq(checkClockSkew(NaN, 1_000_000).status, 'unknown');
    eq(checkClockSkew(1_000_000, Infinity).status, 'unknown');
  });

  console.log('[거래 전 점검 — 마진 모드]');

  test('ISOLATED면 통과 (대소문자 무시)', () => {
    eq(checkMarginIsolated('ISOLATED').status, 'pass');
    eq(checkMarginIsolated('isolated').status, 'pass');
  });

  test('CROSS면 막는다 — 한 종목 손실이 계좌 전체로 번진다', () => {
    const r = checkMarginIsolated('cross');
    eq(r.status, 'fail');
    eq(r.blocks, true);
  });

  test('못 읽었으면 unknown이고 막는다 — 기본값을 isolated로 두면 조회 실패가 통과가 된다', () => {
    eq(checkMarginIsolated(null).status, 'unknown');
    eq(checkMarginIsolated(undefined).status, 'unknown');
    eq(checkMarginIsolated('').status, 'unknown');
    eq(checkMarginIsolated('   ').status, 'unknown');
    eq(checkMarginIsolated(null).blocks, true);
  });

  console.log('[거래 전 점검 — 청산 거리]');

  test('LONG은 손절이 청산보다 위여야 한다', () => {
    eq(checkLiquidationDistance({ side: 'LONG', stopPrice: 60000, liquidationPrice: 58000 }).status, 'pass');
    eq(checkLiquidationDistance({ side: 'LONG', stopPrice: 58000, liquidationPrice: 60000 }).status, 'fail');
  });

  test('SHORT은 반대다 — 부호를 잘못 보면 가장 위험한 주문이 통과한다', () => {
    eq(checkLiquidationDistance({ side: 'SHORT', stopPrice: 60000, liquidationPrice: 62000 }).status, 'pass');
    eq(checkLiquidationDistance({ side: 'SHORT', stopPrice: 62000, liquidationPrice: 60000 }).status, 'fail');
  });

  test('청산이 먼저면 손절은 작동할 기회가 없다는 것을 말한다', () => {
    const r = checkLiquidationDistance({ side: 'LONG', stopPrice: 58000, liquidationPrice: 60000 });
    assert(r.detail.includes('청산이 먼저'), `이유를 적어야 한다: ${r.detail}`);
    eq(r.blocks, true);
  });

  test('통과할 때도 여유를 숫자로 적는다', () => {
    const r = checkLiquidationDistance({ side: 'LONG', stopPrice: 60000, liquidationPrice: 58000 });
    assert(/여유 3\.\d+%/.test(r.detail), `여유를 적어야 한다: ${r.detail}`);
  });

  test('값이 없으면 unknown이고 막는다', () => {
    eq(checkLiquidationDistance({ side: 'LONG', stopPrice: null, liquidationPrice: 58000 }).status, 'unknown');
    eq(checkLiquidationDistance({ side: null, stopPrice: 60000, liquidationPrice: 58000 }).status, 'unknown');
    eq(checkLiquidationDistance({ side: 'LONG', stopPrice: 0, liquidationPrice: 58000 }).status, 'unknown');
    eq(checkLiquidationDistance({ side: 'LONG', stopPrice: 60000, liquidationPrice: null }).blocks, true);
  });

  console.log('[거래 전 점검 — 전체 판정]');

  test('전부 통과하면 주문을 허용한다', () => {
    const v = runChecklist(goodInput());
    eq(v.allowed, true, `막혔다: ${v.summary}`);
    eq(v.blockers.length, 0);
    eq(v.unknownCount, 0);
    eq(v.passed, v.total);
  });

  test('빈 입력은 전부 막는다 — 아무것도 확인하지 않은 것이 통과가 되면 안 된다', () => {
    const v = runChecklist({});
    eq(v.allowed, false);
    assert(v.unknownCount > 0, '확인 못 한 항목이 있어야 한다');
    assert(v.blockers.length > 0, '막는 항목이 있어야 한다');
  });

  test('검사 항목 수가 목록과 같다 — 하나 빠뜨리면 조용히 안 돌아간다', () => {
    eq(runChecklist(goodInput()).total, CHECK_SPECS.length);
  });

  test('모드가 BLOCK이면 막는다', () => {
    const v = runChecklist({ ...goodInput(), mode: { disposition: 'BLOCK', reason: 'UI 데모' } });
    eq(v.allowed, false);
    eq(statusOf(v, 'MODE').status, 'fail');
  });

  test('Shadow Live는 warn — 통과로만 적으면 주문이 나갔다고 믿는다', () => {
    const v = runChecklist({ ...goodInput(), mode: { disposition: 'RECORD', reason: '섀도우 기록' } });
    const m = statusOf(v, 'MODE');
    eq(m.status, 'warn');
    eq(m.blocks, false, '기록 모드는 정상 동작이라 막지 않는다');
    assert(m.detail.includes('보내지 않습니다'), `보내지 않는다는 것을 적어야 한다: ${m.detail}`);
    eq(v.allowed, true);
  });

  test('상태 대조에서 거래소를 못 읽으면 unknown이고 막는다', () => {
    const v = runChecklist({
      ...goodInput(),
      reconcile: { reachable: false, blockNewOrders: false, summary: '조회 실패' },
    });
    eq(statusOf(v, 'STATE_RECONCILE').status, 'unknown');
    eq(v.allowed, false, '조회 실패가 일치로 읽히면 안 된다');
  });

  test('심각한 불일치는 막는다', () => {
    const v = runChecklist({
      ...goodInput(),
      reconcile: { reachable: true, blockNewOrders: true, summary: '포지션 방향 불일치' },
    });
    eq(v.allowed, false);
    eq(statusOf(v, 'STATE_RECONCILE').status, 'fail');
  });

  test('미확정 주문이 있으면 막는다', () => {
    const v = runChecklist({ ...goodInput(), unresolvedOrderCount: 2 });
    eq(v.allowed, false);
    assert(statusOf(v, 'UNRESOLVED_ORDERS').detail.includes('2건'), '건수를 적어야 한다');
  });

  test('미확정 주문 수를 모르면 막는다 — 0으로 가정하면 중복 체결이 열린다', () => {
    const v = runChecklist({ ...goodInput(), unresolvedOrderCount: null });
    eq(statusOf(v, 'UNRESOLVED_ORDERS').status, 'unknown');
    eq(v.allowed, false);
  });

  test('손절이 없으면 막는다 — 손절 없는 주문은 크기를 정당화할 근거가 없다', () => {
    const v = runChecklist({ ...goodInput(), stopPrice: null });
    eq(v.allowed, false);
    eq(statusOf(v, 'STOP_ATTACHED').status, 'fail');
  });

  test('손절가가 0이나 음수면 막는다', () => {
    eq(runChecklist({ ...goodInput(), stopPrice: 0 }).allowed, false);
    eq(runChecklist({ ...goodInput(), stopPrice: -5 }).allowed, false);
  });

  test('증거금이 부족하면 막는다', () => {
    const v = runChecklist({ ...goodInput(), margin: { required: 600, available: 500 } });
    eq(v.allowed, false);
    eq(statusOf(v, 'MARGIN_SUFFICIENT').status, 'fail');
  });

  test('증거금이 딱 맞으면 통과한다', () => {
    eq(runChecklist({ ...goodInput(), margin: { required: 500, available: 500 } }).allowed, true);
  });

  test('오늘 이미 진입했으면 막는다', () => {
    const v = runChecklist({ ...goodInput(), todayEntry: { alreadyTraded: true } });
    eq(v.allowed, false);
    eq(statusOf(v, 'TODAY_ENTRY').status, 'fail');
  });

  test('오늘 진입 이력을 모르는 것은 막지 않는다 — 마진 모드를 모르는 것과 무게가 다르다', () => {
    const v = runChecklist({ ...goodInput(), todayEntry: null });
    eq(statusOf(v, 'TODAY_ENTRY').status, 'unknown');
    eq(statusOf(v, 'TODAY_ENTRY').blocks, false);
    eq(v.allowed, true);
  });

  console.log('[거래 전 점검 — 막지 않는 항목]');

  test('배율이 달라도 막지 않지만 알린다', () => {
    const v = runChecklist({ ...goodInput(), leverage: { actual: 100, intended: 10 } });
    const l = statusOf(v, 'LEVERAGE');
    eq(l.status, 'warn');
    eq(l.blocks, false);
    assert(l.detail.includes('100') && l.detail.includes('10'), '두 값을 다 적어야 한다');
    eq(v.allowed, true);
  });

  test('기존 포지션이 있어도 막지 않는다 — 추가 진입이 잘못이라고 단정할 수 없다', () => {
    const v = runChecklist({ ...goodInput(), existingPositionQty: 0.5 });
    const p = statusOf(v, 'EXISTING_POSITION');
    eq(p.status, 'warn');
    eq(p.blocks, false);
    eq(v.allowed, true);
  });

  test('막을 것과 알릴 것이 섞이지 않는다 — 섞으면 사용자는 전부 무시한다', () => {
    for (const spec of CHECK_SPECS) {
      if (!spec.blocking) {
        eq(spec.requiredToKnow, false,
          `${spec.id}: 막지 않는 항목인데 모르면 막는다 — 기준이 엇갈린다`);
      }
    }
  });

  console.log('[거래 전 점검 — 요약 문구]');

  test('막는 항목이 있으면 이름을 나열한다', () => {
    const v = runChecklist({ ...goodInput(), marginType: 'cross', stopPrice: null });
    assert(v.summary.includes('마진 모드'), `막는 항목을 적어야 한다: ${v.summary}`);
    assert(v.summary.includes('손절'), `막는 항목을 적어야 한다: ${v.summary}`);
  });

  test('통과했지만 확인 못 한 항목이 있으면 그 수를 적는다', () => {
    const v = runChecklist({ ...goodInput(), leverage: null, existingPositionQty: null });
    eq(v.allowed, true);
    eq(v.unknownCount, 2);
    assert(v.summary.includes('확인 못 한 항목 2개'),
      `"9/11 통과"만 적으면 실패인지 확인 불가인지 알 수 없다: ${v.summary}`);
  });

  test('전부 통과했으면 군더더기를 붙이지 않는다', () => {
    const v = runChecklist(goodInput());
    assert(!v.summary.includes('확인 못 한'), `깔끔해야 한다: ${v.summary}`);
  });

  test('모든 결과에 이유가 붙어 있다 — 통과할 때도 근거를 적는다', () => {
    for (const r of runChecklist(goodInput()).results) {
      assert(!!r.detail && r.detail.length > 0, `${r.id}에 이유가 없다`);
    }
  });

  test('항목 id가 중복되지 않는다', () => {
    const ids = CHECK_SPECS.map(s => s.id);
    eq(new Set(ids).size, ids.length);
  });
}
