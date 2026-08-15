// src/lib/smoke/smokePlan.test.ts
//
// **스모크 테스트가 조용히 초록이 되는 길을 전부 막는다.**
//
// 이 기능의 목적은 "배관이 뚫려 있는가"를 확인하는 것이다. 그래서
// 가장 나쁜 고장은 진입이 실패하는 것이 아니라 **아무것도 확인하지
// 않고 PASS라고 적는 것**이다. 그러면 다음 날 아침 실전 창에서
// 그대로 터진다.

import { test, eq, assert } from '../../test/harness';
import {
  smokeRequestVerdict, stepsOf, smokeVerdict, holdUntilMs, closeDue,
  smokeBlocksStrategy, preflightVerdict,
  STEP_ORDER, HOLD_CHOICES, DEFAULT_HOLD_MIN, MAX_HOLD_MIN, SMOKE_STRATEGY_ID,
  type StepId, type StepState,
} from './smokePlan';

const OK_BODY = {
  symbol: 'ETHUSDT', side: 'LONG', connectionId: 'conn-1', mode: 'TESTNET',
  marginUsd: 10, leverage: 100, holdMin: 10,
};

/** 모든 단계를 한 상태로 채운다 */
const allSteps = (state: StepState, over: Partial<Record<StepId, StepState>> = {}) => {
  const m: any = {};
  for (const id of STEP_ORDER) m[id] = { state: over[id] ?? state, note: '' };
  return stepsOf(m);
};

