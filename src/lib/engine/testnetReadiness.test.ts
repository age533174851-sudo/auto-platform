// src/lib/engine/testnetReadiness.test.ts
//
// 막으려는 것:
//  1. **확인하지 못한 것을 통과로 치는 것.** `undefined`를 PASS로 읽으면
//     "아직 안 만든 것"이 전부 초록으로 뜨고, 이 관문은 아무것도 막지
//     못한다 — 관문을 무력화하는 가장 쉬운 방법이다
//  2. 브라우저 타이머로 도는 것을 준비됨으로 보는 것 — 앱을 닫으면
//     손절 감시도 같이 멈추고, 자는 동안 포지션만 남는다
//  3. 100배를 요구했는데 거래소가 75배만 허용할 때 몰래 75배로 내는 것
//  4. 테스트넷 충전을 수익으로 세는 것 — 세 번 파산하고 세 번 충전한
//     계좌가 수익 난 것처럼 보인다
//  5. 미확정 주문이 남은 채로 새 주문을 얹는 것
import { test, assert, eq, close } from '../../test/harness';
import {
  readinessChecks, readinessVerdict, testnetPnlOf,
  READINESS_ITEMS, WORKER_STALE_MS, DAY_ONE_STRATEGIES, DAY_ONE_NOTE,
  type ReadinessInput,
} from './testnetReadiness';

const NOW = 1_700_000_000_000;

/** 전부 통과하는 입력 한 벌 */
const ALL_OK: ReadinessInput = {
  connectionId: 'conn-gate-testnet-0383', isTestnet: true,
  marketDataFresh: true, balanceRead: true,
  unresolvedOrders: 0, mismatchCount: 0,
  positionModeKnown: true,
  intendedLeverage: 20, venueLeverage: 20, venueMaxLeverage: 100,
  riskPolicyFromServer: true,
  workerIndependent: true, workerHeartbeatAtMs: NOW - 5_000,
  idempotencyWired: true, protectiveStopConfirmed: true,
  unifiedLedger: true, nowMs: NOW,
};

