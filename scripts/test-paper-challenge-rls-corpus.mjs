// scripts/test-paper-challenge-rls-corpus.mjs
//
// **083 한 장만 읽으면 나중 파일이 챌린지 표를 다시 열어도 보이지 않는다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나 (기준 main ed00c1a4, fixture로 돌려서 얻은 값)
// ─────────────────────────────────────────────────────────────
// `check-paper-challenge-core.mjs`의 ⑦ RLS 판정은 `083_paper_challenge_core.sql`
// 한 장만 읽는다. 198 한 장을 더하자 **여섯 가지가 모두 통과(rc=0)했다**:
//
//   authenticated 에 전체 읽기를 연다        rc=0  구멍
//   authenticated 에 쓰기를 연다             rc=0  구멍
//   소유자 정책을 지운다                      rc=0  구멍
//   RLS 를 끈다                              rc=0  구멍
//   cashflows 를 anon 에 연다                rc=0  구멍
//   TO 절 없이 정책을 만든다                   rc=0  구멍
//
// 대조로 `083`의 소유자 정책을 지우면 rc=1이 났다 — fixture가 검사기에
// 실제로 닿는다는 증거다. (처음 만든 탐침은 이 검사기의 `root`가
// `import.meta.url/..`라서 fixture 대신 실제 저장소를 읽었고, 대조와 변이가
// 구분되지 않아 **무효**였다. 검사기 파일을 진짜 복사본으로 두고 다시 쟀다.)
//
// ★ RLS 정책은 **OR로 합쳐진다.** 소유자 정책이 그대로 있어도
//   `USING (true)` 한 줄이 더 생기면 격리가 사라진다. "소유자 정책이
//   있는가"만 보는 판정은 그것을 통과시킨다.
//
// ★ PostgreSQL에서 `CREATE POLICY`에 `TO` 절을 적지 않으면 그 정책은
//   **PUBLIC**이고 모든 role에 걸린다. role 이름을 낱말로 찾는 판정은
//   그 정책을 통과시킨다.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  checkTableAccessIntent, policyStatements, dropPolicyStatements, rlsToggles,
} from './lib/migration-policy.mjs';

const root = new URL('../', import.meta.url);
const MIGD = new URL('supabase/migrations/', root);

const T = 'public.paper_challenges';
const C = 'public.paper_challenge_cashflows';

/** 검사기가 넘기는 것과 같은 의도 */
const INTENT = {
  tables: ['paper_challenges', 'paper_challenge_cashflows', 'paper_challenge_transitions'],
  allow: [
    { cmd: 'ALL', roles: ['service_role'] },
    { cmd: 'SELECT', roles: ['authenticated'], using: /user_id\s*=\s*auth\.uid\(\)/i },
  ],
};

const realFiles = () => readdirSync(MIGD).filter(n => n.endsWith('.sql')).sort()
  .map(n => ({ name: n, sql: readFileSync(new URL(n, MIGD), 'utf8') }));

const withLate = (sql, name = '198_probe.sql') => [...realFiles(), { name, sql }];
const judge = (sql) => checkTableAccessIntent(withLate(sql), INTENT);

// ── 대조 — 지금 저장소는 통과한다 ────────────────────────────────
test('대조 — 지금 저장소의 마이그레이션 전수는 통과한다', () => {
  const v = checkTableAccessIntent(realFiles(), INTENT);
  assert.equal(v.ok, true, `지금 트리가 막히면 검사기가 거짓말을 한다: ${v.code} ${v.reason}`);
});

