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

  // ── 번호가 두 갈래가 되는 것만 충돌이다 ──

  test('★ 같은 번호를 두 파일이 가리키면 잡는다 (실제 사고 모양)', () => {
    // 머지 전 실제 사고: base의 089는 auth_profile_identity_sync였고
    // 우리 089는 live_orders_execution_identity였다. 우리 트리에는
    // base의 그 파일이 **없었다** — 그래서 번호 중복으로도 안 보였다.
    const base2 = [...BASE, f('090_main_took_this_number.sql')];
    const files = [...BASE.map(b => ({ ...b })),
      ...EXACT100X_MIGRATIONS.map(d => f(d.name))];   // base의 090_main_... 없음
    const v = checkMigrationLineage({ files, baseFiles: base2 });
    assert(!v.ok, '★ 번호가 두 갈래인데 통과시켰다');
    eq(v.code, 'COLLIDES_WITH_BASE');
    assert(v.reason.includes('090_main_took_this_number.sql'),
      `base 쪽 파일 이름이 없다: ${v.reason}`);
    assert(v.reason.includes('090_live_orders_execution_identity.sql'),
      `우리 쪽 파일 이름이 없다: ${v.reason}`);
  });

  test('★ 번호가 겹치지 않은 단순 누락은 COLLIDES가 아니다', () => {
    // 같은 사실을 두 코드가 가리키면 원인이 뒤섞인다.
    const files = TREE().filter(x => x.name !== '089_auth_profile_identity_sync.sql');
    eq(checkMigrationLineage({ files, baseFiles: BASE }).code, 'BASE_FILE_MISSING');
  });

  test('main이 **더 큰** 번호를 쓰는 것은 충돌이 아니다', () => {
    // main이 097을 더해도 우리 090~095와 부딪히지 않는다. 예전 규칙은
    // "우리 번호가 base 마지막보다 커야 한다"였고, 그래서 이 경우까지
    // 실패시켰다 — 그리고 머지 후에는 **항상** 실패했다.
    const base2 = [...BASE, f('097_something_main_added.sql')];
    const v = checkMigrationLineage({
      files: [...base2.map(b => ({ ...b })), ...EXACT100X_MIGRATIONS.map(d => f(d.name))],
      baseFiles: base2,
    });
    eq(v.code, 'OK', `main의 더 큰 번호를 충돌로 읽었다: ${v.reason}`);
  });

  test('★ 선언한 번호 사이에 base의 다른 파일이 끼어도 잡는다', () => {
    // base가 092를 다른 파일로 쓰고 우리도 092를 선언한 경우. 우리
    // 트리에 base 파일이 있으면 번호 중복(①)으로, 없으면 ②의 충돌로
    // 잡힌다 — 어느 쪽이든 통과하지 않는다.
    const base2 = [...BASE, f('092_main_other.sql')];
    const withBase = [...base2.map(b => ({ ...b })),
      ...EXACT100X_MIGRATIONS.map(d => f(d.name))];
    eq(checkMigrationLineage({ files: withBase, baseFiles: base2 }).code, 'DUPLICATE_NUMBER');
    const withoutBase = [...BASE.map(b => ({ ...b })),
      ...EXACT100X_MIGRATIONS.map(d => f(d.name))];
    eq(checkMigrationLineage({ files: withoutBase, baseFiles: base2 }).code,
      'COLLIDES_WITH_BASE');
  });

  test('★ 머지된 뒤에도 통과한다 — base가 우리 파일을 포함한다', () => {
    // ⑤B가 main에 들어가면 base 자신이 090~095를 갖는다. 예전 규칙은
    // 그 상태에서 전부 COLLIDES_WITH_BASE를 냈고 main CI가 빨개졌다.
    const merged = [...BASE.map(b => ({ ...b })),
      ...EXACT100X_MIGRATIONS.map(d => f(d.name))];
    const v = checkMigrationLineage({ files: merged.map(x => ({ ...x })), baseFiles: merged });
    eq(v.code, 'OK', `★ 머지 후 상태를 충돌로 읽는다: ${v.reason}`);
    eq(v.ok, true);
  });

  test('★ 머지된 뒤에도 base 파일 변경은 잡는다', () => {
    const merged = [...BASE.map(b => ({ ...b })),
      ...EXACT100X_MIGRATIONS.map(d => f(d.name))];
    const files = merged.map(x => x.name === '092_exact100x_risk_observations.sql'
      ? { ...x, sql: `${x.sql}\n-- 손댐\n` } : { ...x });
    eq(checkMigrationLineage({ files, baseFiles: merged }).code, 'BASE_FILE_CHANGED',
      '★ 머지 후에는 적용된 파일 수정을 놓친다');
  });

  test('★ 계보 판정에 DB를 적용할 수단이 없다', async () => {
    const src = await import('./migrationLineage');
    for (const bad of ['applyMigration', 'runMigration', 'execSql', 'query']) {
      eq(Object.keys(src).includes(bad), false, `★ ${bad}를 내보낸다`);
    }
  });
}
