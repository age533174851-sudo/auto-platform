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
  checkTableAccessIntent, policyStatements, dropPolicyStatements, rlsToggles, canonicalExpr,
  alterPolicyStatements,
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
    { cmd: 'SELECT', roles: ['authenticated'],
      using: ['user_id = auth.uid()', 'auth.uid() = user_id'] },
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

// ── 인용 식별자 (Codex가 #828의 같은 판정에서 찾은 구멍) ───────────
//
// 표를 `("?[\w$.]+"?)`로 읽으면 `"public"."paper_challenges"`에서 `"public"`만
// 집어 **`public.public`**이 됐고, 그 이름은 지키는 목록에 없으므로 통과했다.
// `DROP POLICY`·`ALTER TABLE … DISABLE` 쪽도 같은 패턴을 썼다.
const REFS = [
  ['스키마·표 모두 인용', '"public"."paper_challenges"'],
  ['표만 인용', '"paper_challenges"'],
  ['스키마만 인용', '"public".paper_challenges'],
  ['점 주위에 공백', 'public . paper_challenges'],
];

for (const [how, ref] of REFS) {
  test(`★ 인용 표기 — ${how} · 정책을 PUBLIC 에 열면 막는다`, () => {
    const v = judge(`CREATE POLICY pc_open ON ${ref} FOR SELECT TO PUBLIC USING (true);`);
    assert.equal(v.ok, false, `${ref} 를 다른 표로 읽으면 통과한다`);
    assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  });

  test(`★ 인용 표기 — ${how} · RLS 를 끄면 막는다`, () => {
    const v = judge(`ALTER TABLE ${ref} DISABLE ROW LEVEL SECURITY;`);
    assert.equal(v.ok, false, `${ref} 를 다른 표로 읽으면 통과한다`);
    assert.equal(v.code, 'RLS_DISABLED');
  });

  test(`★ 인용 표기 — ${how} · 소유자 정책을 지우면 막는다`, () => {
    const v = judge(`DROP POLICY paper_challenges_owner ON ${ref};`);
    assert.equal(v.ok, false, `${ref} 를 다른 표로 읽으면 통과한다`);
    assert.equal(v.code, 'POLICY_DROPPED');
  });
}

test('★ 인용 표기 — role 도 인용할 수 있다', () => {
  const v = judge('CREATE POLICY pc_q ON "public"."paper_challenges"'
    + ' FOR SELECT TO "anon" USING (true);');
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  assert.match(v.reason, /anon/);
});

test('대조 — 인용한 허용 모양은 통과한다', () => {
  const v = judge('CREATE POLICY pc_q_svc ON "public"."paper_challenges"'
    + ' FOR ALL TO "service_role" USING (true) WITH CHECK (true);\n'
    + 'CREATE POLICY pc_q_own ON "public"."paper_challenge_cashflows"'
    + ' FOR SELECT TO "authenticated" USING (user_id = auth.uid());');
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 인용 표기라도 지키지 않는 표는 건드리지 않는다', () => {
  const v = judge('CREATE POLICY o ON "public"."some_other_table" FOR ALL TO anon USING (true);\n'
    + 'ALTER TABLE "public"."some_other_table" DISABLE ROW LEVEL SECURITY;');
  assert.equal(v.ok, true, v.reason);
});

test('qualifiedName — 네 가지 표기를 같은 이름으로 읽는다', () => {
  const seen = REFS.map(([, ref]) =>
    policyStatements(`CREATE POLICY p ON ${ref} FOR SELECT TO anon USING (true);`)[0].table);
  for (const t of seen) assert.equal(t, T);
  assert.equal(
    rlsToggles('ALTER TABLE "public"."paper_challenges" DISABLE ROW LEVEL SECURITY;')[0].table, T);
  assert.equal(
    dropPolicyStatements('DROP POLICY "pc owner" ON "public"."paper_challenges";')[0].table, T);
});

// ── 소유자 식은 부분일치로 보지 않는다 (Codex 지적) ────────────────
//
// `USING (...)` 안에 소유자 비교가 들어 있는지만 보면 의미를 보증하지
// 못한다. 격리 PostgreSQL 에서 user1·user2 두 행과 `auth.uid() = user1`로
// 실제 `authenticated` role 로 읽은 값이 보고됐다:
//
//   USING (user_id = auth.uid())            읽힌 행 {1}      옳다
//   USING (user_id = auth.uid() OR true)    읽힌 행 {1, 2}   열렸다
//   USING (NOT (user_id = auth.uid()))      읽힌 행 {2}      남의 행만
//
// 셋 다 유효한 정책이고, 고치기 전 판정은 **전부 통과시켰다.**
test('★ USING 에 OR true 를 붙이면 막는다', () => {
  const v = judge(`CREATE POLICY p ON ${T} FOR SELECT TO authenticated`
    + ' USING (user_id = auth.uid() OR true);');
  assert.equal(v.ok, false, '소유자 비교가 들어 있다고 소유자 격리가 되는 것이 아니다');
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  assert.match(v.reason, /부분일치/);
});

