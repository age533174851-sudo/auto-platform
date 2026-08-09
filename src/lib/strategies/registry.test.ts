// src/lib/strategies/registry.test.ts
//
// **"켰는데 아무 일도 안 일어난다"를 막는다.**
//
// 이 저장소에서 가장 자주 난 고장이 만들어 놓고 배선 안 함이다. 전략
// 목록은 그 고장이 가장 잘 숨는 자리다 — 이름이 그럴듯하면 사용자는
// 켰다고 믿고, 주문 경로가 없다는 사실은 어디에도 안 나온다.
//
// 그래서 이 파일은 두 가지를 값으로 못 박는다:
//   · 목록에 있는 것은 **실제로 주문 경로가 있다**
//   · 모르는 id·연구 전용·버전 불일치는 **실행되지 않는다**

import { test, eq, assert } from '../../test/harness';
import {
  STRATEGIES, runnableStrategies, resolveStrategy, strategyIdOfRow, LEGACY_STRATEGY_ID,
} from './registry';
import { outcomeOf, runStrategy, evaluationKey } from './runStrategy';

export function runStrategyRegistryTests() {
  console.log('[전략 목록 — 켤 수 있는 것만 켤 수 있다고 적는다]');

  test('실행 가능하다고 적힌 전략은 실행 경로가 있다', () => {
    for (const s of STRATEGIES) {
      if (!s.executionReady) continue;
      assert(!!s.route, `${s.id}가 실행 가능인데 route가 없다`);
      assert(s.route!.startsWith('/api/'), `${s.id}의 route가 서버 경로가 아니다: ${s.route}`);
    }
  });

  test('연구 전용은 실행 경로를 갖지 않는다 — 있으면 실행 가능으로 적어야 한다', () => {
    for (const s of STRATEGIES) {
      if (s.executionReady) continue;
      eq(s.route, null, `${s.id}가 연구 전용인데 route가 있다`);
    }
  });

  test('실전 허용은 테스트넷 허용을 전제로 한다', () => {
    // 테스트넷에서 못 돌리는 것을 실전에서 돌리는 순서는 없다.
    for (const s of STRATEGIES) {
      if (s.liveReady) assert(s.testnetReady, `${s.id}가 실전만 허용돼 있다`);
    }
  });

  test('모든 전략에 필수 칸이 채워져 있다', () => {
    for (const s of STRATEGIES) {
      assert(!!s.id && !!s.name && !!s.version, `${s.id}에 빈 칸이 있다`);
      assert(s.supportedMarkets.length > 0, `${s.id}에 시장이 없다`);
      assert(s.supportedIntervals.length > 0, `${s.id}에 주기가 없다`);
      assert(s.description.length > 10, `${s.id}의 설명이 너무 짧다`);
    }
  });

  test('id가 겹치지 않는다', () => {
    eq(new Set(STRATEGIES.map(s => s.id)).size, STRATEGIES.length);
  });

  console.log('[전략 목록 — 환경별로 고를 수 있는 것]');

  test('테스트넷 목록과 실전 목록이 다르다', () => {
    const t = runnableStrategies('TESTNET').map(s => s.id);
    const l = runnableStrategies('LIVE').map(s => s.id);
    assert(t.includes('daily-ladder'), '지금 도는 전략이 테스트넷 목록에 없다');
    assert(l.includes('daily-ladder'), '지금 도는 전략이 실전 목록에 없다');
    // 분봉 돌파는 스케줄된 적이 없어 실전을 닫아 뒀다.
    assert(t.includes('scalp'), '분봉 돌파가 테스트넷 목록에 없다');
    assert(!l.includes('scalp'), '실행 이력이 없는 전략이 실전 목록에 있다');
  });

  console.log('[전략 판정 — 모르면 실행하지 않는다]');

  test('모르는 id는 기본 전략으로 떨어지지 않는다', () => {
    for (const id of ['', null, undefined, 'nope', 'DAILY-LADDER ', 'edgeSweep']) {
      const r = resolveStrategy({ id, env: 'TESTNET' });
      eq(r.ok, false, `${JSON.stringify(id)}가 통과했다`);
      eq(r.code, 'UNKNOWN_STRATEGY');
      eq(r.spec, null);
    }
  });

  test('실전에서 안 여는 전략은 실전에서 막는다', () => {
    const r = resolveStrategy({ id: 'scalp', env: 'LIVE' });
    eq(r.ok, false); eq(r.code, 'ENV_NOT_READY');
    assert(r.spec != null, '막아도 어떤 전략이었는지는 알려 줘야 한다');
  });

  test('테스트넷에서는 통과한다', () => {
    eq(resolveStrategy({ id: 'scalp', env: 'TESTNET' }).ok, true);
    eq(resolveStrategy({ id: 'daily-ladder', env: 'TESTNET' }).ok, true);
  });

  test('버전이 다르면 임의로 최신을 돌리지 않는다', () => {
    const r = resolveStrategy({ id: 'daily-ladder', version: '0', env: 'TESTNET' });
    eq(r.ok, false); eq(r.code, 'VERSION_MISMATCH');
    assert(r.message.includes('다시 저장'), r.message);
  });

  test('버전이 안 적혀 있으면 지금 버전으로 본다 — 옛 예약을 막지 않는다', () => {
    for (const v of [null, undefined, '']) {
      eq(resolveStrategy({ id: 'daily-ladder', version: v, env: 'TESTNET' }).ok, true,
        `version=${JSON.stringify(v)}가 막혔다`);
    }
  });

  test('지원하지 않는 주기는 막는다', () => {
    const r = resolveStrategy({ id: 'daily-ladder', env: 'TESTNET', intervalMin: 3 });
    eq(r.ok, false); eq(r.code, 'INTERVAL_UNSUPPORTED');
    // 무엇이 가능한지 같이 알려 준다.
    assert(r.message.includes('가능'), r.message);
  });

  test('주기를 안 주면 검사하지 않는다', () => {
    eq(resolveStrategy({ id: 'daily-ladder', env: 'TESTNET' }).ok, true);
  });

  console.log('[옛 예약 이관]');

  test('strategy_id가 없는 줄은 계단식으로 본다 — 그 줄을 읽던 실행기가 그것뿐이었다', () => {
    eq(strategyIdOfRow({}), LEGACY_STRATEGY_ID);
    eq(strategyIdOfRow({ strategy_id: null }), LEGACY_STRATEGY_ID);
    eq(strategyIdOfRow(null), LEGACY_STRATEGY_ID);
    // 모르는 값도 옛 줄로 본다 — 여기서 실행을 막는 것은 resolveStrategy의 일이다.
    eq(strategyIdOfRow({ strategy_id: 'nope' }), LEGACY_STRATEGY_ID);
  });

  test('적혀 있으면 그대로 읽는다', () => {
    eq(strategyIdOfRow({ strategy_id: 'scalp' }), 'scalp');
  });

  console.log('[평가 결과 — 관망은 실패가 아니다]');

  test('조건이 안 맞으면 NO_SIGNAL이다', () => {
    const r = outcomeOf({ httpOk: true, body: { ok: true, executed: false } });
    eq(r.outcome, 'NO_SIGNAL');
    assert(!r.summary.includes('실패'), `실패처럼 보이면 안 된다: ${r.summary}`);
  });

  test('주문이 나갔으면 ENTERED다', () => {
    eq(outcomeOf({ httpOk: true, body: { ok: true, executed: true } }).outcome, 'ENTERED');
    eq(outcomeOf({ httpOk: true, body: { ok: true, orderId: '5' } }).outcome, 'ENTERED');
  });

  test('점검 목록이 막았으면 BLOCKED다 — FAILED가 아니다', () => {
    const r = outcomeOf({ httpOk: true, body: {
      ok: false, checklist: { allowed: false, blockers: ['포지션 모드', '배율 확인'] },
    } });
    eq(r.outcome, 'BLOCKED');
    assert(r.summary.includes('포지션 모드'), r.summary);
  });

  test('checklist.allowed가 undefined면 막힌 것이 아니다 — 안 돈 것이다', () => {
    // undefined를 false로 읽으면 평가가 안 돌았을 때 '차단됨'으로 뜬다.
    eq(outcomeOf({ httpOk: true, body: { ok: true, checklist: {} } }).outcome, 'NO_SIGNAL');
  });

  test('실행기가 죽으면 FAILED다', () => {
    const r = outcomeOf({ httpOk: false, status: 500, body: { error: 'boom' } });
    eq(r.outcome, 'FAILED');
  });

  test('HTTP 실패라도 관문이 준 이유가 있으면 BLOCKED다', () => {
    const r = outcomeOf({ httpOk: false, status: 400, body: {
      ok: false, checklist: { allowed: false }, message: '배율 확인 실패',
    } });
    eq(r.outcome, 'BLOCKED');
    eq(r.summary, '배율 확인 실패');
  });

  console.log('[실행 입구 — 실행기까지 가기 전에 막는다]');

  const ctx = {
    symbol: 'BTCUSDT', connectionId: 'c1', mode: 'TESTNET', env: 'TESTNET' as const,
  };

  test('모르는 전략은 실행기를 부르지 않는다', async () => {
    let called = 0;
    const r = await runStrategy('nope', '1', ctx, {
      call: async () => { called++; return { httpOk: true, body: {} }; },
    });
    eq(called, 0, '모르는 전략인데 실행기를 불렀다');
    eq(r.outcome, 'BLOCKED');
  });

  test('버전이 다르면 실행기를 부르지 않는다', async () => {
    let called = 0;
    const r = await runStrategy('daily-ladder', '99', ctx, {
      call: async () => { called++; return { httpOk: true, body: {} }; },
    });
    eq(called, 0);
    eq(r.outcome, 'BLOCKED');
    assert(r.summary.includes('v99'), r.summary);
  });

  test('고른 전략의 경로로 보낸다 — 선택이 실행까지 그대로 간다', async () => {
    const seen: string[] = [];
    await runStrategy('scalp', '1', ctx, {
      call: async (route) => { seen.push(route); return { httpOk: true, body: { ok: true } }; },
    });
    eq(seen.length, 1);
    eq(seen[0], '/api/autotrade/scalp', '다른 전략의 실행기로 갔다');

    const seen2: string[] = [];
    await runStrategy('daily-ladder', '1', ctx, {
      call: async (route) => { seen2.push(route); return { httpOk: true, body: { ok: true } }; },
    });
    eq(seen2[0], '/api/autotrade/daily-ladder');
  });

  test('실행기가 던지면 FAILED로 남기고 삼키지 않는다', async () => {
    const r = await runStrategy('daily-ladder', '1', ctx, {
      call: async () => { throw new Error('연결 끊김'); },
    });
    eq(r.outcome, 'FAILED');
    assert(r.summary.includes('연결 끊김'), r.summary);
  });

  console.log('[멱등 키 — 같은 평가가 두 번 돌지 않는다]');

  test('같은 예약의 첫 평가는 같은 키다', () => {
    const a = evaluationKey({ userId: 'u', strategyId: 'daily-ladder', symbol: 'BTCUSDT', connectionId: 'c1', slot: 'first' });
    const b = evaluationKey({ userId: 'u', strategyId: 'daily-ladder', symbol: 'BTCUSDT', connectionId: 'c1', slot: 'first' });
    eq(a, b, '두 번 누르면 다른 키가 된다 — 평가가 두 번 돈다');
  });

  test('전략·종목·계좌가 다르면 다른 키다', () => {
    const base = { userId: 'u', strategyId: 'daily-ladder', symbol: 'BTCUSDT', connectionId: 'c1', slot: 'first' };
    const keys = new Set([
      evaluationKey(base),
      evaluationKey({ ...base, strategyId: 'scalp' }),
      evaluationKey({ ...base, symbol: 'ETHUSDT' }),
      evaluationKey({ ...base, connectionId: 'c2' }),
      evaluationKey({ ...base, userId: 'u2' }),
    ]);
    eq(keys.size, 5, '서로 다른 예약이 같은 키를 쓴다');
  });
}
