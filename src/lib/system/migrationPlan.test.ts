// src/lib/system/migrationPlan.test.ts
//
// **"자동으로 적용한다"는 말이 "아무거나 실행한다"가 되지 않게 하는 시험.**
//
// 여기서 지켜야 할 것은 두 가지고, 둘의 방향이 반대다:
//
//   1. 더하기만 하는 마이그레이션은 사람 손을 안 거치고 적용돼야 한다
//      (안 그러면 054·055·056처럼 DB만 뒤처진다)
//   2. 지우는 마이그레이션은 **한 번도** 자동으로 실행되면 안 된다
//      (한 번이면 충분히 되돌릴 수 없다)
//
// 그래서 2번은 "혹시 몰라서" 쪽으로 기운다. 판정 못 한 문장은 통과가
// 아니라 정지다.

import { test, eq, assert } from '../../test/harness';
import {
  classifyMigration, migrationIdOf, migrationPlanOf, migrationEntryGate,
  migrationTargets, migrationDrift,
} from './migrationPlan';

const ADDITIVE_SQL = `
CREATE TABLE IF NOT EXISTS ledger_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount NUMERIC
);
CREATE INDEX IF NOT EXISTS ledger_events_id_idx ON ledger_events (id);
ALTER TABLE ledger_events ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE ledger_events IS '장부';
`;

function file(name: string, sql: string) {
  return { name, id: migrationIdOf(name), sql };
}