// ── ★ 나중 파일이 되돌리는 여섯 가지 ───────────────────────────
test('★ 나중 파일이 authenticated 에 전체 읽기를 열면 막는다', () => {
  const v = judge(`CREATE POLICY pc_open ON ${T} FOR SELECT TO authenticated USING (true);`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  assert.match(v.reason, /198_probe\.sql/);
  assert.match(v.reason, /OR로 합쳐지/);
});

test('★ 나중 파일이 authenticated 에 쓰기를 열면 막는다', () => {
  const v = judge(`CREATE POLICY pc_rw ON ${T} FOR ALL TO authenticated USING (true) WITH CHECK (true);`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
});

test('★ 나중 파일이 소유자 정책을 지우면 막는다', () => {
  const v = judge(`DROP POLICY paper_challenges_owner ON ${T};`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_DROPPED');
});

test('★ 나중 파일이 RLS 를 끄면 막는다', () => {
  const v = judge(`ALTER TABLE ${T} DISABLE ROW LEVEL SECURITY;`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'RLS_DISABLED');
  assert.match(v.reason, /정책이 남아 있어도/);
});

test('★ 나중 파일이 anon 에 열면 막는다', () => {
  const v = judge(`CREATE POLICY pcc_anon ON ${C} FOR SELECT TO anon USING (true);`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  assert.match(v.reason, /anon/);
});

test('★ TO 절이 없는 정책은 PUBLIC 으로 읽어 막는다', () => {
  const v = judge(`CREATE POLICY pcc_noto ON ${C} FOR SELECT USING (true);`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_PUBLIC');
  assert.match(v.reason, /PUBLIC/);
});

test('★ FOR 를 적지 않은 정책은 ALL 로 읽는다', () => {
  // PostgreSQL에서 FOR를 생략하면 ALL이다 — SELECT로 읽으면 쓰기가 통과한다
  const v = judge(`CREATE POLICY pc_noform ON ${T} TO authenticated USING (true);`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  assert.match(v.reason, /FOR ALL/);
});

test('★ DO 블록 안에 숨은 정책도 본다', () => {
  const v = judge(`DO $$ BEGIN CREATE POLICY pc_hidden ON ${T} FOR SELECT TO anon USING (true); END $$;`);
  assert.equal(v.ok, false, 'DO 블록 안이면 문장 처음이 아니다 — 그래도 봐야 한다');
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
});

// ── 대조 — 지나치게 잡지 않는가 ─────────────────────────────────
test('대조 — service_role 정책을 더하는 것은 통과한다', () => {
  const v = judge(`CREATE POLICY pc_svc2 ON ${T} FOR ALL TO service_role USING (true) WITH CHECK (true);`);
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 본인 행만 읽는 정책을 더하는 것은 통과한다', () => {
  const v = judge(`CREATE POLICY pc_owner2 ON ${T} FOR SELECT TO authenticated USING (user_id = auth.uid());`);
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 지키지 않는 표는 건드리지 않는다', () => {
  const v = judge('CREATE POLICY other_open ON public.some_other_table FOR ALL TO anon USING (true);\n'
    + 'ALTER TABLE public.some_other_table DISABLE ROW LEVEL SECURITY;\n'
    + 'DROP POLICY whatever ON public.some_other_table;');
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 지우고 같은 이름을 다시 만드는 꼴은 통과한다 (083 의 재적용 패턴)', () => {
  const v = judge(`DROP POLICY IF EXISTS paper_challenges_owner ON ${T};\n`
    + `CREATE POLICY paper_challenges_owner ON ${T} FOR SELECT TO authenticated USING (user_id = auth.uid());`);
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 주석 안의 정책·DROP·RLS 는 읽지 않는다', () => {
  const v = judge(`-- CREATE POLICY pc_open ON ${T} FOR SELECT TO anon USING (true);\n`
    + `/* DROP POLICY paper_challenges_owner ON ${T};\n`
    + `   ALTER TABLE ${T} DISABLE ROW LEVEL SECURITY; */\n`);
  assert.equal(v.ok, true, `주석을 코드로 읽으면 반대쪽 거짓말이다: ${v.reason}`);
});

test('대조 — USING 식 안의 TO 는 role 이 아니다', () => {
  const v = judge(`CREATE POLICY pc_using ON ${T} FOR ALL TO service_role`
    + " USING (note = 'TO anon') WITH CHECK (true);");
  assert.equal(v.ok, true, v.reason);
});

test('대조 — RLS 를 다시 켜는 문장은 막지 않는다', () => {
  const v = judge(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY;`);
  assert.equal(v.ok, true, v.reason);
});

// ── 빈 의도를 통과로 적지 않는가 ────────────────────────────────
test('빈 의도는 전부 통과시키지 않고 막는다', () => {
  for (const bad of [{}, { tables: [], allow: [] }, { tables: ['paper_challenges'], allow: [] }]) {
    const v = checkTableAccessIntent(realFiles(), bad);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'INTENT_EMPTY');
  }
});

// ── 읽은 모양이 맞는가 ──────────────────────────────────────────
test('policyStatements가 이름·표·명령·role·USING을 읽는다', () => {
  const got = policyStatements(
    `DO $$ BEGIN\n  CREATE POLICY paper_challenges_owner\n    ON ${T}\n`
    + '    FOR SELECT TO authenticated USING (user_id = auth.uid());\nEND $$;');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'paper_challenges_owner');
  assert.equal(got[0].table, T);
  assert.equal(got[0].cmd, 'SELECT');
  assert.deepEqual([...got[0].roles], ['authenticated']);
  assert.match(got[0].using, /auth\.uid\(\)/);
});

test('dropPolicyStatements가 IF EXISTS 를 건너뛰고 이름을 읽는다', () => {
  const got = dropPolicyStatements(`DROP POLICY IF EXISTS paper_challenges_owner ON ${T};`);
  assert.equal(got[0].name, 'paper_challenges_owner');
  assert.equal(got[0].table, T);
});

test('rlsToggles가 켜기와 끄기를 구분한다', () => {
  const got = rlsToggles(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY;\n`
    + `ALTER TABLE paper_challenge_cashflows DISABLE ROW LEVEL SECURITY;`);
  assert.equal(got.length, 2);
  assert.equal(got[0].on, true);
  assert.equal(got[1].on, false);
  // 스키마를 적지 않으면 public 으로 읽는다
  assert.equal(got[1].table, C);
});
