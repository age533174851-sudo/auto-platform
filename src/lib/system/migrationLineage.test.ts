// src/lib/system/migrationLineage.test.ts
//
// **⑤B-3A-2 — 번호가 두 갈래로 갈라진 것을 잡는가.**
//
// 로컬만 보면 번호를 바꾸고 manifest를 다시 구우면 전부 초록이다.
// 충돌은 base(main)에 대해서만 보인다 — 그래서 base를 못 읽은 것을
// "겹치지 않음"으로 적지 않는 것이 이 파일의 절반이다.
import { test, assert, eq } from '../../test/harness';
import {
  checkMigrationLineage, migrationIdOf, EXACT100X_MIGRATIONS,
  type MigrationFile,
} from './migrationLineage';

const f = (name: string, sql = `-- ${name}\n`): MigrationFile =>
  ({ name, id: migrationIdOf(name), sql });

/** base(main) — production ledger가 089까지 적용돼 있다 */
const BASE: MigrationFile[] = [
  f('087_paper_challenge_cancel.sql'),
  f('088_paper_spot_holdings.sql'),
  f('089_auth_profile_identity_sync.sql'),
];

/** 지금 저장소 — base 전부 + ⑤B 다섯 개 */
const TREE = (): MigrationFile[] => [
  ...BASE.map(b => ({ ...b })),
  ...EXACT100X_MIGRATIONS.map(d => f(d.name)),
];