export function runMigrationPlanTests() {
  console.log('[마이그레이션 자동 적용 — 더하는 것만 자동, 지우는 것은 정지]');

  // ── 1. 더하기는 자동 ──

  test('표·인덱스·RLS·주석만 있으면 ADDITIVE이고 자동 적용한다', () => {
    const c = classifyMigration(ADDITIVE_SQL);
    eq(c.risk, 'ADDITIVE');
    eq(c.autoApply, true);
  });

  test('DO $$ 블록으로 감싼 CREATE POLICY도 자동 적용한다', () => {
    const c = classifyMigration(`
      CREATE TABLE IF NOT EXISTS t (id INT);
      DO $$ BEGIN
        CREATE POLICY t_own ON t FOR SELECT USING (true);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    eq(c.risk, 'ADDITIVE');
  });

  test('인덱스를 지웠다 다시 만드는 것은 자동 적용한다 (055가 실제로 그랬다)', () => {
    const c = classifyMigration(`
      DROP INDEX IF EXISTS smoke_runs_active_idx;
      CREATE UNIQUE INDEX smoke_runs_active_idx ON smoke_runs (user_id) WHERE status = 'RUNNING';
    `);
    eq(c.risk, 'ADDITIVE');
    eq(c.autoApply, true);
  });

  // ── 2. 지우기는 정지 ──

  test('DROP TABLE은 자동 적용하지 않는다', () => {
    const c = classifyMigration('DROP TABLE ledger_events;');
    eq(c.risk, 'DESTRUCTIVE');
    eq(c.autoApply, false);
  });

  test('DROP COLUMN은 자동 적용하지 않는다 — 값이 같이 사라진다', () => {
    const c = classifyMigration('ALTER TABLE live_orders DROP COLUMN sl_order_id;');
    eq(c.risk, 'DESTRUCTIVE');
    eq(c.autoApply, false);
  });

  test('ALTER COLUMN ... TYPE은 자동 적용하지 않는다 — Gate int64가 잘릴 수 있다', () => {
    const c = classifyMigration('ALTER TABLE live_orders ALTER COLUMN venue_order_id TYPE BIGINT;');
    eq(c.risk, 'DESTRUCTIVE');
  });

  test('조건 없는 DELETE는 자동 적용하지 않는다', () => {
    eq(classifyMigration('DELETE FROM positions;').risk, 'DESTRUCTIVE');
  });

  test('WHERE가 붙은 DELETE는 대량 삭제로 보지 않는다', () => {
    const c = classifyMigration(`
      CREATE TABLE IF NOT EXISTS t (id INT);
      DELETE FROM t WHERE id IS NULL;
    `);
    // 대량 삭제는 아니지만 '더하기'도 아니다 → 자동 적용 대상은 아니다
    assert(c.risk !== 'DESTRUCTIVE', `DESTRUCTIVE가 아니어야 한다: ${c.reasons.join(', ')}`);
    eq(c.autoApply, false);
  });

  test('TRUNCATE는 자동 적용하지 않는다', () => {
    eq(classifyMigration('TRUNCATE ledger_events;').risk, 'DESTRUCTIVE');
  });

  // ── 3. 주석·문자열 속 단어로 판정하지 않는다 ──

  test('주석에 DROP TABLE이라고 써 있다고 위험으로 보지 않는다', () => {
    const c = classifyMigration(`
      -- 이 표는 절대 DROP TABLE 하지 않는다
      /* DROP TABLE ledger_events; 라고 쓰면 안 된다 */
      CREATE TABLE IF NOT EXISTS t (id INT);
    `);
    eq(c.risk, 'ADDITIVE');
  });

  test('문자열 안의 TRUNCATE는 판정에 쓰지 않는다', () => {
    const c = classifyMigration(`
      CREATE TABLE IF NOT EXISTS t (id INT);
      COMMENT ON TABLE t IS 'TRUNCATE 금지';
    `);
    eq(c.risk, 'ADDITIVE');
  });

  // ── 4. 모르면 멈춘다 ──

  test('알아보지 못한 문장이 있으면 UNKNOWN이고 자동 적용하지 않는다', () => {
    const c = classifyMigration('CREATE TABLE t (id INT); VACUUM FULL t;');
    eq(c.risk, 'UNKNOWN');
    eq(c.autoApply, false);
  });

  test('빈 파일을 안전으로 읽지 않는다', () => {
    eq(classifyMigration('   \n -- 아무것도 없음 \n').risk, 'UNKNOWN');
    eq(classifyMigration('').autoApply, false);
  });

  // ── 5. 파일 번호 ──

  test('파일 이름 앞 숫자를 순서로 읽는다', () => {
    eq(migrationIdOf('056_ledger_events.sql'), 56);
    eq(migrationIdOf('001_init.sql'), 1);
    eq(migrationIdOf('ledger.sql'), null);
  });

  // ── 6. 계획 ──

  test('적용 기록을 못 읽으면 UNKNOWN이고 아무것도 실행하지 않는다', () => {
    const plan = migrationPlanOf({ files: [file('056_a.sql', ADDITIVE_SQL)], applied: null });
    eq(plan.code, 'UNKNOWN');
    eq(plan.autoApply.length, 0);
    // **"기록 없음"을 "전부 적용됨"으로 읽으면 이미 적용된 것을 다시 돌린다**
    assert(plan.code !== 'UP_TO_DATE', '못 읽은 것을 최신으로 보면 안 된다');
  });

  test('이미 적용된 것은 다시 실행하지 않는다', () => {
    const plan = migrationPlanOf({
      files: [file('055_a.sql', ADDITIVE_SQL), file('056_b.sql', ADDITIVE_SQL)],
      applied: ['055_a.sql'],
    });
    eq(plan.code, 'READY');
    eq(plan.autoApply.join(','), '056_b.sql');
    eq(plan.applied.join(','), '055_a.sql');
  });

  test('전부 적용돼 있으면 UP_TO_DATE', () => {
    const plan = migrationPlanOf({
      files: [file('056_b.sql', ADDITIVE_SQL)], applied: ['056_b.sql'],
    });
    eq(plan.code, 'UP_TO_DATE');
    eq(plan.pending.length, 0);
  });

  test('위험한 파일이 있으면 NEEDS_APPROVAL이고 그 파일은 자동 목록에 없다', () => {
    const plan = migrationPlanOf({
      files: [file('057_drop.sql', 'DROP TABLE t;')], applied: [],
    });
    eq(plan.code, 'NEEDS_APPROVAL');
    eq(plan.autoApply.length, 0);
    eq(plan.blocked[0].name, '057_drop.sql');
    eq(plan.blocked[0].risk, 'DESTRUCTIVE');
  });

  test('막힌 파일 뒤엣것을 건너뛰고 먼저 적용하지 않는다', () => {
    const plan = migrationPlanOf({
      files: [
        file('057_safe.sql', ADDITIVE_SQL),
        file('058_drop.sql', 'DROP TABLE t;'),
        file('059_safe.sql', ADDITIVE_SQL),
      ],
      applied: [],
    });
    eq(plan.code, 'NEEDS_APPROVAL');
    // 057은 058보다 앞이라 적용한다. **059는 순서를 건너뛰므로 적용하지 않는다**
    eq(plan.autoApply.join(','), '057_safe.sql');
  });

  test('번호가 없는 파일은 순서를 정할 수 없으므로 막는다', () => {
    const plan = migrationPlanOf({ files: [file('ledger.sql', ADDITIVE_SQL)], applied: [] });
    eq(plan.code, 'NEEDS_APPROVAL');
    eq(plan.blocked[0].risk, 'UNKNOWN');
  });

  test('파일 순서는 번호 순으로 정렬한다 — 디렉터리 순서를 믿지 않는다', () => {
    const plan = migrationPlanOf({
      files: [file('058_c.sql', ADDITIVE_SQL), file('056_a.sql', ADDITIVE_SQL), file('057_b.sql', ADDITIVE_SQL)],
      applied: [],
    });
    eq(plan.autoApply.join(','), '056_a.sql,057_b.sql,058_c.sql');
  });

  // ── 7. 진입 차단 ──

  test('적용 안 된 마이그레이션이 있으면 새 주문을 막는다', () => {
    const plan = migrationPlanOf({ files: [file('056_a.sql', ADDITIVE_SQL)], applied: [] });
    const gate = migrationEntryGate(plan);
    eq(gate.allowed, false);
    eq(gate.code, 'MIGRATION_PENDING');
  });

  test('적용 상태를 모르면 통과가 아니다', () => {
    eq(migrationEntryGate(null).allowed, false);
    eq(migrationEntryGate(migrationPlanOf({ files: [], applied: null })).code, 'MIGRATION_UNKNOWN');
  });

  test('전부 적용돼 있을 때만 통과한다', () => {
    const plan = migrationPlanOf({ files: [file('056_a.sql', ADDITIVE_SQL)], applied: ['056_a.sql'] });
    eq(migrationEntryGate(plan).allowed, true);
  });

  // ── 8. 실제 저장소 파일로 확인 ──

  test('056(장부 표)은 자동 적용 대상이다 — 표를 더하기만 한다', () => {
    // 실제 056의 뼈대. 이 파일이 자동 적용 대상이 아니면 자동화의 의미가 없다.
    const c = classifyMigration(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        idempotency_key TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_idem_idx ON ledger_events (idempotency_key);
      ALTER TABLE ledger_events ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        CREATE POLICY ledger_events_own ON ledger_events FOR SELECT USING (auth.uid() = user_id);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    eq(c.risk, 'ADDITIVE');
    eq(c.autoApply, true);
  });

  // ── 9. 적용 뒤 검증 대상 ──

  test('만들어야 할 표·인덱스·칸·정책을 뽑아낸다', () => {
    const t = migrationTargets(`
      CREATE TABLE IF NOT EXISTS public.ledger_events (id UUID);
      CREATE UNIQUE INDEX IF NOT EXISTS ledger_idem_idx ON ledger_events (idempotency_key);
      ALTER TABLE live_orders ADD COLUMN IF NOT EXISTS sl_order_id TEXT;
      CREATE POLICY ledger_own ON ledger_events FOR SELECT USING (true);
    `);
    eq(t.length, 4);
    eq(t.find(x => x.kind === 'table')!.name, 'ledger_events');   // public. 이 벗겨진다
    eq(t.find(x => x.kind === 'index')!.name, 'ledger_idem_idx');
    eq(t.find(x => x.kind === 'column')!.table, 'live_orders');
    eq(t.find(x => x.kind === 'column')!.name, 'sl_order_id');
    eq(t.find(x => x.kind === 'policy')!.name, 'ledger_own');
  });

  test('주석 속 CREATE TABLE로 검증 대상을 만들지 않는다', () => {
    // **없는 것을 찾다가 멀쩡한 적용을 실패로 적으면 안 된다**
    eq(migrationTargets('-- CREATE TABLE ghost (id INT);\nCREATE TABLE real (id INT);').length, 1);
  });

  test('같은 표를 두 번 만들어도 검증 대상은 하나다', () => {
    eq(migrationTargets('CREATE TABLE t (id INT); CREATE TABLE IF NOT EXISTS t (id INT);').length, 1);
  });

  // ── 10. 적용된 파일이 나중에 바뀐 경우 ──

  const csum = (f: any) => `sum:${f.sql.length}`;

  test('적용된 뒤 파일이 바뀌면 알린다 — 다시 실행하지는 않는다', () => {
    const f = file('056_a.sql', ADDITIVE_SQL);
    const d = migrationDrift({
      files: [f],
      rows: [{ name: '056_a.sql', checksum: 'sum:999999', success: true }],
      checksumOf: csum,
    });
    eq(d.length, 1);
    eq(d[0].code, 'CHECKSUM_CHANGED');
  });

  test('같은 내용이면 어긋남이 없다', () => {
    const f = file('056_a.sql', ADDITIVE_SQL);
    eq(migrationDrift({ files: [f], rows: [{ name: '056_a.sql', checksum: csum(f), success: true }], checksumOf: csum }).length, 0);
  });

  test('지난번 적용이 실패로 남아 있으면 그대로 알린다', () => {
    const f = file('056_a.sql', ADDITIVE_SQL);
    const d = migrationDrift({ files: [f], rows: [{ name: '056_a.sql', checksum: csum(f), success: false }], checksumOf: csum });
    eq(d[0].code, 'FAILED_BEFORE');
  });

  test('기록에 체크섬이 없으면 어긋남으로 보지 않는다 — 옛 기록을 고장으로 만들지 않는다', () => {
    const f = file('056_a.sql', ADDITIVE_SQL);
    eq(migrationDrift({ files: [f], rows: [{ name: '056_a.sql', checksum: null, success: true }], checksumOf: csum }).length, 0);
  });

  // ── 11. backfill과 덮어쓰기를 가른다 ──

  test('조건 없는 UPDATE는 자동 적용하지 않는다 — 모든 줄을 덮어쓴다', () => {
    const c = classifyMigration("UPDATE profiles SET role = 'user';");
    eq(c.risk, 'DESTRUCTIVE');
    eq(c.autoApply, false);
  });

  test('조건이 붙은 backfill은 자동 적용한다 — 새 칸을 채우는 정상 경로다', () => {
    const c = classifyMigration(`
      ALTER TABLE autotrade_schedules ADD COLUMN IF NOT EXISTS strategy_id TEXT;
      UPDATE autotrade_schedules SET strategy_id = 'my-original-v1' WHERE strategy_id IS NULL;
    `);
    eq(c.risk, 'ADDITIVE');
    eq(c.autoApply, true);
  });

  test('뒤 문장의 WHERE가 앞 문장의 DELETE를 안전해 보이게 만들지 않는다', () => {
    // **파일 전체를 한 덩어리로 보면 이게 통과한다.** 문장 단위로 본다.
    const c = classifyMigration("DELETE FROM positions; SELECT 1 FROM t WHERE id = 1;");
    eq(c.risk, 'DESTRUCTIVE');
  });

  test('제약을 지웠다 다시 거는 것은 자동 적용한다 (034가 실제로 그랬다)', () => {
    const c = classifyMigration(`
      ALTER TABLE autotrade_schedules DROP CONSTRAINT IF EXISTS autotrade_sizing_chk;
      ALTER TABLE autotrade_schedules ADD CONSTRAINT autotrade_sizing_chk CHECK (margin_pct > 0);
    `);
    eq(c.risk, 'ADDITIVE');
  });

  test('확장 설치와 트리거 재생성은 자동 적용한다', () => {
    const c = classifyMigration(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DROP TRIGGER IF EXISTS t_touch ON t;
      CREATE TRIGGER t_touch BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION touch();
    `);
    eq(c.risk, 'ADDITIVE');
  });

  test('저장소의 모든 번호 마이그레이션이 자동 적용 대상이어야 한다', () => {
    // 이 시험은 목록이 아니라 **원칙**을 지킨다: 지금까지 쓴 마이그레이션
    // 중 자동으로 못 도는 것이 있으면, 자동화는 절반만 도는 것이다.
    // (실제 파일 검사는 scripts/check-migrations.mjs가 CI에서 한다)
    const c = classifyMigration(`
      CREATE TABLE IF NOT EXISTS t (id INT);
      ALTER TABLE t ALTER COLUMN id SET DEFAULT 0;
      ALTER TABLE t ALTER COLUMN id SET NOT NULL;
      GRANT SELECT ON t TO authenticated;
      REVOKE ALL ON FUNCTION f() FROM public;
    `);
    eq(c.risk, 'ADDITIVE');
  });
}
