// src/lib/system/migrationAdoption.test.ts
//
// **"이미 있으니 실행 안 해도 된다"가 "승인 안 받아도 된다"가 되지 않게.**
//
// 무슨 일이 있었나
// ────────────────
// `migrate` run 34661664896에서 같은 head인데 판단이 뒤집혔다:
//
//   --check   남음 2 / 승인 필요 2 → NEEDS_APPROVAL
//               ⛔ 081 UNKNOWN · ⛔ 082 DESTRUCTIVE
//   --apply   이미 적용돼 있던 2개를 실행 없이 기록 → UP_TO_DATE
//
// 채택(adopt)이 위험도 분류보다 **먼저** 돌았다. 채택된 파일은 `blocked`에
// 들어갈 기회 자체가 없어서, 승인이 필요한 둘이 BASELINE으로 적혔다.
// 그 뒤로 runner는 영원히 "적용됨"이라고 믿는다.
//
// 여기서 고정하는 것은 방향이 반대인 둘이다:
//
//   1. 더하기만 하는 legacy 파일의 **검증된 채택은 그대로 살아 있어야 한다**
//      (안 그러면 손으로 적용해 둔 53개를 전부 다시 실행한다)
//   2. 승인이 필요한 것은 **한 번도** 채택으로 새어 나가면 안 된다
//
// 2번은 "혹시 몰라서" 쪽으로 기운다.

import { test, eq, assert } from '../../test/harness';
import { adoptionVerdictOf, adoptionCandidates, migrationPlanOf, classifyMigration } from './migrationPlan';

// 더하기만 한다 — legacy 표/인덱스를 만드는 전형적 모양
const ADDITIVE_SQL = `
CREATE TABLE IF NOT EXISTS worker_lock (
  id TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_worker_lock_at ON worker_lock (locked_at);
`;

// 지운다 — 082가 옛 시그니처를 없애는 것과 같은 모양
const DESTRUCTIVE_FN_SQL = `
DROP FUNCTION IF EXISTS public.paper_open_position(UUID, TEXT);
CREATE OR REPLACE FUNCTION public.paper_open_position(
  p_user_id UUID, p_signal_id TEXT, p_paper_account_id UUID DEFAULT NULL
) RETURNS TABLE(status TEXT, position_id UUID) LANGUAGE plpgsql AS $$
BEGIN RETURN QUERY SELECT 'OK'::TEXT, NULL::UUID; END $$;
`;

// 알아보지 못한 문장이 섞였다 — 081이 기본키를 옮기는 것과 같은 모양
const UNKNOWN_DO_SQL = `
ALTER TABLE public.paper_accounts ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.paper_accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
DO $$
DECLARE v_pk TEXT;
BEGIN
  SELECT conname INTO v_pk FROM pg_constraint
   WHERE conrelid = 'public.paper_accounts'::regclass AND contype = 'p';
  IF v_pk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.paper_accounts DROP CONSTRAINT %I', v_pk);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS paper_accounts_one_default_per_user
  ON public.paper_accounts (user_id) WHERE is_default;
`;

// 함수만 만든다. 지우지 않으므로 위험도는 통과한다 — 그래도 채택하면 안 된다.
const ADDITIVE_FN_ONLY_SQL = `
CREATE OR REPLACE FUNCTION public.paper_default_account_id(p_user_id UUID)
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT id FROM public.paper_accounts WHERE user_id = p_user_id AND is_default LIMIT 1;
$$;
`;