export function runSmokePlanTests() {
  console.log('[스모크 테스트 — 시작 요청 검사]');

  test('제대로 된 요청은 값으로 확정된다', () => {
    const v = smokeRequestVerdict(OK_BODY);
    eq(v.ok, true); eq(v.code, 'OK');
    eq(v.request!.symbol, 'ETHUSDT'); eq(v.request!.side, 'LONG');
    eq(v.request!.leverage, 100, '배율을 조용히 낮췄다');
  });

  test('실전에서는 열리지 않는다', () => {
    for (const m of ['LIVE_SMALL', 'LIVE_LIMITED', 'SHADOW_LIVE', 'PAPER']) {
      const v = smokeRequestVerdict({ ...OK_BODY, mode: m });
      eq(v.ok, false, m); eq(v.code, 'NOT_TESTNET', m);
    }
  });

  test('아무 종목이나 열지 않는다', () => {
    eq(smokeRequestVerdict({ ...OK_BODY, symbol: 'DOGEUSDT' }).code, 'BAD_SYMBOL');
    eq(smokeRequestVerdict({ ...OK_BODY, symbol: '' }).code, 'BAD_SYMBOL');
  });

  test('방향·증거금·배율·유지시간을 모르는 값으로 받지 않는다', () => {
    eq(smokeRequestVerdict({ ...OK_BODY, side: 'BUY' }).code, 'BAD_SIDE');
    eq(smokeRequestVerdict({ ...OK_BODY, marginUsd: 0 }).code, 'BAD_MARGIN');
    eq(smokeRequestVerdict({ ...OK_BODY, marginUsd: null }).code, 'BAD_MARGIN');
    eq(smokeRequestVerdict({ ...OK_BODY, leverage: 200 }).code, 'BAD_LEVERAGE');
    eq(smokeRequestVerdict({ ...OK_BODY, leverage: 1.5 }).code, 'BAD_LEVERAGE');
    eq(smokeRequestVerdict({ ...OK_BODY, holdMin: 60 }).code, 'BAD_HOLD');
    eq(smokeRequestVerdict({ ...OK_BODY, connectionId: '' }).code, 'NO_CONNECTION');
  });

  test('유지 시간을 안 주면 기본 10분이다', () => {
    const v = smokeRequestVerdict({ ...OK_BODY, holdMin: undefined });
    eq(v.ok, true); eq(v.request!.holdMin, DEFAULT_HOLD_MIN);
  });

  test('고를 수 있는 유지 시간은 1·5·10·30분이다', () => {
    eq(HOLD_CHOICES.join(','), '1,5,10,30');
    for (const m of HOLD_CHOICES) eq(smokeRequestVerdict({ ...OK_BODY, holdMin: m }).ok, true, String(m));
    // 상한이 있어야 워커가 죽었을 때의 노출이 묶인다.
    eq(MAX_HOLD_MIN, 30);
  });

  console.log('[스모크 테스트 — 사전 확인: 남의 것을 덮지 않는다]');

  test('기존 포지션이 있으면 시작하지 않는다 — 자동으로 덮지 않는다', () => {
    const v = preflightVerdict({ position: { ok: true, found: true, qty: 0.01 }, orders: [] });
    eq(v.ok, false); eq(v.code, 'POSITION_OPEN');
    assert(v.reason.includes('덮거나 청산하지 않습니다'), v.reason);
  });

  test('조건부 주문이 남아 있으면 시작하지 않는다', () => {
    const v = preflightVerdict({ position: { ok: true, found: false }, orders: [{ id: '1' }] });
    eq(v.ok, false); eq(v.code, 'ORDERS_OPEN');
    assert(v.reason.includes('대신 지우지 않습니다'), v.reason);
  });

  test('조회 실패를 "깨끗함"으로 읽지 않는다', () => {
    eq(preflightVerdict({ position: { ok: false, found: false }, orders: [] }).code, 'UNKNOWN');
    eq(preflightVerdict({ position: { ok: true, found: false }, orders: null }).code, 'UNKNOWN');
    eq(preflightVerdict({ position: null, orders: [] }).code, 'UNKNOWN');
  });

  test('둘 다 0일 때만 시작한다', () => {
    const v = preflightVerdict({ position: { ok: true, found: false, qty: 0 }, orders: [] });
    eq(v.ok, true); eq(v.code, 'CLEAR');
  });

  console.log('[스모크 테스트 — 최종 판정]');

  test('전부 통과해야 PASS다', () => {
    const v = smokeVerdict(allSteps('PASS'));
    eq(v.code, 'PASS'); eq(v.pass, true);
    eq(v.passed, v.total);
  });

  test('기록이 없는 단계는 PENDING이지 PASS가 아니다', () => {
    // 아무것도 안 한 테스트가 초록으로 보이면 안 된다.
    const v = smokeVerdict(stepsOf({}));
    eq(v.pass, false); eq(v.code, 'RUNNING'); eq(v.passed, 0);
  });

  test('하나라도 FAIL이면 나머지가 초록이어도 FAIL이다', () => {
    const v = smokeVerdict(allSteps('PASS', { ORDERS_ZERO: 'FAIL' }));
    eq(v.code, 'FAIL'); eq(v.pass, false);
    assert(v.reason.includes('잔여 보호주문 0'), v.reason);
  });

  test('테스트가 끝났는데 고아 주문이 남으면 FAIL이다', () => {
    // 어제 Gate에 조건부 주문 4개가 쌓인 그 자리다. 남은 주문은
    // 다음 진입을 친다 — "청산 성공"으로 끝내면 안 된다.
    const v = smokeVerdict(allSteps('PASS', { ORDERS_ZERO: 'FAIL' }));
    eq(v.pass, false);
  });

  test('확인하지 못한 단계가 있으면 PASS가 아니다', () => {
    const v = smokeVerdict(allSteps('PASS', { POSITION_ZERO: 'UNKNOWN' }));
    eq(v.code, 'UNKNOWN'); eq(v.pass, false);
    assert(v.reason.includes('통과로 적지 않습니다'), v.reason);
  });

  test('SL은 붙었는데 TP가 없으면 PASS가 아니다', () => {
    const v = smokeVerdict(allSteps('PASS', { TAKE_PROFIT: 'FAIL' }));
    eq(v.pass, false);
  });

  test('사전 확인에서 막히면 BLOCKED다', () => {
    const v = smokeVerdict(allSteps('PENDING', { PREFLIGHT: 'FAIL' }), 'BLOCKED');
    eq(v.code, 'BLOCKED'); eq(v.pass, false);
  });

  test('모르는 상태 값을 PASS로 눕히지 않는다', () => {
    const s = stepsOf({ ENTRY: { state: 'ㅇㅋ' }, FILL: { state: true }, STOP: {} });
    for (const x of s) eq(x.state, 'PENDING', x.id);
  });

  console.log('[스모크 테스트 — 유지 시간]');

  const NOW = 1_800_000_000_000;

  test('마감 시각은 시작 + 유지 시간이다', () => {
    eq(holdUntilMs(NOW, 10), NOW + 600_000);
    eq(holdUntilMs(NOW, 1), NOW + 60_000);
  });

  test('상한을 넘는 유지 시간은 마감 시각을 만들지 않는다', () => {
    eq(holdUntilMs(NOW, 120), null);
    eq(holdUntilMs(NOW, 0), null);
    eq(holdUntilMs(NOW, -5), null);
  });

  test('마감 전에는 닫지 않는다', () => {
    const v = closeDue({ nowMs: NOW, state: 'HOLDING', holdUntil: new Date(NOW + 300_000).toISOString() });
    eq(v.due, false); eq(v.code, 'WAITING'); eq(v.remainingMs, 300_000);
  });

  test('마감이 지나면 닫는다', () => {
    const v = closeDue({ nowMs: NOW, state: 'HOLDING', holdUntil: new Date(NOW - 1_000).toISOString() });
    eq(v.due, true); eq(v.code, 'DUE');
  });

  test('마감 시각을 못 읽으면 "지금"으로 보지 않는다 — 방금 연 포지션이 바로 닫힌다', () => {
    for (const bad of [null, undefined, '', 'nope', {}]) {
      const v = closeDue({ nowMs: NOW, state: 'HOLDING', holdUntil: bad });
      eq(v.due, false, JSON.stringify(bad));
      eq(v.code, 'NO_DEADLINE', JSON.stringify(bad));
    }
  });

  test('유지 중이 아닌 테스트는 닫지 않는다', () => {
    for (const st of ['PASS', 'FAIL', 'ENTERING', 'BLOCKED', '']) {
      eq(closeDue({ nowMs: NOW, state: st, holdUntil: NOW - 1 }).code, 'NOT_HOLDING', st);
    }
  });

  console.log('[스모크 테스트 — 전략과 섞이지 않는다]');

  test('스모크 거래의 소유 전략은 실제 전략이 아니다', () => {
    eq(SMOKE_STRATEGY_ID, 'smoke-test');
    // registry의 어떤 전략 id와도 같으면 안 된다 — 같으면 그 전략의
    // 승률·손익에 사람이 고른 방향의 10분 왕복이 섞인다.
    for (const real of ['my-original-v1', 'daily-ladder', 'scalp']) {
      assert(SMOKE_STRATEGY_ID !== real, `스모크가 ${real}로 기록된다`);
    }
  });

  test('스모크가 도는 동안 같은 종목 전략 진입을 막는다', () => {
    const rows = [{ state: 'HOLDING', symbol: 'BTCUSDT', connection_id: 'conn-1' }];
    const v = smokeBlocksStrategy({ rows, symbol: 'BTCUSDT', connectionId: 'conn-1' });
    eq(v.blocked, true); eq(v.code, 'SMOKE_RUNNING');
  });

  test('끝난 스모크는 막지 않는다', () => {
    for (const st of ['PASS', 'FAIL', 'BLOCKED']) {
      const v = smokeBlocksStrategy({
        rows: [{ state: st, symbol: 'BTCUSDT', connection_id: 'conn-1' }],
        symbol: 'BTCUSDT', connectionId: 'conn-1',
      });
      eq(v.blocked, false, st);
    }
  });

  test('진입 중·청산 중도 진행 중이다', () => {
    for (const st of ['ENTERING', 'HOLDING', 'CLOSING']) {
      eq(smokeBlocksStrategy({
        rows: [{ state: st, symbol: 'ETHUSDT', connection_id: 'c' }],
        symbol: 'ETHUSDT', connectionId: 'c',
      }).blocked, true, st);
    }
  });

  test('다른 종목·다른 연결은 막지 않는다', () => {
    const rows = [{ state: 'HOLDING', symbol: 'BTCUSDT', connection_id: 'conn-1' }];
    eq(smokeBlocksStrategy({ rows, symbol: 'ETHUSDT', connectionId: 'conn-1' }).blocked, false);
    eq(smokeBlocksStrategy({ rows, symbol: 'BTCUSDT', connectionId: 'conn-2' }).blocked, false);
  });

  test('스모크 목록을 못 읽으면 통과가 아니다', () => {
    const v = smokeBlocksStrategy({ rows: null, symbol: 'BTCUSDT' });
    eq(v.blocked, true); eq(v.code, 'SMOKE_UNKNOWN');
  });

  console.log('[스모크 테스트 — 화면이 그릴 것]');

  test('단계 순서가 실제 실행 순서와 같다', () => {
    // 화면이 위에서 아래로 읽히려면 이 순서가 실행 순서여야 한다.
    eq(STEP_ORDER.join(' → '),
      'PREFLIGHT → ENTRY → FILL → STOP → TAKE_PROFIT → HOLD → CLOSE → POSITION_ZERO → ORDERS_ZERO → RECONCILE');
  });

  test('모든 단계에 한국어 이름이 있다', () => {
    for (const s of stepsOf({})) assert(s.label.length > 0, `${s.id}에 이름이 없다`);
  });
}
