// src/lib/system/migrationApprovalGate.test.ts
//
// **승인 없이 운영 DB에 적용될 수 있는가.**
//
// 무엇이 있었나
// ─────────────
// `097_jobs_killswitch_active_unique.sql`은 머리말에 이렇게 적어 두었다:
//
//   SAFETY: Do not apply to any operating DB without separate user approval.
//
// 그런데 분류기는 그 파일을 **ADDITIVE**로 읽었고, ADDITIVE는 자동 적용
// 대상이다. 체인은 이렇다:
//
//   main에 push → `migrate.yml`(on: push: branches: [main])
//               → `apply-migrations.mjs`
//               → ADDITIVE는 승인 경로를 거치지 않는다
//               → **운영 DB에 적용된다**
//
// 파일이 요구한 것과 파이프라인이 하는 일이 어긋나 있었다. 주석은 관문이
// 아니다 — 아무도 읽지 않는다.

import { test, eq, assert } from '../../test/harness';
import { classifyMigration, migrationPlanOf, tablesCreatedIn, dataDependentReason } from './migrationPlan';

/** #404가 추가한 097의 본문 (요지만 — 판정에 쓰이는 문장은 그대로다) */
const SQL_097 = `
-- SAFETY: Do not apply to any operating DB without separate user approval.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_kill_switch_per_connection
  ON public.jobs (connection_id)
  WHERE action = 'KILL_SWITCH_EXECUTE'
    AND status IN ('PENDING', 'PROCESSING')
    AND connection_id IS NOT NULL;
`;

/** 같은 파일에서 표를 만들고 거기에 제약을 거는 경우 — 비어 있으니 안전하다 */
const SQL_NEW_TABLE = `
create table if not exists widget_log (
  id uuid primary key default gen_random_uuid(),
  owner text not null
);
create unique index if not exists idx_widget_log_owner on widget_log (owner);
`;

