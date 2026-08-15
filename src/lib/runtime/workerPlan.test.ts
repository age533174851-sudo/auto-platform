// src/lib/runtime/workerPlan.test.ts
//
// **"켜져 있다"를 "돌고 있다"로 읽으면 그날이 사라진다.**
//
// 2026-08-13에 실제로 그랬다. 예약은 enabled=true였고 화면은 아무것도
// 이상하다고 말하지 않았는데, 워커에 폴링 코드가 배포되지 않아 아무도
// 그 예약을 보지 않았다. 판단 창을 133분 놓쳤다.

import { test, eq, assert } from '../../test/harness';
import { workerPlan, workerAlive, deploymentVerdict, runtimeSkew } from './workerPlan';
import { WORKER_STALE_MS } from '../autotrade/evaluationLoop';

const NOW = 1_800_000_000_000;
const D = (over: any = {}) => ({
  id: 's1', symbol: 'BTCUSDT', strategyId: 'my-original-v1',
  enabled: true, connectionId: 'c1', mode: 'TESTNET', ...over,
});
const O = (over: any = {}) => ({ id: 's1', state: 'WATCHING' as const, lastRunAtMs: NOW - 60_000, source: 'FLY_WORKER', ...over });

export function runWorkerPlanTests() {
  console.log('[워커 계획 — 켜짐과 돌고 있음은 다르다]');

  test('켠 것이 없으면 고장이 아니다', () => {
    const p = workerPlan({ nowMs: NOW, desired: [D({ enabled: false })], observed: [], workerLastSeenMs: null });
    eq(p.code, 'IDLE'); eq(p.healthy, true);
    assert(p.reason.includes('고장이 아닙니다'), p.reason);
  });

  test('enabled가 true가 아닌 값은 켜진 것이 아니다', () => {
    eq(workerPlan({ nowMs: NOW, desired: [D({ enabled: 'true' })], observed: [], workerLastSeenMs: NOW }).code, 'IDLE');
  });

  test('워커가 안 오면 켜져 있어도 정상이 아니다 — 8/13에 난 일', () => {
    const p = workerPlan({
      nowMs: NOW, desired: [D()], observed: [O()],
      workerLastSeenMs: NOW - WORKER_STALE_MS - 1,
    });
    eq(p.code, 'WORKER_DOWN'); eq(p.healthy, false);
    eq(p.needsAttention.length, 1);
    assert(p.reason.includes('아무도 평가하지 않습니다'), p.reason);
  });

  test('워커 상태를 못 읽었으면 정상이라고 말하지 않는다', () => {
    const p = workerPlan({ nowMs: NOW, desired: [D()], observed: [O()], workerLastSeenMs: null });
    eq(p.code, 'WORKER_UNKNOWN'); eq(p.healthy, false);
    assert(p.reason.includes('확인하지 못한 것은 정상이 아닙니다'), p.reason);
  });

  test('워커가 살아 있고 전부 감시 중이면 정상이다', () => {
    const p = workerPlan({ nowMs: NOW, desired: [D()], observed: [O()], workerLastSeenMs: NOW - 30_000 });
    eq(p.code, 'HEALTHY'); eq(p.healthy, true);
    eq(p.observedRunning, 1); eq(p.desiredOn, 1);
  });

  test('관측이 없는 예약을 정상으로 세지 않는다', () => {
    // 켜져 있는데 그 줄의 상태를 아무도 못 읽었다 — 초록으로 그리면 안 된다.
    const p = workerPlan({ nowMs: NOW, desired: [D()], observed: [], workerLastSeenMs: NOW });
    eq(p.healthy, false);
    eq(p.needsAttention[0].state, 'UNKNOWN');
  });

  test('막힌 줄이 있으면 사람이 손봐야 한다고 말한다', () => {
    const p = workerPlan({
      nowMs: NOW, desired: [D(), D({ id: 's2', symbol: 'ETHUSDT' })],
      observed: [O(), O({ id: 's2', state: 'BLOCKED' })],
      workerLastSeenMs: NOW,
    });
    eq(p.code, 'BLOCKED'); eq(p.healthy, false);
    eq(p.observedRunning, 1);
    assert(p.reason.includes('ETHUSDT'), p.reason);
  });

  test('밀린 줄은 경고다 — 막힌 것과 구분한다', () => {
    const p = workerPlan({
      nowMs: NOW, desired: [D()], observed: [O({ state: 'STALE' })], workerLastSeenMs: NOW,
    });
    eq(p.code, 'STALE'); eq(p.healthy, false);
  });

  test('꺼진 줄은 확인 필요로 세지 않는다', () => {
    const p = workerPlan({
      nowMs: NOW, desired: [D(), D({ id: 's2', enabled: false })],
      observed: [O(), O({ id: 's2', state: 'OFF' })], workerLastSeenMs: NOW,
    });
    eq(p.code, 'HEALTHY');
  });

  console.log('[워커 계획 — 심장박동]');

  test('유예 안이면 살아 있다', () => {
    eq(workerAlive(NOW, NOW - WORKER_STALE_MS + 1), true);
    eq(workerAlive(NOW, NOW - WORKER_STALE_MS - 1), false);
  });

  test('못 읽으면 죽었다고도 살았다고도 하지 않는다', () => {
    for (const bad of [null, undefined, '', 'nope', true]) {
      eq(workerAlive(NOW, bad), null, JSON.stringify(bad));
    }
  });

  console.log('[배포 — 머지됐다고 배포된 것이 아니다]');

  test('셋이 같으면 통과다', () => {
    const v = deploymentVerdict({ mainSha: 'abc123def', vercelSha: 'abc123def', flySha: 'abc123def' });
    eq(v.code, 'MATCHED'); eq(v.matched, true);
  });

  test('짧은 SHA와 긴 SHA를 섞어도 맞게 읽는다', () => {
    eq(deploymentVerdict({ mainSha: 'abc123def4567', vercelSha: 'abc123d', flySha: 'abc123def' }).matched, true);
  });

  test('Fly만 뒤처지면 잡는다 — #124에서 실제로 난 일', () => {
    // fly-deploy가 8/9 이후 한 번도 안 돌아서 워커는 옛 코드로 돌았다.
    const v = deploymentVerdict({ mainSha: 'newsha1', vercelSha: 'newsha1', flySha: 'oldsha9' });
    eq(v.code, 'MISMATCH'); eq(v.matched, false);
    assert(v.reason.includes('Fly'), v.reason);
    assert(v.reason.includes('머지됐다고 배포된 것이 아닙니다'), v.reason);
  });

  test('하나라도 못 읽으면 MATCHED가 아니다', () => {
    // 못 읽은 것을 "같다"로 읽으면 이 검사가 있으나 마나다.
    for (const missing of ['mainSha', 'vercelSha', 'flySha']) {
      const args: any = { mainSha: 'a1', vercelSha: 'a1', flySha: 'a1' };
      args[missing] = null;
      const v = deploymentVerdict(args);
      eq(v.code, 'UNKNOWN', missing);
      eq(v.matched, false, missing);
    }
  });

  console.log('[배포 — 서버는 main을 모른다. 그래도 웹↔워커는 볼 수 있다]');

  test('웹과 워커가 다르면 그 자체로 사고다 — 8/15에 실제로 난 일', () => {
    // Vercel은 #135, Fly는 #127이었다. 이 한 줄만 있었어도 바로 찾았다.
    const v = runtimeSkew({ vercelSha: '6e05d7a1', flySha: '470d8db2' });
    eq(v.code, 'MISMATCH'); eq(v.matched, false);
    assert(v.reason.includes('6e05d7a'), v.reason);
    assert(v.reason.includes('470d8db'), v.reason);
  });

  test('같으면 통과 — 짧은 SHA와 긴 SHA를 섞어도', () => {
    eq(runtimeSkew({ vercelSha: 'abc123def456', flySha: 'abc123d' }).matched, true);
  });

  test('워커가 자기 버전을 안 적었으면 "같다"로 읽지 않는다', () => {
    // 054 이전 배포이거나 GIT_SHA가 안 들어간 이미지다. 둘 다 '모름'이다.
    const v = runtimeSkew({ vercelSha: 'abc1234', flySha: '' });
    eq(v.code, 'UNKNOWN'); eq(v.matched, false);
    assert(v.reason.includes('Fly'), v.reason);
  });
}