export function runMigrationAdoptionTests() {
  // ── 1. 옛 함수 이름은 있는데 새 시그니처는 없다 + DESTRUCTIVE ──
  //
  // 082가 정확히 이 모양이다. 카탈로그에는 `paper_open_position`이 이미
  // 있으므로 **이름만 보면 "있다"**가 나온다. 그걸로 채택하면 승인 없이
  // BASELINE이 된다.
  test('지우는 마이그레이션은 같은 이름의 옛 함수가 있어도 채택하지 않는다', () => {
    const v = adoptionVerdictOf({ name: '082_paper_rpc_account_id.sql', id: 82, sql: DESTRUCTIVE_FN_SQL });
    eq(v.adoptable, false, '지우는 파일은 채택 대상이 아니다');
    eq(v.code, 'BLOCKED_RISK', '막힌 이유는 위험도여야 한다');
    eq(v.risk, 'DESTRUCTIVE');
    // 위험도 분류가 채택보다 **먼저** 왔다는 증거 — 같은 판정을 쓴다
    eq(classifyMigration(DESTRUCTIVE_FN_SQL).autoApply, false);
  });

  // ── 2. UNKNOWN인데 대상 이름이 전부 카탈로그에 있다 ──
  //
  // 081이 이 모양이다. 칸 두 개와 인덱스 하나는 이름으로 확인되지만,
  // `DO $$ ... EXECUTE format(...)`은 무엇을 하는지 읽지 못한다.
  test('알아보지 못한 문장이 있으면 대상이 다 있어도 채택하지 않는다', () => {
    const v = adoptionVerdictOf({ name: '081_paper_account_identity.sql', id: 81, sql: UNKNOWN_DO_SQL });
    eq(v.adoptable, false, '읽지 못한 문장이 있으면 채택하지 않는다');
    eq(v.code, 'BLOCKED_RISK');
    eq(v.risk, 'UNKNOWN');
  });

  // ── 3. 안전한 ADDITIVE legacy는 채택이 그대로 살아 있어야 한다 ──
  //
  // 이 시험이 없으면 2번을 고치면서 채택을 통째로 없애 버릴 수 있다.
  // 그러면 손으로 적용해 둔 것들을 전부 다시 실행한다.
  test('더하기만 하는 마이그레이션의 채택은 그대로 가능하다', () => {
    const v = adoptionVerdictOf({ name: '900_worker_lock.sql', id: 900, sql: ADDITIVE_SQL });
    eq(v.adoptable, true, 'ADDITIVE는 채택 가능해야 한다');
    eq(v.code, 'ADOPTABLE');
    eq(v.risk, 'ADDITIVE');
  });

  // ── 4. 함수는 이름만으로 같다고 말할 수 없다 ──
  //
  // 지우지 않으므로 위험도는 통과한다. 그래도 채택하면 안 된다 —
  // 같은 이름의 함수가 있어도 시그니처도 본문도 확인되지 않는다.
  test('함수를 만드는 파일은 위험도를 통과해도 채택하지 않는다', () => {
    const v = adoptionVerdictOf({ name: '901_default_account_fn.sql', id: 901, sql: ADDITIVE_FN_ONLY_SQL });
    eq(classifyMigration(ADDITIVE_FN_ONLY_SQL).autoApply, true, '전제: 위험도는 통과한다');
    eq(v.adoptable, false, '함수는 이름만으로 채택하지 않는다');
    eq(v.code, 'FUNCTION_TARGET');
  });

  // ── 5. 번호 없는 legacy는 채택으로 우회되지 않는다 ──
  test('번호가 없으면 채택하지 않는다', () => {
    const v = adoptionVerdictOf({ name: 'kill_switch.sql', id: null, sql: ADDITIVE_SQL });
    eq(v.adoptable, false);
    eq(v.code, 'BLOCKED_RISK');
  });

  // ── 6. 물어볼 대상이 없으면 증거도 없다 ──
  test('확인할 대상이 없으면 채택하지 않는다', () => {
    const v = adoptionVerdictOf({ name: '902_comment_only.sql', id: 902, sql: 'COMMENT ON TABLE jobs IS \'설명\';' });
    eq(v.adoptable, false);
    eq(v.code, 'NO_TARGET');
  });

  // ── 7. **거짓 초록 재현을 테스트로 고정한다** ──
  //
  // 실제로 일어난 일을 그대로 세운다: 081·082가 아직 기록에 없고, 카탈로그에는
  // 대상 이름이 전부 있다. 옛 코드였다면 둘 다 채택돼 UP_TO_DATE가 됐다.
  //
  // 여기서 확인하는 것은 두 가지다:
  //   · 계획은 NEEDS_APPROVAL이다 (둘 다 blocked)
  //   · **그 둘 중 어느 것도 채택 자격이 없다** — 그래서 --apply가
  //     UP_TO_DATE로 뒤집힐 수 없다
  test('재현: check가 NEEDS_APPROVAL이면 apply가 UP_TO_DATE로 뒤집히지 않는다', () => {
    const files = [
      { name: '080_prev.sql', id: 80, sql: ADDITIVE_SQL },
      { name: '081_paper_account_identity.sql', id: 81, sql: UNKNOWN_DO_SQL },
      { name: '082_paper_rpc_account_id.sql', id: 82, sql: DESTRUCTIVE_FN_SQL },
    ];
    // 080만 기록돼 있다 — 081/082는 "남음"이다
    const plan = migrationPlanOf({ files, applied: ['080_prev.sql'] });
    eq(plan.code, 'NEEDS_APPROVAL', 'check 쪽 판정');
    eq(plan.blocked.length, 2, '081·082 둘 다 막혀야 한다');

    // 막힌 것 중 채택 자격이 있는 것이 하나라도 있으면 뒤집힐 수 있다.
    const leaked = plan.blocked.filter(b => {
      const f = files.find(x => x.name === b.name)!;
      return adoptionVerdictOf(f).adoptable;
    });
    eq(leaked.length, 0, `승인이 필요한데 채택 가능한 파일: ${leaked.map(x => x.name).join(', ')}`);

    // 그리고 그 이유가 "대상이 없어서"가 아니라 **위험도** 때문이어야 한다.
    for (const b of plan.blocked) {
      const f = files.find(x => x.name === b.name)!;
      eq(adoptionVerdictOf(f).code, 'BLOCKED_RISK', `${b.name}은 위험도로 막혀야 한다`);
    }
  });

  // ── 8. 막힌 파일은 어떤 위험도든 채택되지 않는다 (전수) ──
  //
  // 7번은 구체적 두 파일이다. 여기서는 성질로 고정한다: **계획이 막은 것은
  // 전부 채택 불가**. 나중에 새 위험 유형이 생겨도 이 성질이 유지돼야 한다.
  test('계획이 막은 파일은 전부 채택 불가다', () => {
    const files = [
      { name: '100_add.sql', id: 100, sql: ADDITIVE_SQL },
      { name: '101_drop.sql', id: 101, sql: DESTRUCTIVE_FN_SQL },
      { name: '102_unknown.sql', id: 102, sql: UNKNOWN_DO_SQL },
      { name: '103_fn.sql', id: 103, sql: ADDITIVE_FN_ONLY_SQL },
      { name: 'legacy.sql', id: null, sql: ADDITIVE_SQL },
    ];
    const plan = migrationPlanOf({ files, applied: [] });
    assert(plan.blocked.length > 0, '전제: 막힌 것이 있어야 한다');
    for (const b of plan.blocked) {
      const f = files.find(x => x.name === b.name)!;
      eq(adoptionVerdictOf(f).adoptable, false, `${b.name}이 채택 가능하면 승인이 우회된다`);
    }
    // 그리고 안전한 것은 여전히 채택 가능해야 한다 — 한쪽으로만 기울지 않는다
    eq(adoptionVerdictOf(files[0]).adoptable, true, 'ADDITIVE는 살아 있어야 한다');
  });

  // ── 9. 목록에는 막힌 것이 한 건도 담기지 않는다 ──
  //
  // runner는 이 목록만 돈다. 자리마다 거르는 가드는 **한 줄만 무력화해도
  // 뚫린다** — 실제로 돌연변이 `if (false && !a.adoptable)`에 시험도 검사기도
  // 초록이었다. 그래서 거르는 곳을 목록 생성으로 옮겼고, 여기서 그 목록을
  // 직접 검사한다.
  test('채택 후보 목록에 승인이 필요한 파일이 담기지 않는다', () => {
    const files = [
      { name: '100_add.sql', id: 100, sql: ADDITIVE_SQL },
      { name: '101_drop.sql', id: 101, sql: DESTRUCTIVE_FN_SQL },
      { name: '102_unknown.sql', id: 102, sql: UNKNOWN_DO_SQL },
      { name: '103_fn.sql', id: 103, sql: ADDITIVE_FN_ONLY_SQL },
      { name: 'legacy.sql', id: null, sql: ADDITIVE_SQL },
    ];
    const { adopt, refused } = adoptionCandidates({ files, applied: [] });
    eq(adopt.length, 1, '채택 후보는 ADDITIVE 하나뿐이어야 한다');
    eq(adopt[0].name, '100_add.sql');
    eq(refused.length, 4, '나머지는 이유와 함께 거절돼야 한다');
    assert(refused.every(r => r.reason.length > 0), '거절에는 이유가 있어야 한다');
  });

  test('이미 기록된 파일은 채택 후보가 아니다', () => {
    const files = [{ name: '100_add.sql', id: 100, sql: ADDITIVE_SQL }];
    const { adopt, refused } = adoptionCandidates({ files, applied: ['100_add.sql'] });
    eq(adopt.length, 0, '기록이 있으면 채택할 것이 없다');
    eq(refused.length, 0, '거절도 아니다 — 그냥 해당 없음이다');
  });

  // **기록을 못 읽었으면 채택하지 않는다.** 무엇이 이미 있는지 모르는 채로
  // "실행 안 해도 된다"를 적는 것은 근거 없는 기록이다.
  test('적용 기록을 못 읽으면 아무것도 채택하지 않는다', () => {
    const files = [{ name: '100_add.sql', id: 100, sql: ADDITIVE_SQL }];
    const { adopt, refused } = adoptionCandidates({ files, applied: null });
    eq(adopt.length, 0);
    eq(refused.length, 1);
  });

  // ── 10. 채택은 "자동 적용 대상"의 부분집합이다 ──
  //
  // 채택이 자동 적용보다 넓으면, 자동 적용이 막는 것을 채택이 통과시킨다.
  test('채택 가능한 파일은 반드시 자동 적용 대상이기도 하다', () => {
    const cases = [ADDITIVE_SQL, DESTRUCTIVE_FN_SQL, UNKNOWN_DO_SQL, ADDITIVE_FN_ONLY_SQL];
    for (const sql of cases) {
      const v = adoptionVerdictOf({ id: 1, sql });
      if (v.adoptable) {
        eq(classifyMigration(sql).autoApply, true,
          '채택 가능한데 자동 적용 대상이 아니면 승인이 우회된다');
      }
    }
  });
}
