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

  test('USDⓈ-M 진입 + 하루제한이면 전체 목록이 돈다', () => {
    eq(runChecklist(goodInput(), { market: 'USDM', intent: 'ENTRY', dailyLimit: true }).total,
       CHECK_SPECS.length);
  });

  test('기본값은 USDⓈ-M 진입 · 하루제한 없음 — 오늘 진입 항목이 빠진다', () => {
    const v = runChecklist(goodInput());
    eq(v.market, 'USDM');
    eq(v.intent, 'ENTRY');
    eq(v.total, CHECK_SPECS.length - 1);
    assert(!v.results.some(r => r.id === 'TODAY_ENTRY'),
      '수동 주문에는 하루 제한이 없는데 "확인 못 함"으로 남으면 확인할 것이 있다고 읽힌다');
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
    const v = runChecklist({ ...goodInput(), todayEntry: { alreadyTraded: true } },
      { dailyLimit: true });
    eq(v.allowed, false);
    eq(statusOf(v, 'TODAY_ENTRY').status, 'fail');
  });

  test('오늘 진입 이력을 모르는 것은 막지 않는다 — 마진 모드를 모르는 것과 무게가 다르다', () => {
    const v = runChecklist({ ...goodInput(), todayEntry: null }, { dailyLimit: true });
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

  console.log('[거래 전 점검 — 신규 진입 (주문 경로 배선에서 실제로 걸린 것)]');

  test('포지션 없는 신규 진입도 통과할 수 있어야 한다 — 못 하면 전략이 아예 못 돈다', () => {
    // 배선하면서 처음 만든 실패가 이것이었다. getFuturesPositions는 수량 0을
    // 걸러내므로 신규 진입 심볼이 목록에 없고, 그러면 marginType이 unknown이
    // 되어 **모든 첫 주문이 막힌다.** 마진 모드는 포지션이 아니라 심볼별 계좌
    // 설정이라 수량 0에도 존재한다 — getSymbolPositionRisk로 읽는다.
    const v = runChecklist({
      ...goodInput(),
      existingPositionQty: 0,        // 포지션 없음 (사실)
      marginType: 'isolated',        // 심볼 설정은 읽힌다
      liquidationPrice: 58000,       // 거래소에 없으면 계획의 계산값
    });
    eq(v.allowed, true, `신규 진입이 막혔다: ${v.summary}`);
  });

  test('신규 진입인데 마진 모드를 못 읽으면 막는다 — CROSS 계좌의 첫 주문이 그대로 나간다', () => {
    const v = runChecklist({ ...goodInput(), existingPositionQty: 0, marginType: null });
    eq(v.allowed, false);
    eq(statusOf(v, 'MARGIN_ISOLATED').status, 'unknown');
  });

  test('포지션이 없으면 거래소 청산가가 없다 — 계획의 계산값으로 판정한다', () => {
    // 주문 경로는 `risk?.liquidationPrice ?? plan.liquidationPrice`를 넘긴다.
    // 둘 다 없으면 unknown이고 막힌다.
    eq(runChecklist({ ...goodInput(), liquidationPrice: null }).allowed, false);
    eq(runChecklist({ ...goodInput(), liquidationPrice: 58000 }).allowed, true);
  });

  console.log('[거래 전 점검 — 현물 (해당 없는 검사를 빼는가)]');

  /** 현물 주문에는 마진·청산·배율·손절이 아예 없다 */
  function spotInput(): ChecklistInput {
    return {
      mode: { disposition: 'SEND', reason: '현물' },
      clock: { localMs: 1_000_000, serverMs: 1_000_050 },
      margin: { required: 100, available: 500 },
      // 아래는 현물에 존재하지 않아 넘기지 않는다
      // marginType, liquidationPrice, stopPrice, leverage, reconcile …
    };
  }

  test('현물 주문이 통과한다 — 선물 검사를 그대로 물리면 전부 막힌다', () => {
    const v = runChecklist(spotInput(), { market: 'SPOT' });
    eq(v.allowed, true, `현물이 막혔다: ${v.summary}`);
    eq(v.market, 'SPOT');
  });

  test('현물에는 마진 모드·청산·배율·손절 항목이 아예 없다', () => {
    const ids = runChecklist(spotInput(), { market: 'SPOT' }).results.map(r => r.id);
    for (const gone of ['MARGIN_ISOLATED', 'LIQUIDATION_DISTANCE', 'LEVERAGE',
                        'STOP_ATTACHED', 'EXISTING_POSITION', 'STATE_RECONCILE'] as CheckId[]) {
      assert(!ids.includes(gone), `${gone}이 현물 목록에 있다 — 현물에는 존재하지 않는 개념이다`);
    }
  });

  test('현물은 모드·시계만 본다', () => {
    const v = runChecklist(spotInput(), { market: 'SPOT' });
    eq(v.results.map(r => r.id).sort().join(','), 'CLOCK_SKEW,MODE');
  });

  test('현물에는 자금 항목도 없다 — 시장가는 체결가를 몰라 껍데기 통과가 된다', () => {
    // 시장가+수량 주문은 필요 금액을 계산할 수 없다. 추측해 채우면
    // required:0으로 무조건 통과하는 초록 체크가 생긴다. 현물 자금 부족은
    // 거래소가 주문을 통째로 거부하므로(일부 체결이 없다) 빼는 것이 맞다.
    const ids = runChecklist(spotInput(), { market: 'SPOT' }).results.map(r => r.id);
    assert(!ids.includes('MARGIN_SUFFICIENT'), '현물에 증거금 항목이 있다');
  });

  test('파생에서는 증거금을 본다', () => {
    for (const m of ['USDM', 'COINM'] as const) {
      const ids = runChecklist(goodInput(), { market: m }).results.map(r => r.id);
      assert(ids.includes('MARGIN_SUFFICIENT'), `${m}에 증거금 항목이 없다`);
    }
  });

  test('현물에서 시계가 틀리면 막는다 — 서명 요청은 시장과 무관하다', () => {
    const v = runChecklist({ ...spotInput(), clock: { localMs: 1_010_000, serverMs: 1_000_000 } },
      { market: 'SPOT' });
    eq(v.allowed, false);
  });

  test('해당 없는 검사를 pass로 적지 않는다 — 확인한 것도 사실도 아니다', () => {
    const v = runChecklist(spotInput(), { market: 'SPOT' });
    eq(v.passed, v.total, '현물 목록은 전부 통과여야 한다');
    // 목록 자체가 짧아야 한다. 길이가 USDM과 같으면 뭔가 pass로 채운 것이다
    assert(v.total < runChecklist(goodInput()).total,
      '현물 목록이 선물과 같은 길이다 — 없는 검사를 채웠다는 뜻이다');
  });

  console.log('[거래 전 점검 — COIN-M]');

  test('COIN-M은 마진·배율·증거금을 본다 (현물과 다르다)', () => {
    const ids = runChecklist(goodInput(), { market: 'COINM' }).results.map(r => r.id);
    for (const kept of ['MARGIN_ISOLATED', 'LEVERAGE', 'MARGIN_SUFFICIENT',
                        'EXISTING_POSITION', 'UNRESOLVED_ORDERS'] as CheckId[]) {
      assert(ids.includes(kept), `${kept}이 빠졌다`);
    }
  });

  test('COIN-M에는 손절·청산거리 항목이 없다 — 그 경로가 손절을 붙이지 않는다', () => {
    // 면제가 아니라 아직 못 고친 위험의 표시다. COIN-M에 손절 부착을 넣으면
    // markets에 'COINM'을 더해야 하고, 그때 이 테스트를 뒤집어야 한다.
    // 물려 놓고 보니 COIN-M 주문이 통째로 막혀서 알게 된 것이다.
    const ids = runChecklist(goodInput(), { market: 'COINM' }).results.map(r => r.id);
    assert(!ids.includes('STOP_ATTACHED'), 'COIN-M 주문이 전부 막힌다');
    assert(!ids.includes('LIQUIDATION_DISTANCE'), 'COIN-M 주문이 전부 막힌다');
  });

  test('손절 없는 COIN-M 주문이 통과한다 — 기능이 죽지 않아야 한다', () => {
    const v = runChecklist({
      mode: { disposition: 'SEND', reason: 'COIN-M' },
      clock: { localMs: 1_000_000, serverMs: 1_000_050 },
      unresolvedOrderCount: 0,
      marginType: 'isolated',
      leverage: { actual: 10, intended: 10 },
      existingPositionQty: 0,
      margin: { required: 0.01, available: 0.5 },
      // stopPrice·liquidationPrice 없음 — COIN-M 경로는 손절을 만들지 않는다
    }, { market: 'COINM' });
    eq(v.allowed, true, `COIN-M이 막혔다: ${v.summary}`);
  });

  test('COIN-M에는 상태 대조가 없다 — 대조는 USDⓈ-M 포지션만 읽는다', () => {
    const ids = runChecklist(goodInput(), { market: 'COINM' }).results.map(r => r.id);
    assert(!ids.includes('STATE_RECONCILE'),
      '다른 시장의 상태로 이 시장의 주문을 막으면 안 된다');
  });

  test('COIN-M도 CROSS면 막는다', () => {
    eq(runChecklist({ ...goodInput(), marginType: 'cross' }, { market: 'COINM' }).allowed, false);
  });

  console.log('[거래 전 점검 — 청산 주문 (나갈 수 있는가)]');

  test('청산은 CROSS여도 나갈 수 있어야 한다 — 막으면 나갈 방법이 없어진다', () => {
    const v = runChecklist({ ...goodInput(), marginType: 'cross' }, { intent: 'EXIT' });
    eq(v.allowed, true, `청산이 막혔다: ${v.summary}`);
    eq(v.intent, 'EXIT');
  });

  test('청산에는 손절·청산거리·증거금 검사가 없다 — 청산은 증거금을 돌려준다', () => {
    const ids = runChecklist(goodInput(), { intent: 'EXIT' }).results.map(r => r.id);
    for (const gone of ['STOP_ATTACHED', 'LIQUIDATION_DISTANCE', 'MARGIN_SUFFICIENT',
                        'UNRESOLVED_ORDERS', 'LEVERAGE', 'TODAY_ENTRY'] as CheckId[]) {
      assert(!ids.includes(gone), `${gone}이 청산을 막을 수 있다`);
    }
  });

  test('청산에도 모드·시계·상태대조는 본다', () => {
    const ids = runChecklist(goodInput(), { intent: 'EXIT' }).results.map(r => r.id);
    for (const kept of ['MODE', 'CLOCK_SKEW', 'STATE_RECONCILE'] as CheckId[]) {
      assert(ids.includes(kept), `${kept}이 빠졌다`);
    }
  });

  test('손절 없이도 청산은 나간다 — 나오는 주문에 손절을 요구하면 안 된다', () => {
    eq(runChecklist({ ...goodInput(), stopPrice: null }, { intent: 'EXIT' }).allowed, true);
  });

  test('증거금이 없어도 청산은 나간다', () => {
    eq(runChecklist({ ...goodInput(), margin: { required: 9999, available: 1 } },
      { intent: 'EXIT' }).allowed, true);
  });

  test('청산이어도 모드가 막으면 못 나간다 — 모드는 가장 바깥 관문이다', () => {
    eq(runChecklist({ ...goodInput(), mode: { disposition: 'BLOCK', reason: 'UI 데모' } },
      { intent: 'EXIT' }).allowed, false);
  });

  test('현물 매도(EXIT)도 모드·시계만 본다', () => {
    const v = runChecklist(spotInput(), { market: 'SPOT', intent: 'EXIT' });
    eq(v.allowed, true);
    eq(v.results.map(r => r.id).sort().join(','), 'CLOCK_SKEW,MODE');
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