export function runMigrationLineageTests() {
  test('번호를 읽는다 — 없으면 null이고 0이 아니다', () => {
    eq(migrationIdOf('094_exact100x_exit_escape_observations.sql'), 94);
    eq(migrationIdOf('RUN_PENDING.sql'), null);
    assert(migrationIdOf('RUN_PENDING.sql') !== 0, '번호 없음을 0으로 적었다');
  });

  test('지금 계보는 성립한다', () => {
    const v = checkMigrationLineage({ files: TREE(), baseFiles: BASE });
    eq(v.code, 'OK');
    eq(v.ok, true);
  });

  test('선언이 090~095 여섯 개이고 base 마지막(089) 바로 뒤다', () => {
    eq(EXACT100X_MIGRATIONS.length, 6);
    eq(EXACT100X_MIGRATIONS.map(d => d.id).join(','), '90,91,92,93,94,95');
    eq(EXACT100X_MIGRATIONS[0].name, '090_live_orders_execution_identity.sql');
    eq(EXACT100X_MIGRATIONS[5].name, '095_exact100x_observation_acl_hardening.sql');
  });

  // ── MIG-L1 ──
  test('★ 우리 파일을 다시 089로 되돌리면 base와 겹친다', () => {
    const declared = [{ id: 89, name: '089_live_orders_execution_identity.sql' },
      ...EXACT100X_MIGRATIONS.slice(1)];
    const files = [...BASE.map(b => ({ ...b })),
      f('089_live_orders_execution_identity.sql'),
      ...EXACT100X_MIGRATIONS.slice(1).map(d => f(d.name))];
    const v = checkMigrationLineage({ files, baseFiles: BASE, declared });
    assert(!v.ok, '★ 089 충돌을 통과시켰다');
    assert(v.code === 'DUPLICATE_NUMBER' || v.code === 'COLLIDES_WITH_BASE',
      `★ 충돌을 ${v.code}로 읽었다`);
  });

  // ── MIG-L2 ──
  test('★ base의 089를 지우면 잡는다', () => {
    const files = TREE().filter(x => x.name !== '089_auth_profile_identity_sync.sql');
    const v = checkMigrationLineage({ files, baseFiles: BASE });
    eq(v.code, 'BASE_FILE_MISSING', '★ 이미 적용된 마이그레이션 삭제를 통과시켰다');
  });

  test('★ base의 089 내용을 고치면 잡는다', () => {
    const files = TREE().map(x => x.name === '089_auth_profile_identity_sync.sql'
      ? { ...x, sql: x.sql + '\n-- 손댐\n' } : x);
    const v = checkMigrationLineage({ files, baseFiles: BASE });
    eq(v.code, 'BASE_FILE_CHANGED', '★ 적용된 파일 수정을 통과시켰다');
  });

  // ── MIG-L3 ──
  test('★ 번호를 건너뛰면 잡는다', () => {
    const declared = [
      { id: 90, name: '090_live_orders_execution_identity.sql' },
      { id: 92, name: '092_live_orders_entry_risk_snapshot.sql' },
    ];
    const files = [...BASE.map(b => ({ ...b })), ...declared.map(d => f(d.name))];
    eq(checkMigrationLineage({ files, baseFiles: BASE, declared }).code, 'GAP');
  });

  test('★ 같은 번호를 두 번 쓰면 잡는다', () => {
    const files = [...BASE.map(b => ({ ...b })),
      f('090_live_orders_execution_identity.sql'),
      f('090_live_orders_entry_risk_snapshot.sql')];
    eq(checkMigrationLineage({ files, baseFiles: BASE,
      declared: [{ id: 90, name: '090_live_orders_execution_identity.sql' }] }).code,
    'DUPLICATE_NUMBER');
  });

  test('★ 선언 순서가 번호 순서와 다르면 잡는다', () => {
    const declared = [
      { id: 91, name: '091_live_orders_entry_risk_snapshot.sql' },
      { id: 90, name: '090_live_orders_execution_identity.sql' },
    ];
    const files = [...BASE.map(b => ({ ...b })), ...declared.map(d => f(d.name))];
    const v = checkMigrationLineage({ files, baseFiles: BASE, declared });
    assert(!v.ok, '★ 뒤집힌 순서를 통과시켰다');
    assert(v.code === 'OUT_OF_ORDER' || v.code === 'GAP', `${v.code}`);
  });

  test('★ 파일 이름의 번호와 선언이 다르면 잡는다', () => {
    const files = [...BASE.map(b => ({ ...b })),
      // 선언은 090인데 실제 파일은 091이다
      f('091_live_orders_execution_identity.sql'),
      ...EXACT100X_MIGRATIONS.slice(1).map(d => f(d.name))];
    const v = checkMigrationLineage({ files, baseFiles: BASE });
    assert(!v.ok, '★ 선언과 파일 번호 불일치를 통과시켰다');
  });

  // ── base를 못 읽은 것은 통과가 아니다 ──
  test('★ base 목록이 비면 통과시키지 않는다', () => {
    const v = checkMigrationLineage({ files: TREE(), baseFiles: [] });
    eq(v.ok, false, '★ 비교하지 못한 것을 "겹치지 않음"으로 적었다');
    eq(v.code, 'BASE_FILE_MISSING');
  });

  test('★ 선언 파일이 이미 base에 동일하게 통합됐으면 충돌이 아니다', () => {
    // ⑤B가 main에 합쳐진 뒤의 실제 모양. 그 뒤 main에 096이 추가돼도
    // 090~095는 다시 추가할 파일이 아니라 이미 base의 일부다.
    const integrated = TREE();
    const baseAfterMerge = [...integrated.map(x => ({ ...x })), f('096_after_exact100x.sql')];
    const files = baseAfterMerge.map(x => ({ ...x }));
    const v = checkMigrationLineage({ files, baseFiles: baseAfterMerge });
    eq(v.ok, true, v.reason);
    eq(v.code, 'OK');
  });

  test('★ 일부만 base에 있고 남은 선언 번호가 이미 점유됐으면 여전히 충돌이다', () => {
    const integratedFirst = EXACT100X_MIGRATIONS.slice(0, 2).map(d => f(d.name));
    const basePartial = [...BASE.map(b => ({ ...b })), ...integratedFirst, f('092_other_main.sql')];
    const files = [
      ...basePartial.map(x => ({ ...x })),
      ...EXACT100X_MIGRATIONS.slice(2).map(d => f(d.name)),
    ];
    const v = checkMigrationLineage({ files, baseFiles: basePartial });
    eq(v.ok, false);
    assert(v.code === 'DUPLICATE_NUMBER' || v.code === 'COLLIDES_WITH_BASE',
      `★ 충돌을 ${v.code}로 읽었다`);
  });

  test('★ 우리 번호가 base 마지막보다 앞이면 잡는다', () => {
    const base2 = [...BASE, f('096_something_main_added.sql')];
    const v = checkMigrationLineage({ files: [...base2.map(b => ({ ...b })),
      ...EXACT100X_MIGRATIONS.map(d => f(d.name))], baseFiles: base2 });
    assert(!v.ok, '★ main이 더 큰 번호를 점유했는데 통과시켰다');
    eq(v.code, 'COLLIDES_WITH_BASE');
  });

  test('★ 계보 판정에 DB를 적용할 수단이 없다', async () => {
    const src = await import('./migrationLineage');
    for (const bad of ['applyMigration', 'runMigration', 'execSql', 'query']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });
}