export function runMigrationApprovalGateTests() {
  console.log('[마이그레이션 승인 관문 — 기존 표에 거는 제약은 자동으로 가지 않는다]');

  // ── ① 097이 자동 적용 대상이 아니어야 한다 ─────────────────────
  test('★ 097은 자동 적용되지 않는다', () => {
    const c = classifyMigration(SQL_097);
    eq(c.autoApply, false, '097이 승인 없이 운영 DB에 적용됩니다');
    eq(c.risk, 'DATA_DEPENDENT');
  });

  test('★ 사유에 어느 표인지가 남는다 — 사람이 무엇을 볼지 알아야 한다', () => {
    const c = classifyMigration(SQL_097);
    assert(c.reasons.join(' ').includes('jobs'), `사유에 표 이름이 없습니다: ${c.reasons.join(' / ')}`);
  });

  test('지우는 것이 아니므로 DESTRUCTIVE로 적지 않는다', () => {
    eq(classifyMigration(SQL_097).risk !== 'DESTRUCTIVE', true,
      '지우지 않는 파일을 DESTRUCTIVE로 적으면 그 이름을 아무도 믿지 않게 됩니다');
  });

  // ── ② 같은 파일에서 만든 표는 그대로 자동이다 (거짓 양성 없음) ──
  test('★ 같은 파일에서 만든 표에 거는 제약은 자동 적용 그대로다', () => {
    const c = classifyMigration(SQL_NEW_TABLE);
    eq(c.risk, 'ADDITIVE', '새 표에 거는 제약까지 막으면 평범한 마이그레이션이 전부 멈춥니다');
    eq(c.autoApply, true);
  });

  test('표 이름을 스키마·따옴표와 무관하게 같은 것으로 본다', () => {
    const made = tablesCreatedIn('create table if not exists "public"."jobs" (id uuid);');
    eq(made.has('jobs'), true);
    eq(dataDependentReason('CREATE UNIQUE INDEX i ON public.jobs (a)', made), null,
      '같은 표인데 다른 표로 읽었습니다');
  });

  test('만들지 않은 표면 사유를 돌려준다', () => {
    const r = dataDependentReason('CREATE UNIQUE INDEX i ON public.jobs (a)', new Set());
    assert(r != null && r.includes('jobs'), '기존 표 제약을 알아보지 못했습니다');
  });

  test('ADD CONSTRAINT · SET NOT NULL도 같은 취급이다', () => {
    for (const st of [
      'ALTER TABLE live_orders ADD CONSTRAINT chk_qty CHECK (qty > 0)',
      'ALTER TABLE live_orders ALTER COLUMN qty SET NOT NULL',
    ]) {
      assert(dataDependentReason(st, new Set()) != null, `놓쳤습니다: ${st}`);
      eq(dataDependentReason(st, new Set(['live_orders'])), null, '새 표인데 막았습니다');
    }
  });

  // ── SQL provenance: 설명·문자열·미래 문장은 실행된 증거가 아니다 ──
  test('주석 속 CREATE TABLE은 기존 표를 새 표로 만들지 않는다', () => {
    const sql = '-- CREATE TABLE public.jobs (id uuid);\n'
      + 'CREATE UNIQUE INDEX ix_jobs_a ON public.jobs (a);';
    eq(tablesCreatedIn(sql).has('jobs'), false);
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
    eq(classifyMigration(sql).autoApply, false);
  });

  test('블록 주석 속 CREATE TABLE도 새 표 증거가 아니다', () => {
    const sql = '/* CREATE TABLE jobs (id uuid); */\n'
      + 'CREATE UNIQUE INDEX ix_jobs_a ON jobs (a);';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
  });

  test('COMMENT ON 문자열 속 CREATE TABLE도 새 표 증거가 아니다', () => {
    const sql = "COMMENT ON TABLE jobs IS 'CREATE TABLE jobs (id uuid)';\n"
      + 'CREATE UNIQUE INDEX ix_jobs_a ON jobs (a);';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
  });

  test('주석 속 DROP INDEX는 실제로 지운 제약이 아니다', () => {
    const sql = '-- DROP INDEX IF EXISTS ix_jobs_a;\n'
      + 'CREATE UNIQUE INDEX ix_jobs_a ON jobs (a);';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
  });

  test('블록 주석 속 DROP CONSTRAINT도 실제로 지운 제약이 아니다', () => {
    const sql = '/* ALTER TABLE jobs DROP CONSTRAINT ix_jobs_a; */\n'
      + 'ALTER TABLE jobs ADD CONSTRAINT ix_jobs_a CHECK (a > 0);';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
  });

  test('뒤에 나오는 DROP INDEX는 앞의 UNIQUE 인덱스를 안전하게 만들지 않는다', () => {
    const sql = 'CREATE UNIQUE INDEX ix_jobs_a ON jobs (a);\n'
      + 'DROP INDEX IF EXISTS ix_jobs_a;';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
  });

  test('뒤에 나오는 CREATE TABLE은 앞의 UNIQUE 인덱스를 안전하게 만들지 않는다', () => {
    const sql = 'CREATE UNIQUE INDEX ix_jobs_a ON jobs (a);\n'
      + 'CREATE TABLE jobs (id uuid);';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
  });

  test('실제 앞선 CREATE TABLE과 DROP INDEX는 기존 계약을 유지한다', () => {
    eq(classifyMigration('CREATE TABLE new_jobs (a int); CREATE UNIQUE INDEX i ON new_jobs (a);').risk, 'ADDITIVE');
    eq(classifyMigration('DROP INDEX IF EXISTS i; CREATE UNIQUE INDEX i ON jobs (a);').risk, 'ADDITIVE');
  });

  // ── SQL의 IF NOT EXISTS / DROP 재생성은 기존 데이터 안전 증거가 아니다 ──
  test('★ IF NOT EXISTS 표는 이미 존재할 수 있어 UNIQUE 자동 적용 금지', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS jobs (id int, a int); '
      + 'CREATE UNIQUE INDEX IF NOT EXISTS jobs_a_unique ON jobs (a);';
    eq(tablesCreatedIn(sql).has('jobs'), false,
      'IF NOT EXISTS는 실제 CREATE 성공 증거가 아닙니다');
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
    eq(classifyMigration(sql).autoApply, false);
  });

  test('★ IF NOT EXISTS 뒤의 CHECK 및 NOT NULL도 기존 표 제약이다', () => {
    for (const sql of [
      'CREATE TABLE IF NOT EXISTS jobs (a int); ALTER TABLE jobs ADD CONSTRAINT jobs_a_chk CHECK (a > 0);',
      'CREATE TABLE IF NOT EXISTS jobs (a int); ALTER TABLE jobs ALTER COLUMN a SET NOT NULL;',
    ]) {
      eq(classifyMigration(sql).risk, 'DATA_DEPENDENT', sql);
      eq(classifyMigration(sql).autoApply, false);
    }
  });

  test('★ DROP INDEX 후 같은 이름으로 더 엄격한 UNIQUE를 재생성해도 승인 필요', () => {
    const sql = 'DROP INDEX IF EXISTS jobs_a_unique; '
      + 'CREATE UNIQUE INDEX jobs_a_unique ON jobs (a) WHERE status = 1;';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
    eq(classifyMigration(sql).autoApply, false);
  });

  test('★ DROP CONSTRAINT 후 같은 이름의 CHECK 정의 변경도 승인 필요', () => {
    const sql = 'ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_a_chk; '
      + 'ALTER TABLE jobs ADD CONSTRAINT jobs_a_chk CHECK (a > 100);';
    eq(classifyMigration(sql).risk, 'DATA_DEPENDENT');
    eq(classifyMigration(sql).autoApply, false);
  });

  test('실제 CREATE TABLE이 앞에 있는 신규 표의 UNIQUE는 여전히 자동 가능', () => {
    const sql = 'CREATE TABLE new_jobs (a int); CREATE UNIQUE INDEX i ON new_jobs (a);';
    eq(tablesCreatedIn(sql).has('new_jobs'), true);
    eq(classifyMigration(sql).risk, 'ADDITIVE');
  });

  // ── ③ 계획이 실제로 막는가 (승인 우회) ─────────────────────────
  const files = [
    { name: '096_prev.sql', id: 96, sql: 'create table if not exists t96 (id uuid);' },
    { name: '097_jobs_killswitch_active_unique.sql', id: 97, sql: SQL_097 },
    { name: '098_after.sql', id: 98, sql: 'create table if not exists t98 (id uuid);' },
  ];

  test('★ 097이 미적용이면 계획은 NEEDS_APPROVAL이고 자동 목록에 없다', () => {
    const plan = migrationPlanOf({ files, applied: [] });
    eq(plan.code, 'NEEDS_APPROVAL', '승인 없이 진행하는 계획이 나왔습니다');
    assert(plan.blocked.some(b => b.name === files[1].name), '097이 막히지 않았습니다');
    eq(plan.autoApply.includes(files[1].name), false, '097이 자동 적용 목록에 있습니다');
  });

  test('★ 승인 우회 — 097 뒤의 파일도 자동으로 가지 않는다', () => {
    const plan = migrationPlanOf({ files, applied: [] });
    eq(plan.autoApply.includes('098_after.sql'), false,
      '막힌 파일을 건너뛰고 뒤엣것이 먼저 들어갑니다 — 순서가 뒤엉킵니다');
    eq(plan.autoApply.includes('096_prev.sql'), true, '앞의 안전한 파일까지 멈췄습니다');
  });

  // ── ④ 중복 실행 ────────────────────────────────────────────────
  test('★ 이미 적용된 097은 다시 계획되지 않는다', () => {
    const plan = migrationPlanOf({ files, applied: files.map(f => f.name) });
    eq(plan.code, 'UP_TO_DATE');
    eq(plan.pending.length, 0);
    eq(plan.blocked.length, 0, '이미 적용된 것을 다시 막아 배포를 멈춥니다');
  });

  test('★ 재분류가 이미 적용된 구 마이그레이션을 다시 막지 않는다', () => {
    // 033·053·064·077·090·093 등이 DATA_DEPENDENT로 다시 분류됐다.
    // 그것들은 전부 적용된 지 오래다 — 계획은 적용된 것을 **분류 전에**
    // 걸러내므로 운영에 영향이 없어야 한다.
    const old = [
      { name: '064_equity_snapshot_bucket.sql', id: 64, sql: 'CREATE UNIQUE INDEX i ON account_equity_snapshots (a)' },
      { name: '099_new_safe.sql', id: 99, sql: 'create table if not exists t99 (id uuid);' },
    ];
    const plan = migrationPlanOf({ files: old, applied: ['064_equity_snapshot_bucket.sql'] });
    eq(plan.blocked.length, 0, '이미 적용된 구 파일이 다시 막혔습니다');
    eq(plan.autoApply.includes('099_new_safe.sql'), true, '뒤의 안전한 파일이 막혔습니다');
  });

  test('적용 목록을 못 읽으면 계획 자체가 UNKNOWN이다 — 추측해서 적용하지 않는다', () => {
    const plan = migrationPlanOf({ files, applied: null });
    eq(plan.code, 'UNKNOWN');
    eq(plan.autoApply.length, 0);
  });

  // ── ⑤ 기존 데이터 충돌 ─────────────────────────────────────────
  //
  // 097은 "기존 중복이 있으면 인덱스 생성이 실패한다"고 스스로 적어 두었다.
  // 그 실패는 **운영 배포가 그 자리에서 멈춘다**는 뜻이다. 관문은 그 일이
  // 벌어지기 전에 사람을 부르는 데 있다.
  /** 097이 만드는 부분 고유 인덱스의 뜻을 그대로 모형화한다 */
  function uniqueIndexWouldFail(rows: Array<{ connection_id: string | null; action: string; status: string }>): boolean {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.action !== 'KILL_SWITCH_EXECUTE') continue;
      if (!['PENDING', 'PROCESSING'].includes(r.status)) continue;
      if (r.connection_id == null) continue;
      if (seen.has(r.connection_id)) return true;
      seen.add(r.connection_id);
    }
    return false;
  }

  test('★ 기존 중복이 있으면 인덱스 생성은 실패한다 (그래서 사람이 먼저 봐야 한다)', () => {
    eq(uniqueIndexWouldFail([
      { connection_id: 'c1', action: 'KILL_SWITCH_EXECUTE', status: 'PENDING' },
      { connection_id: 'c1', action: 'KILL_SWITCH_EXECUTE', status: 'PROCESSING' },
    ]), true);
  });

  test('끝난 잡은 자리를 차지하지 않는다 — 중복으로 세지 않는다', () => {
    eq(uniqueIndexWouldFail([
      { connection_id: 'c1', action: 'KILL_SWITCH_EXECUTE', status: 'COMPLETED' },
      { connection_id: 'c1', action: 'KILL_SWITCH_EXECUTE', status: 'PENDING' },
    ]), false);
  });

  test('다른 연결·다른 action은 충돌이 아니다', () => {
    eq(uniqueIndexWouldFail([
      { connection_id: 'c1', action: 'KILL_SWITCH_EXECUTE', status: 'PENDING' },
      { connection_id: 'c2', action: 'KILL_SWITCH_EXECUTE', status: 'PENDING' },
      { connection_id: 'c1', action: 'PLACE_ORDER', status: 'PENDING' },
    ]), false);
  });

  test('connection_id가 비면 부분 인덱스 밖이다', () => {
    eq(uniqueIndexWouldFail([
      { connection_id: null, action: 'KILL_SWITCH_EXECUTE', status: 'PENDING' },
      { connection_id: null, action: 'KILL_SWITCH_EXECUTE', status: 'PENDING' },
    ]), false);
  });

  // ── ⑥ 더 위험한 것이 가려지지 않는다 ───────────────────────────
  test('DESTRUCTIVE가 DATA_DEPENDENT보다 먼저다', () => {
    const c = classifyMigration('DROP TABLE jobs; CREATE UNIQUE INDEX i ON live_orders (a);');
    eq(c.risk, 'DESTRUCTIVE', '지우는 문장이 제약 판정에 가려졌습니다');
    eq(c.autoApply, false);
  });

  test('UNKNOWN도 DATA_DEPENDENT보다 먼저다', () => {
    const c = classifyMigration('FLARBLE wibble; CREATE UNIQUE INDEX i ON live_orders (a);');
    eq(c.risk, 'UNKNOWN', '모르는 문장이 제약 판정에 가려졌습니다');
    eq(c.autoApply, false);
  });

  test('어떤 경우에도 autoApply가 true인 위험도는 ADDITIVE뿐이다', () => {
    for (const sql of [SQL_097, 'DROP TABLE t;', 'FLARBLE;', SQL_NEW_TABLE]) {
      const c = classifyMigration(sql);
      if (c.autoApply) eq(c.risk, 'ADDITIVE', `${c.risk}인데 자동 적용입니다`);
    }
  });
}