export function runTestnetReadinessTests() {
  console.log('[테스트넷 준비 — 확인 못 한 것은 통과가 아니다]');

  test('아무것도 안 주면 하나도 통과하지 않는다', () => {
    // undefined를 통과로 읽으면 이 관문은 아무것도 막지 못한다.
    const v = readinessVerdict({});
    eq(v.ready, false);
    eq(v.passed.length, 0);
    assert(v.blocked.length + v.unknown.length === READINESS_ITEMS.length,
      `${v.blocked.length}+${v.unknown.length} vs ${READINESS_ITEMS.length}`);
  });

  test('입력이 null이어도 안 터지고 막는다', () => {
    eq(readinessVerdict(null).ready, false);
  });

  test('전부 통과하면 시작할 수 있다', () => {
    const v = readinessVerdict(ALL_OK);
    eq(v.ready, true);
    eq(v.blocked.length, 0);
    eq(v.unknown.length, 0);
    assert(v.headline.includes('시작할 수 있습니다'), v.headline);
  });

  test('하나만 확인 불가여도 시작하지 않는다', () => {
    const v = readinessVerdict({ ...ALL_OK, positionModeKnown: null });
    eq(v.ready, false);
    assert(v.headline.includes('확인 불가 1개'), v.headline);
  });

  test('막힌 것마다 무엇이 필요한지 적는다', () => {
    const v = readinessVerdict({});
    for (const s of v.nextSteps) assert(s.length > 10, s);
    assert(v.nextSteps.length > 0, '할 일이 있어야 한다');
  });

  console.log('[테스트넷 준비 — 브라우저 타이머는 준비됨이 아니다]');

  test('브라우저에서 도는 것을 준비됨으로 보지 않는다', () => {
    const c = readinessChecks({ ...ALL_OK, workerIndependent: false })
      .find(x => x.id === 'worker')!;
    eq(c.status, 'BLOCK');
    assert(c.needed.includes('자고 있는 동안'), c.needed);
    assert(c.needed.includes('runtime_jobs'), c.needed);
  });

  test('실행기 심장박동이 오래됐으면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, workerHeartbeatAtMs: NOW - WORKER_STALE_MS - 1 })
      .find(x => x.id === 'worker')!;
    eq(c.status, 'BLOCK');
    assert(c.detail.includes('응답 없음'), c.detail);
  });

  test('심장박동을 못 읽으면 RUNNING이라고 하지 않는다', () => {
    const c = readinessChecks({ ...ALL_OK, workerHeartbeatAtMs: null })
      .find(x => x.id === 'worker')!;
    eq(c.status, 'UNKNOWN');
  });

  console.log('[테스트넷 준비 — 레버리지를 몰래 낮추지 않는다]');

  test('거래소 최대보다 크면 막고 이유를 적는다', () => {
    // 100배를 요구했는데 거래소가 75배만 허용하면 75배로 조용히
    // 내는 것이 아니라 막는다.
    const c = readinessChecks({ ...ALL_OK, intendedLeverage: 100, venueLeverage: 100, venueMaxLeverage: 75 })
      .find(x => x.id === 'leverage')!;
    eq(c.status, 'BLOCK');
    assert(c.detail.includes('요구 100배'), c.detail);
    assert(c.detail.includes('최대 75배'), c.detail);
    assert(c.needed.includes('몰래 낮춰 내지 않습니다'), c.needed);
    assert(c.needed.includes('주문 직전에 다시 조회'), c.needed);
  });

  test('100배도 거래소가 허용하면 통과다', () => {
    // 테스트넷 고배율 연구를 막지 않는다.
    const c = readinessChecks({ ...ALL_OK, intendedLeverage: 100, venueLeverage: 100, venueMaxLeverage: 125 })
      .find(x => x.id === 'leverage')!;
    eq(c.status, 'PASS');
    assert(c.detail.includes('100배'), c.detail);
  });

  test('의도와 거래소가 다르면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, intendedLeverage: 20, venueLeverage: 5 })
      .find(x => x.id === 'leverage')!;
    eq(c.status, 'BLOCK');
    assert(c.detail.includes('20배 ≠ 거래소 5배'), c.detail);
  });

  test('0배는 계획 없음이다', () => {
    const c = readinessChecks({ ...ALL_OK, intendedLeverage: 0 })
      .find(x => x.id === 'leverage')!;
    eq(c.status, 'UNKNOWN');
    assert(c.needed.includes('0배는 배율이 아니라'), c.needed);
  });

  console.log('[테스트넷 준비 — 미확정 0건이어야 한다]');

  test('미확정이 남아 있으면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, unresolvedOrders: 4, mismatchCount: 0 })
      .find(x => x.id === 'reconcile')!;
    eq(c.status, 'BLOCK');
    assert(c.needed.includes('두 번 삽니다'), c.needed);
  });

  test('불일치가 남아 있으면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, unresolvedOrders: 0, mismatchCount: 2 })
      .find(x => x.id === 'reconcile')!;
    eq(c.status, 'BLOCK');
  });

  test('세지 못했으면 0으로 치지 않는다', () => {
    const c = readinessChecks({ ...ALL_OK, unresolvedOrders: null })
      .find(x => x.id === 'reconcile')!;
    eq(c.status, 'UNKNOWN');
  });

  console.log('[테스트넷 준비 — 그 밖의 관문]');

  test('실전 연결로 테스트넷을 시작하지 않는다', () => {
    const c = readinessChecks({ ...ALL_OK, isTestnet: false }).find(x => x.id === 'connection')!;
    eq(c.status, 'BLOCK');
    assert(c.needed.includes('실제 돈이 나갑니다'), c.needed);
  });

  test('위험 설정이 브라우저에만 있으면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, riskPolicyFromServer: false })
      .find(x => x.id === 'riskPolicy')!;
    eq(c.status, 'BLOCK');
    assert(c.needed.includes('예전 값으로 주문'), c.needed);
  });

  test('중복 방지가 없으면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, idempotencyWired: false })
      .find(x => x.id === 'idempotency')!;
    eq(c.status, 'BLOCK');
    assert(c.needed.includes('두 번 나갑니다'), c.needed);
  });

  test('손절 부착을 확인 못 했으면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, protectiveStopConfirmed: false })
      .find(x => x.id === 'protectiveOrders')!;
    eq(c.status, 'BLOCK');
    assert(c.needed.includes('체결 접수를 완료로 보면'), c.needed);
  });

  test('장부가 갈려 있으면 막는다', () => {
    const c = readinessChecks({ ...ALL_OK, unifiedLedger: false }).find(x => x.id === 'ledger')!;
    eq(c.status, 'BLOCK');
  });

  test('시세가 끊기면 막는다', () => {
    eq(readinessChecks({ ...ALL_OK, marketDataFresh: false }).find(x => x.id === 'marketData')!.status, 'BLOCK');
  });

  console.log('[테스트넷 — 충전은 수익이 아니다]');

  test('세 번 파산하고 충전한 계좌를 수익으로 읽지 않는다', () => {
    // 초기 50,000 + 충전 100,000 = 누적 150,000. 현재 132,000.
    // 마지막 잔고가 처음보다 많다고 "수익"이라고 읽으면 100배 전략이
    // 살아남은 것처럼 보인다. 실제로는 세 번 터졌다.
    const p = testnetPnlOf(50_000, [50_000, 30_000, 20_000], 132_000);
    close(p.totalInjected!, 150_000, 1e-9);
    close(p.strategyPnl!, -18_000, 1e-9);
    assert(p.strategyPnl! < 0, '전략은 손실이다');
    assert(p.note.includes('충전은 수익이 아니므로'), p.note);
  });

  test('충전이 없으면 군말이 없다', () => {
    const p = testnetPnlOf(50_000, [], 55_000);
    close(p.strategyPnl!, 5_000, 1e-9);
    eq(p.note, '');
  });

  test('충전 하나를 못 읽으면 손익을 내지 않는다', () => {
    // 충전을 못 세면 파산한 계좌가 수익 난 것처럼 보인다.
    const p = testnetPnlOf(50_000, [50_000, null], 132_000);
    eq(p.strategyPnl, null);
    assert(p.note.includes('파산한 계좌가 수익 난 것처럼'), p.note);
  });

  test('초기자금을 모르면 손익을 내지 않는다', () => {
    eq(testnetPnlOf(null, [], 100).strategyPnl, null);
  });

  console.log('[테스트넷 — 첫날은 5개만]');

  test('첫날 전략이 다섯 개다', () => {
    // 스무 개를 한꺼번에 켜면 오류가 나도 어느 전략 때문인지 못 찾는다.
    eq(DAY_ONE_STRATEGIES.length, 5);
    assert(DAY_ONE_NOTE.includes('수익률이 아니라'), DAY_ONE_NOTE);
    assert(DAY_ONE_NOTE.includes('reconcile'), DAY_ONE_NOTE);
  });
}
