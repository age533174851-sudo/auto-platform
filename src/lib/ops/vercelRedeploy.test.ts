// src/lib/ops/vercelRedeploy.test.ts
//
// **재배포는 고장을 고치는 것이 아니라 빨강을 지우기 쉬운 도구다.**
//
// 그래서 여기서 가장 많이 확인하는 것은 "언제 누르는가"가 아니라
// **"언제 안 누르는가"**다. 아래 시나리오의 기준값은 2026-09-13에 실제로
// 관측된 응답이다 — main·fly는 c61271e인데 vercel만 ae06912였다.
import { test, eq, assert } from '../../test/harness';
import { redeployDecision, redeployOutcome, DEFAULT_LIMITS } from './vercelRedeploy';

const MAIN = 'c61271eb58472a11d684799ea959765fe4618831';
const OLD = 'ae069124ec3330dde7b0b7073d966b6b5c66c4e6';
const NOW = Date.parse('2026-09-13T17:24:03.670Z');

/** 그날 실제로 돌아온 값 (Vercel만 뒤처진 상태) */
function skew(over: any = {}) {
  return {
    hookConfigured: true,
    mainSha: MAIN, vercelSha: OLD, flySha: MAIN,
    pendingCount: 0, workerAlive: true,
    attempts: 0, lastAttemptIso: null as string | null,
    now: NOW,
    ...over,
  };
}

