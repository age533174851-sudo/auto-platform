// src/lib/ops/migrationWait.test.ts
//
// **12초를 못 기다려서 배포가 매번 한 번씩 실패했다.**
//
// #182를 합친 순간 migrate와 fly-deploy가 같이 출발했고,
// fly-deploy는 01:36:03에 `PENDING`을 읽고 멈췄다. migrate는 01:36:15에
// 067을 다 적용했다. 게이트 판정은 옳았지만 **마이그레이션이 들어간
// merge마다 사람이 재실행 버튼을 눌러야** 배포가 끝났다.
//
// 그래서 판정을 느슨하게 하지 않고 **시간만 준다.** 아래 테스트가
// 지키는 것은 정확히 그 경계다.
import { test, assert, eq } from '../../test/harness';
import { migrationWaitVerdict, MIGRATION_WAIT_BUDGET_MS } from './migrationWait';

const BUDGET = MIGRATION_WAIT_BUDGET_MS;

export function runMigrationWaitTests() {
  console.log('\n⏳ 배포 전 마이그레이션 대기 (판정은 그대로, 시간만 준다)');

  // ══ 이번 고장 그대로 ══
  test('#182의 12초 — PENDING이면 기다리고, 끝나면 배포한다', () => {
    const a = migrationWaitVerdict({ code: 'PENDING', elapsedMs: 0, budgetMs: BUDGET,
      pending: ['067_kill_switch_effective_mode.sql'] });
    eq(a.code, 'WAITING', '동시에 돌고 있을 수 있다');
    assert(!a.done, '아직 결론이 아니다');
    assert(!a.proceed, '이 상태로 워커를 바꾸지 않는다');
    assert(a.reason.includes('067_kill_switch_effective_mode.sql'), '무엇이 남았는지 적는다');

    const b = migrationWaitVerdict({ code: 'UP_TO_DATE', elapsedMs: 12_000, budgetMs: BUDGET });
    eq(b.code, 'READY', '12초 뒤 migrate가 끝났다');
    assert(b.done && b.proceed, '이제 배포한다');
  });

  test('끝내 안 끝나면 배포하지 않는다 — 게이트는 그대로 fail-closed다', () => {
    const v = migrationWaitVerdict({ code: 'PENDING', elapsedMs: BUDGET, budgetMs: BUDGET });
    eq(v.code, 'TIMEOUT', '시간이 다 됐다');
    assert(v.done, '결론');
    assert(!v.proceed, '**여기서 배포하면 게이트를 없앤 것이다**');
  });

  // ══ 기다려도 소용없는 것은 기다리지 않는다 ══
  test('승인이 필요한 변경은 즉시 멈춘다 — 5분 기다려 봐야 원인만 흐려진다', () => {
    const v = migrationWaitVerdict({ code: 'NEEDS_APPROVAL', elapsedMs: 0, budgetMs: BUDGET,
      pending: ['070_drop_old_table.sql'] });
    eq(v.code, 'NEEDS_APPROVAL', '자동 적용 대상이 아니다');
    assert(v.done, '기다리지 않는다');
    assert(!v.proceed, '배포하지 않는다');
    assert(v.reason.includes('자동으로 적용되지 않습니다'), '왜 안 기다리는지 적는다');
  });

  // ══ 모르는 것을 통과로 읽지 않는다 ══
  test('상태를 못 읽으면 시간이 남았을 땐 다시 보고, 끝내 못 읽으면 막는다', () => {
    const a = migrationWaitVerdict({ code: null, elapsedMs: 0, budgetMs: BUDGET });
    eq(a.code, 'WAITING', '마이그레이션 도중에는 조회가 흔들릴 수 있다');
    const b = migrationWaitVerdict({ code: null, elapsedMs: BUDGET, budgetMs: BUDGET });
    eq(b.code, 'UNREADABLE', '끝내 못 읽었다');
    assert(!b.proceed, '못 읽은 것은 "따라와 있다"가 아니다');
    assert(b.reason.includes('뜻이 아니라서'), '통과로 읽히면 안 된다');
  });

  test('UNKNOWN도 처음 보는 코드도 전부 "모른다"로 다룬다', () => {
    for (const c of ['UNKNOWN', 'WHATEVER_NEW_CODE']) {
      eq(migrationWaitVerdict({ code: c, elapsedMs: 0, budgetMs: BUDGET }).code, 'WAITING', c);
      const done = migrationWaitVerdict({ code: c, elapsedMs: BUDGET, budgetMs: BUDGET });
      eq(done.code, 'UNREADABLE', `${c} 끝`);
      assert(!done.proceed, `${c}는 통과가 아니다`);
    }
  });

  // ══ 예전 동작 보존 ══
  test('접속 정보가 없으면 예전처럼 배포는 진행하되 "확인했다"고 적지 않는다', () => {
    const v = migrationWaitVerdict({ code: 'NO_CREDENTIAL', elapsedMs: 0, budgetMs: BUDGET });
    eq(v.code, 'SKIPPED', '건너뛴 것이지 통과한 것이 아니다');
    assert(v.done && v.proceed, '예전 워크플로도 경고만 남기고 배포했다');
    assert(v.reason.includes('뜻이 아닙니다'), '확인했다고 읽히면 안 된다');
  });

  test('READY는 시간과 무관하다 — 늦게 확인해도 따라와 있으면 배포한다', () => {
    const v = migrationWaitVerdict({ code: 'UP_TO_DATE', elapsedMs: BUDGET * 2, budgetMs: BUDGET });
    eq(v.code, 'READY', '시간이 지났다고 실패로 만들지 않는다');
    assert(v.proceed, '배포한다');
  });

  test('소문자로 와도 같은 판정이다', () => {
    eq(migrationWaitVerdict({ code: 'up_to_date', elapsedMs: 0, budgetMs: BUDGET }).code, 'READY', '소문자');
  });
}
