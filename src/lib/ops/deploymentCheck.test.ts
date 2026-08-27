// src/lib/ops/deploymentCheck.test.ts
//
// **이 검사는 8번 실행해서 8번 다 실패했다.**
//
// 그런데 배포는 멀쩡했다. `verdict`가 객체인데 문자열 `MATCHED`와
// 비교했기 때문이다. 언제나 빨강인 검사는 진짜 어긋난 날의 빨강과
// 구별되지 않는다 — 그래서 아래 첫 테스트는 **그날의 응답 원문**으로
// 시작한다.
import { test, assert, eq } from '../../test/harness';
import { deploymentCheckVerdict, verdictCodeOf } from './deploymentCheck';

const MAIN = 'fc14ffe9556fe56014d079d79ea570246e7b6482';

/** 2026-08-27 01:39:53Z에 실제로 돌아온 응답 (필요한 칸만) */
function realBody() {
  return {
    ok: true,
    migrations: { applied: true, pending: [], pendingCount: 0 },
    vercel: { sha: MAIN, short: 'fc14ffe', source: 'VERCEL_GIT_COMMIT_SHA' },
    fly: { sha: MAIN, workerId: '784ed315f23358', ageSec: 2, alive: true, status: 'running' },
    main: { sha: MAIN, short: 'fc14ffe', note: '요청에서 받은 값입니다' },
    skew: { code: 'MATCHED', matched: true, reason: '...' },
    verdict: { code: 'MATCHED', matched: true, reason: 'main · Vercel · Fly가 같은 코드를 돌리고 있고 DB 스키마도 따라와 있습니다' },
  };
}

export function runDeploymentCheckTests() {
  console.log('\n🚦 배포 SHA 확인 (판정을 읽는 쪽이 틀리면 검사는 없느니만 못하다)');

  // ══ 이번 고장 그대로 ══
  test('그날의 응답이 통과한다 — verdict가 객체여도 읽는다', () => {
    const v = deploymentCheckVerdict({ body: realBody(), expectMain: MAIN });
    eq(v.code, 'MATCHED', '전부 같은 SHA인데 실패라고 적었던 자리');
    assert(v.ok, '초록이어야 한다');
    eq(v.serverCode, 'MATCHED', '서버 판정 그대로');
    eq(v.detail.vercel, 'fc14ffe', 'vercel');
    eq(v.detail.fly, 'fc14ffe', 'fly');
    eq(v.detail.pendingCount, 0, '남은 마이그레이션');
  });

  test('예전처럼 verdict가 문자열로 와도 같은 답을 준다', () => {
    const b: any = realBody(); b.verdict = 'MATCHED';
    eq(deploymentCheckVerdict({ body: b, expectMain: MAIN }).code, 'MATCHED', '문자열');
  });

  test('verdictCodeOf는 두 모양만 읽고 나머지는 null이다', () => {
    eq(verdictCodeOf({ verdict: { code: 'matched' } }), 'MATCHED', '객체·소문자');
    eq(verdictCodeOf({ verdict: 'MISMATCH' }), 'MISMATCH', '문자열');
    eq(verdictCodeOf({ verdict: { matched: true } }), null, 'code가 없으면 모른다');
    eq(verdictCodeOf({ verdict: null }), null, 'null');
    eq(verdictCodeOf({}), null, '칸 자체가 없음');
    eq(verdictCodeOf(null), null, '응답 없음');
  });

  // ══ 진짜 어긋난 날 ══
  test('실제로 다르면 빨강이다 — 이 검사가 존재하는 이유', () => {
    const b: any = realBody();
    b.fly = { ...b.fly, sha: '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    b.verdict = { code: 'SKEWED', matched: false, reason: '웹과 워커가 다른 코드입니다' };
    const v = deploymentCheckVerdict({ body: b, expectMain: MAIN });
    eq(v.code, 'MISMATCH', '어긋났다');
    assert(!v.ok, '실패로 끝나야 한다');
    assert(v.reason.includes('SKEWED'), `서버 판정을 그대로 싣는다: ${v.reason}`);
    assert(v.reason.includes('0000000'), 'fly SHA도 보여 준다');
  });

  test('마이그레이션이 남아 있으면 서버 판정이 그대로 실패가 된다', () => {
    const b: any = realBody();
    b.migrations = { applied: false, pending: ['067_x.sql'], pendingCount: 1 };
    b.verdict = { code: 'MIGRATIONS_PENDING', matched: false, reason: 'DB가 뒤처져 있습니다' };
    const v = deploymentCheckVerdict({ body: b, expectMain: MAIN });
    assert(!v.ok, '통과시키지 않는다');
    eq(v.detail.pendingCount, 1, '남은 개수를 싣는다');
  });

  // ══ 모르는 것을 통과로 읽지 않는다 ══
  test('응답을 못 읽으면 "같다"가 아니다', () => {
    const v = deploymentCheckVerdict({ body: null, expectMain: MAIN });
    eq(v.code, 'UNREADABLE', '못 읽었다');
    assert(!v.ok, '통과시키지 않는다');
    assert(v.reason.includes('뜻이 아닙니다'), '통과로 읽히면 안 된다');
  });

  test('응답에 판정이 없으면 통과시키지 않는다 — 검사가 대상을 잃은 것이다', () => {
    const b: any = realBody(); delete b.verdict;
    const v = deploymentCheckVerdict({ body: b, expectMain: MAIN });
    eq(v.code, 'NO_VERDICT', '판정이 없다');
    assert(!v.ok, '모양이 바뀐 것을 초록으로 넘기면 이 검사는 사라진 것과 같다');
  });

  test('서버가 다른 main으로 판정했으면 그 답을 쓰지 않는다', () => {
    const b: any = realBody();
    b.main = { sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
    const v = deploymentCheckVerdict({ body: b, expectMain: MAIN });
    eq(v.code, 'UNREADABLE', '우리가 물어본 질문의 답이 아니다');
    assert(!v.ok, '통과시키지 않는다');
  });

  // ══ 비교 대상이 없을 때 (예전 동작 보존) ══
  test('main을 주지 않으면 보여 주기만 하고 실패시키지 않는다', () => {
    const v = deploymentCheckVerdict({ body: realBody() });
    assert(v.ok, '예전 워크플로도 MAIN이 없으면 실패시키지 않았다');
    eq(v.serverCode, 'MATCHED', '판정은 그대로 보여 준다');
  });

  test('main을 안 줬는데 어긋나 있어도 실패시키지는 않는다 — 다만 코드로 드러난다', () => {
    const b: any = realBody();
    b.verdict = { code: 'SKEWED', matched: false, reason: '...' };
    const v = deploymentCheckVerdict({ body: b });
    assert(v.ok, '비교 대상이 없으면 판정하지 않는다');
    eq(v.code, 'MISMATCH', '그래도 어긋난 사실은 코드에 남는다');
  });
}