export function runVercelRedeployTests() {
  console.log('\n🔁 Vercel 배포 어긋남 자동복구 (누르는 조건보다 안 누르는 조건이 많다)');

  // ══ 그날 그대로 ══
  test('그날의 값에서는 깨운다 — main·fly 같고 vercel만 다르다', () => {
    const d = redeployDecision(skew());
    eq(d.code, 'FIRE', 'Vercel만 뒤처진 것이 증명된 경우');
    assert(d.fire, '깨워야 한다');
    assert(d.reason.includes('1/3'), `몇 번째 시도인지 남긴다 — ${d.reason}`);
  });

  // ══ hook이 없으면 아무 일도 없다 ══
  test('hook이 없으면 판정도 하지 않는다 — 기존 동작 그대로', () => {
    const d = redeployDecision(skew({ hookConfigured: false }));
    eq(d.code, 'SKIP_NO_HOOK', 'secret 미설정');
    assert(!d.fire, '깨우면 안 된다');
  });

  // ══ 모름을 어긋남으로 적지 않는다 ══
  for (const [label, over] of [
    ['main', { mainSha: null }],
    ['vercel', { vercelSha: null }],
    ['fly', { flySha: '' }],
  ] as [string, any][]) {
    test(`${label} SHA를 못 읽으면 SKIP_UNKNOWN — 모름은 어긋남이 아니다`, () => {
      const d = redeployDecision(skew(over));
      eq(d.code, 'SKIP_UNKNOWN', label);
      assert(!d.fire, '모르는 채로 누르지 않는다');
    });
  }

  test('남은 마이그레이션 수를 못 읽으면 0으로 치지 않는다', () => {
    const d = redeployDecision(skew({ pendingCount: null }));
    eq(d.code, 'SKIP_UNKNOWN', '확인 못 한 것은 통과가 아니다');
  });

  test('워커 상태를 못 읽으면 정상으로 치지 않는다', () => {
    const d = redeployDecision(skew({ workerAlive: null }));
    eq(d.code, 'SKIP_WORKER', 'null은 alive가 아니다');
  });

  // ══ 다른 고장을 재배포로 덮지 않는다 ══
  test('이미 같으면 누르지 않는다', () => {
    eq(redeployDecision(skew({ vercelSha: MAIN })).code, 'SKIP_MATCHED');
  });

  test('Fly도 다르면 Vercel 문제가 아니다 — 배포 전체가 안 끝난 것이다', () => {
    const d = redeployDecision(skew({ flySha: OLD }));
    eq(d.code, 'SKIP_NOT_VERCEL_ONLY', 'fly != main');
    assert(!d.fire, '절반만 밀어 놓고 초록을 만들지 않는다');
  });

  test('마이그레이션이 밀려 있으면 재배포로 가리지 않는다', () => {
    const d = redeployDecision(skew({ pendingCount: 1 }));
    eq(d.code, 'SKIP_MIGRATIONS_PENDING', '스키마가 먼저다');
    assert(d.reason.includes('1개'), '몇 개인지 적는다');
  });

  test('워커가 죽어 있으면 재배포로 가리지 않는다', () => {
    eq(redeployDecision(skew({ workerAlive: false })).code, 'SKIP_WORKER');
  });

  // ══ 무한 루프를 막는다 ══
  test('시도 횟수를 못 세면 누르지 않는다 — 한도를 모르는 채로 누르지 않는다', () => {
    const d = redeployDecision(skew({ attempts: null }));
    eq(d.code, 'SKIP_UNKNOWN', 'null은 0이 아니다');
    assert(!d.fire, '무한 반복을 막을 수 없는 상태다');
  });

  test('같은 SHA로 한도까지 눌렀으면 더 누르지 않는다', () => {
    const d = redeployDecision(skew({ attempts: DEFAULT_LIMITS.maxAttempts }));
    eq(d.code, 'SKIP_ATTEMPTS_EXHAUSTED', `한도 ${DEFAULT_LIMITS.maxAttempts}`);
  });

  test('한도 직전까지는 누른다 — 경계에서 조용히 멈추지 않는다', () => {
    const d = redeployDecision(skew({ attempts: DEFAULT_LIMITS.maxAttempts - 1 }));
    eq(d.code, 'FIRE', '2회까지는 남아 있다');
    assert(d.reason.includes('3/3'), `마지막 시도임을 적는다 — ${d.reason}`);
  });

  test('방금 눌렀으면 기다린다', () => {
    const d = redeployDecision(skew({
      attempts: 1, lastAttemptIso: new Date(NOW - 60_000).toISOString(),
    }));
    eq(d.code, 'SKIP_COOLDOWN', '1분 전');
    assert(d.reason.includes('초 더 기다립니다'), '얼마나 남았는지 적는다');
  });

  test('쿨다운이 지나면 다시 누른다', () => {
    const d = redeployDecision(skew({
      attempts: 1, lastAttemptIso: new Date(NOW - DEFAULT_LIMITS.cooldownMs - 1000).toISOString(),
    }));
    eq(d.code, 'FIRE', '기다림이 끝났다');
  });

  test('읽을 수 없는 시각은 쿨다운으로 치지 않는다 — 영원히 막히지 않게', () => {
    const d = redeployDecision(skew({ attempts: 1, lastAttemptIso: '언제였더라' }));
    eq(d.code, 'FIRE', '파싱 실패로 기능이 멎으면 안 된다');
  });

  // ══ 호출 성공 ≠ 배포 성공 ══
  test('hook이 200이어도 SHA가 안 바뀌면 성공이 아니다', () => {
    const o = redeployOutcome({
      hookOk: true, hookStatus: 201, mainSha: MAIN, vercelShaAfter: OLD, waitedSec: 480,
    });
    eq(o.code, 'FIRED_NOT_VERIFIED', '요청을 받은 것과 떠 있는 것은 다르다');
    assert(!o.ok, '초록으로 적지 않는다');
  });

  test('다시 읽은 Vercel이 main이면 그때가 성공이다', () => {
    const o = redeployOutcome({
      hookOk: true, hookStatus: 201, mainSha: MAIN, vercelShaAfter: MAIN, waitedSec: 120,
    });
    eq(o.code, 'VERIFIED', '실측으로 확인');
    assert(o.ok, '초록');
  });

  test('기다린 뒤에도 못 읽었으면 성공이 아니다', () => {
    const o = redeployOutcome({
      hookOk: true, hookStatus: 201, mainSha: MAIN, vercelShaAfter: null, waitedSec: 480,
    });
    eq(o.code, 'FIRED_NOT_VERIFIED', '못 읽음은 같음이 아니다');
  });

  test('hook 호출이 실패하면 그것부터 적는다', () => {
    const o = redeployOutcome({
      hookOk: false, hookStatus: 403, mainSha: MAIN, vercelShaAfter: OLD, waitedSec: 0,
    });
    eq(o.code, 'HOOK_FAILED', 'HTTP 403');
    assert(o.reason.includes('403'), '무엇이 돌아왔는지 적는다');
  });
}