test('★ USING 을 NOT 으로 감싸면 막는다 (남의 행만 읽힌다)', () => {
  const v = judge(`CREATE POLICY p ON ${T} FOR SELECT TO authenticated`
    + ' USING (NOT (user_id = auth.uid()));');
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
});

test('★ USING 에 OR 1=1 을 붙이면 막는다', () => {
  const v = judge(`CREATE POLICY p ON ${T} FOR SELECT TO authenticated`
    + ' USING (user_id = auth.uid() OR 1=1);');
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
});

test('★ 모르는 소유자 식은 막는다 (의미를 증명할 수 없으면 통과가 아니다)', () => {
  for (const expr of [
    'user_id IN (SELECT id FROM public.profiles)',
    'user_id = auth.uid() AND true',
    'true',
    "user_id = coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000')",
  ]) {
    const v = judge(`CREATE POLICY p ON ${T} FOR SELECT TO authenticated USING (${expr});`);
    assert.equal(v.ok, false, `모르는 식을 통과시키면 안 된다: ${expr}`);
    assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  }
});

test('대조 — 같은 뜻의 서식 차이는 통과한다', () => {
  for (const expr of [
    'user_id = auth.uid()',
    'auth.uid() = user_id',
    '(user_id = auth.uid())',
    '((user_id = auth.uid()))',
    'user_id\n    =   auth.uid()',
    'USER_ID = AUTH.UID()',
  ]) {
    const v = judge(`CREATE POLICY p ON ${T} FOR SELECT TO authenticated USING (${expr});`);
    assert.equal(v.ok, true, `서식만 다른 식이 막히면 거짓 실패다: ${expr} — ${v.reason}`);
  }
});

test('★ 중첩 괄호를 끊어 읽는다 (정규식으로는 끊긴다)', () => {
  const got = policyStatements(`CREATE POLICY p ON ${T} FOR SELECT TO authenticated`
    + ' USING (NOT (user_id = auth.uid()));');
  assert.equal(got[0].using, 'NOT (user_id = auth.uid())',
    '`\\(([^)]*)\\)` 로 읽으면 첫 `)` 에서 끊겨 식의 일부만 본다');
});

test('policyStatements — USING 과 WITH CHECK 를 따로 읽는다', () => {
  const got = policyStatements(`CREATE POLICY p ON ${T} FOR ALL TO service_role`
    + ' USING (a = 1) WITH CHECK (b = 2);');
  assert.equal(got[0].using, 'a = 1');
  assert.equal(got[0].withCheck, 'b = 2');
});

test('canonicalExpr — 감싼 괄호만 벗기고 가운데 괄호는 건드리지 않는다', () => {
  assert.equal(canonicalExpr('  (( user_id  =  auth.uid() ))  '), 'user_id = auth.uid()');
  assert.equal(canonicalExpr('(a) = (b)'), '(a) = (b)');
  assert.equal(canonicalExpr('(a) AND (b)'), '(a) and (b)');
});

// ── 인용 role 은 대소문자를 보존한다 (Codex 지적 · #828 과 같은 결함) ──
test('★ 인용 대문자 role 은 service_role 이 아니다', () => {
  for (const role of ['"SERVICE_ROLE"', '"Service_Role"']) {
    const v = judge(`CREATE POLICY p ON ${T} FOR ALL TO ${role} USING (true) WITH CHECK (true);`);
    assert.equal(v.ok, false, `${role} 를 service_role 로 읽으면 다른 role 에 돈 표가 열린다`);
    assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
  }
});

test('대조 — 인용하지 않은 role 은 PostgreSQL 규칙대로 접힌다', () => {
  for (const role of ['service_role', 'SERVICE_ROLE', '"service_role"']) {
    const v = judge(`CREATE POLICY p ON ${T} FOR ALL TO ${role} USING (true) WITH CHECK (true);`);
    assert.equal(v.ok, true, `${role} 는 service_role 과 같은 role 이다: ${v.reason}`);
  }
});

test('대조 ★ 표를 찾는 쪽은 대소문자를 무시한다 (막는 쪽으로 틀린다)', () => {
  const v = judge('CREATE POLICY p ON "PUBLIC"."PAPER_CHALLENGES"'
    + ' FOR SELECT TO authenticated USING (true);');
  assert.equal(v.ok, false, '표를 다른 이름으로 읽으면 통과한다');
  assert.equal(v.code, 'POLICY_OUTSIDE_INTENT');
});

