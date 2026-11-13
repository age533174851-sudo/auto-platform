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

  // ── 아는 것을 "모름"으로 적지 않는다 ──
  //
  // `UNKNOWN을 0으로 적지 않는다`의 쌍둥이다. 셋 중 하나를 못 읽었다고
  // 해서 **이미 확정된 어긋남**까지 모름으로 덮으면, 읽는 사람은 사고가
  // 난 날에도 "확인되지 않았습니다"만 본다.
  //
  // 2026-11-13 운영 실측이 정확히 그 모양이었다:
  //
  //   skew    MISMATCH  "웹은 220f800, 워커는 4f6ee8c — 다른 코드를 돌리고 있습니다"
  //   verdict UNKNOWN   "main 버전을 읽지 못했습니다 — 같은 코드가 도는지 확인되지 않았습니다"
  //
  // 서버는 main 을 모르지만, 웹과 워커가 **다르다는 것은 확인했다.**
  // 둘이 다르면 `main = Vercel = Fly` 는 main 이 무엇이든 성립할 수
  // 없다 — 그러니 "셋이 같은가"의 답은 **확정적으로 아니오**다.
  // 그 자리에 UNKNOWN 을 적는 것은 가진 정보를 버리는 것이다.
  //
  // 이 모듈은 이미 그 사실을 알고 있었다. 바로 아래 `runtimeSkew` 의
  // 주석이 "판정 전체가 UNKNOWN 이 되어 아무것도 못 본다"고 적어 두고
  // 함수를 **하나 더** 만들었다. 그런데 `deploymentVerdict` 자신은
  // 그대로 눈이 멀어 있었다 — `CLAUDE.md` 의 "경로가 둘인데 한쪽만 고침".

  test('★ main을 몰라도, 웹과 워커가 다르면 그것은 확정된 MISMATCH다', () => {
    const v = deploymentVerdict({ mainSha: null, vercelSha: '220f800', flySha: '4f6ee8c' });
    eq(v.code, 'MISMATCH', '아는 어긋남을 모름으로 덮었다');
    eq(v.matched, false);
    assert(v.reason.includes('220f800') && v.reason.includes('4f6ee8c'),
      `어느 둘이 다른지 적어야 한다: ${v.reason}`);
  });

  test('★ main과 Vercel만 알아도, 둘이 다르면 확정된 MISMATCH다', () => {
    const v = deploymentVerdict({ mainSha: 'aaa1111', vercelSha: 'bbb2222', flySha: null });
    eq(v.code, 'MISMATCH');
  });

  test('★ main과 Fly만 알아도, 둘이 다르면 확정된 MISMATCH다', () => {
    const v = deploymentVerdict({ mainSha: 'aaa1111', vercelSha: null, flySha: 'ccc3333' });
    eq(v.code, 'MISMATCH');
  });

  test('아는 쌍이 서로 같으면 여전히 UNKNOWN이다 — 모르는 것을 "같다"로 읽지 않는다', () => {
    const v = deploymentVerdict({ mainSha: null, vercelSha: 'a1b2c3d', flySha: 'a1b2c3d' });
    eq(v.code, 'UNKNOWN', '아직 main을 모르므로 셋이 같다고 말할 수 없다');
    eq(v.matched, false);
    assert(v.reason.includes('main'), `무엇을 못 읽었는지 적어야 한다: ${v.reason}`);
  });

  test('★ 셋 다 모르면 UNKNOWN이다 — 비교할 쌍이 없다', () => {
    const v = deploymentVerdict({ mainSha: null, vercelSha: null, flySha: null });
    eq(v.code, 'UNKNOWN');
  });

  test('★ main을 몰라도 마이그레이션이 안 됐으면 배포 완료가 아니다', () => {
    const v = deploymentVerdict({ mainSha: null, vercelSha: 'a1b2c3d', flySha: 'a1b2c3d',
      migrationsApplied: false, pendingMigrations: ['097_x.sql', '098_y.sql'] });
    eq(v.code, 'MISMATCH', 'main을 몰라도 DB가 안 따라온 것은 확정된 사실이다');
    assert(v.reason.includes('097_x.sql'), v.reason);
  });

  // ── 뒤처진 이유가 응답 안에 있는데 아무도 잇지 않았다 (2026-11-13) ──
  //
  // 그날 운영 응답은 이 둘을 **나란히** 들고 있었다:
  //
  //   skew       웹은 220f800, 워커는 4f6ee8c — 다른 코드를 돌리고 있습니다
  //   migrations applied=false · pending=[097_… , 098_…]
  //
  // 워커가 96커밋 뒤처진 **이유**는 `fly-deploy`가 11-07부터 매번
  // `사람이 승인해야 하는 마이그레이션이 남아 있습니다 (097 · 098)`로
  // 실패하고 있었기 때문이다. 그걸 알아내려고 워크플로 실행 1300건과
  // 26KB 로그를 뒤져야 했다 — **값은 이미 응답 안에 있었는데** 두 사실이
  // 한 문장으로 합쳐지지 않아서다.
  //
  // `CLAUDE.md`: "사람이 열어야 읽히는 사실은 없는 사실과 같다."

  test('★★ 워커가 뒤처졌고 마이그레이션도 남았으면 두 사실을 같이 적는다 — 무엇을 해야 풀리는지까지', () => {
    const v = deploymentVerdict({
      mainSha: null, vercelSha: '220f8001', flySha: '4f6ee8c6',
      migrationsApplied: false,
      pendingMigrations: ['097_ten_slot_atomic_claim.sql', '098_ten_slot_apply_event.sql'],
    });
    eq(v.code, 'MISMATCH');
    assert(/220f800/.test(v.reason) && /4f6ee8c/.test(v.reason), `어긋남이 안 적혔다: ${v.reason}`);
    assert(/097/.test(v.reason), `막고 있는 것이 안 적혔다: ${v.reason}`);
    assert(/승인/.test(v.reason), `무엇을 해야 풀리는지가 안 적혔다: ${v.reason}`);
  });

  test('★ 마이그레이션이 다 됐으면 승인을 요구하지 않는다 — 거짓 경보를 만들지 않는다', () => {
    const v = deploymentVerdict({
      mainSha: null, vercelSha: '220f8001', flySha: '4f6ee8c6', migrationsApplied: true,
    });
    eq(v.code, 'MISMATCH');
    assert(!/승인/.test(v.reason), `할 일이 없는데 승인을 요구했다: ${v.reason}`);
    assert(!/097/.test(v.reason), v.reason);
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

  // ── 코드가 같아도 DB가 따라오지 않았으면 배포 완료가 아니다 ──

  test('**SHA가 셋 다 같아도 마이그레이션이 남았으면 MATCHED가 아니다**', () => {
    // 코드만 앞서 나가면 새 칸에 대한 쓰기가 조용히 실패하고 매매는 계속된다.
    const v = deploymentVerdict({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'abc1234',
      migrationsApplied: false, pendingMigrations: ['057_worker_runtime.sql', '058_exit_monitor_runs.sql'],
    });
    eq(v.matched, false);
    eq(v.code, 'MISMATCH');
    assert(/057/.test(v.reason), v.reason);
  });

  test('마이그레이션까지 확인되면 MATCHED이고 그렇다고 적는다', () => {
    const v = deploymentVerdict({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'abc1234', migrationsApplied: true,
    });
    eq(v.matched, true);
    assert(/DB 스키마도 따라와/.test(v.reason), v.reason);
  });

  test('마이그레이션 상태를 안 넘기면 예전처럼 동작한다 — 갑자기 UNKNOWN이 되지 않는다', () => {
    const v = deploymentVerdict({ mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'abc1234' });
    eq(v.matched, true);
  });

  test('마이그레이션 상태를 확인하려다 못 읽으면 배포 완료로 보지 않는다', () => {
    const v = deploymentVerdict({
      mainSha: 'abc1234', vercelSha: 'abc1234', flySha: 'abc1234', migrationsApplied: null,
    });
    eq(v.code, 'UNKNOWN');
    eq(v.matched, false);
  });
}
