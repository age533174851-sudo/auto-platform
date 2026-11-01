// src/lib/smoke/smokeEnv.test.ts
//
// **스모크 진단이 실계좌를 조회하면 안 된다 (#552 추가 감사).**
//
// `/api/autotrade/smoke-test/orphans`는 자격증명을 읽은 직후 포지션·조건부
// 주문을 조회했다. 실전 연결을 넘기면 주문은 못 내더라도 **signed 조회가
// 이미 나간다.** `startAttempt.ts:77-81`에는 그 관문이 있었고 이 경로에는
// 없었다 — 같은 판단이 한 곳에만 있던 자리다.

import { test, eq, assert } from '../../test/harness';
import { smokeEnvGate } from './smokeEnv';

export function runSmokeEnvTests() {
  console.log('[스모크 환경 관문 — 조회도 테스트넷에서만]');

  test('테스트넷 연결만 통과한다', () => {
    const v = smokeEnvGate({ testnet: true });
    eq(v.ok, true); eq(v.code, 'TESTNET');
  });

  test('실전 연결은 조회도 막는다', () => {
    const v = smokeEnvGate({ testnet: false });
    eq(v.ok, false); eq(v.code, 'TESTNET_ONLY'); eq(v.status, 403);
    assert(v.message.includes('조회도'), v.message);
  });

  test('모르는 값은 통과가 아니다 — true가 아니면 전부 막는다', () => {
    // `startAttempt`와 같은 기준이다: `testnet !== true`면 막는다.
    for (const bad of [undefined, null, 0, 1, '', 'true', 'TESTNET', {}, []]) {
      const v = smokeEnvGate({ testnet: bad } as any);
      eq(v.ok, false, `testnet=${String(bad)}`);
      eq(v.code, 'TESTNET_ONLY', `testnet=${String(bad)}`);
    }
    eq(smokeEnvGate(null).ok, false);
    eq(smokeEnvGate(undefined).ok, false);
    eq(smokeEnvGate({} as any).ok, false);
  });
}