// ── ALTER POLICY 를 순회하지 않았다 (Codex 세 번째 지적) ───────────
//
// `CREATE POLICY`·`DROP POLICY`·`ALTER TABLE … RLS` 만 봤으므로 **이미
// 있는 정책을 제자리에서 고치는** 문장이 전혀 보이지 않았다. 경계를
// 되돌리는 가장 자연스러운 방법이 비어 있던 것이다. 고치기 전 측정 —
// 아래 다섯 가지 전부 `ok:true/OK`:
//
//   ALTER POLICY … USING (true)
//   ALTER POLICY … TO PUBLIC USING (true)
//   ALTER POLICY … TO anon
//   ALTER POLICY … RENAME TO …
//   ALTER POLICY <service 정책> … TO authenticated
test('★ ALTER POLICY 로 소유자 식을 열면 막는다', () => {
  const v = judge(`ALTER POLICY paper_challenges_owner ON ${T} USING (true);`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_ALTERED');
});

test('★ ALTER POLICY 로 role 을 바꾸면 막는다', () => {
  for (const tail of ['TO PUBLIC USING (true)', 'TO anon', 'TO authenticated']) {
    const v = judge(`ALTER POLICY paper_challenges_owner ON ${T} ${tail};`);
    assert.equal(v.ok, false, `ALTER POLICY ${tail} 가 보이지 않으면 경계를 되돌릴 수 있다`);
    assert.equal(v.code, 'POLICY_ALTERED');
  }
});

test('★ service 정책의 role 만 바꾸는 줄도 막는다 (합집합 판정으로는 새어 나간다)', () => {
  // `service` 정책은 `FOR ALL` 이다. "허용 목록의 role 합집합 안에 있으면
  // 통과"로 느슨하게 잡으면 이 한 줄이 **authenticated 에게 쓰기를 준다.**
  // 그래서 결과 모양을 따져 보지 않고 전부 막는다.
  const v = judge(`ALTER POLICY paper_challenges_service ON ${T} TO authenticated;`);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_ALTERED');
});

test('★ 소유자 식을 다시 적는 ALTER POLICY 도 막는다 (결과를 알 수 없다)', () => {
  const v = judge(`ALTER POLICY paper_challenges_owner ON ${T} USING (user_id = auth.uid());`);
  assert.equal(v.ok, false, '바꾸지 않은 절이 그대로 남으므로 결과 모양을 알 수 없다');
  assert.equal(v.code, 'POLICY_ALTERED');
  assert.match(v.reason, /지우고 같은 파일에서 다시 만들면/);
});

test('★ ALTER POLICY · 인용 표기도 같은 표로 읽는다', () => {
  const v = judge('ALTER POLICY p ON "public"."paper_challenges" USING (true);');
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_ALTERED');
});

test('대조 — 지키지 않는 표의 ALTER POLICY 는 건드리지 않는다', () => {
  const v = judge('ALTER POLICY p ON public.some_other_table TO anon USING (true);');
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 주석 안의 ALTER POLICY 는 읽지 않는다', () => {
  const v = judge(`-- ALTER POLICY paper_challenges_owner ON ${T} USING (true);\n`
    + `/* ALTER POLICY paper_challenges_owner ON ${T} TO anon; */\n`);
  assert.equal(v.ok, true, `주석을 코드로 읽으면 반대쪽 거짓말이다: ${v.reason}`);
});

test('대조 ★ 지우고 다시 만드는 길은 열려 있다 (약하게 만들지 않고도 길이 있다)', () => {
  const v = judge(`DROP POLICY IF EXISTS paper_challenges_owner ON ${T};\n`
    + `CREATE POLICY paper_challenges_owner ON ${T}`
    + ' FOR SELECT TO authenticated USING (user_id = auth.uid());');
  assert.equal(v.ok, true, `이 길이 막히면 ALTER 금지가 막다른 길이 된다: ${v.reason}`);
});

test('alterPolicyStatements 가 이름과 표를 읽는다', () => {
  const got = alterPolicyStatements(
    'ALTER POLICY "my policy" ON "public"."paper_challenges" USING (true);');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'my policy');
  assert.equal(got[0].table, T);
});

test('대조 — 지금 저장소에는 ALTER POLICY 가 없다', () => {
  const all = realFiles().flatMap(f => alterPolicyStatements(f.sql));
  assert.equal(all.length, 0,
    `ALTER POLICY 가 생기면 이 판정이 막는다 — 생긴 것: ${all.map(a => a.table).join(', ')}`);
});
