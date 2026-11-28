// scripts/test-100x-observation-exposure.mjs
//
// **095만 읽으면 뒤 파일이 다시 열어도 보이지 않는다.**
//
// `node --test scripts/test-*.mjs` (ci.yml의 글롭)에 자동으로 걸린다.
//
// 무엇이 실제로 이랬나 (기준 main ed00c1a4, 돌려서 얻은 값)
// ──────────────────────────────────────────────────────────
// `check-100x-contract.mjs`가 Exact100X 관측 표 두 개를 지키는 방식은
// 세 자리로 나뉘어 있었고, **셋 다 파일 이름을 적어 놓고 그 파일만 읽었다.**
//
//   092+093  RLS가 켜졌는가 · service_role 정책이 있는가 · anon 정책이 없는가
//   094      같은 판정을 escape 표에 대해
//   095      GRANT/REVOKE 층 (`system/observationAcl.ts`가 판정)
//
// 그래서 **096 이후 아무 파일에서나** 다시 열 수 있었다. fixture를 만들어
// 돌려서 얻은 값 (`supabase`·`src` 거울 + `.git` 유지 + 매니페스트 재생성):
//
//   대조 · 원문 그대로                              rc=0  OK
//   199에서 `TO public` 으로 정책을 만든다            rc=0  **구멍**
//   199에서 `TO` 절 없이 정책을 만든다                rc=0  **구멍**
//   199에서 `TO anon` 으로 정책을 만든다              rc=0  **구멍**
//   199에서 anon 에 GRANT + 정책을 준다               rc=0  **구멍**
//
// 마지막 줄이 판정적이다. `TO anon` 정책을 **093에 적으면** 기존 검사가
// 잡는다 (돌려서 확인했다). 199에 적으면 잡지 않는다 — 판정이 093·094·095
// 라는 **이름**에 묶여 있었기 때문이다.
//
// ★ 그리고 PostgreSQL에서 `CREATE POLICY`에 `TO` 절을 적지 않으면 그 정책은
//   **PUBLIC**이다. 기존 판정은 "service_role 정책이 하나 있는가"와
//   "anon·authenticated라는 낱말이 없는가"를 봤으므로, TO 절이 없는 정책은
//   **두 조건을 모두 만족하면서 모든 role에 걸린다.**
//
// 고친 자리는 `src/lib/system/observationAcl.ts` 한 곳이다. 이미 GRANT/REVOKE를
// 문장으로 끊어 읽는 정본이 거기 있었으므로 **판정을 복제하지 않고** 입력을
// 전수로 넓혔다 (`checkObservationExposure`).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const MIGD = new URL('supabase/migrations/', root);

const src = ts.transpileModule(
  readFileSync(new URL('src/lib/system/observationAcl.ts', root), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const mod = {};
runInNewContext(src, {
  exports: mod,
  require(id) { throw new Error(`예상 못 한 import: ${id}`); },
});
const { checkObservationExposure, parsePolicyStatements, parseAlterPolicyStatements } = mod;

// `runInNewContext`가 만든 배열은 이 realm의 `Array.prototype`이 아니다.
// `deepStrictEqual`은 프로토타입까지 보므로 모양이 같아도 어긋난다 —
// 비교 전에 이쪽 realm으로 펼친다 (`[...roles]`).

const RISK = 'public.exact100x_risk_observations';
const ESC = 'public.exact100x_exit_escape_observations';

/** 저장소의 실제 마이그레이션 전수 */
const realFiles = () => readdirSync(MIGD).filter(n => n.endsWith('.sql')).sort()
  .map(n => ({ name: n, sql: readFileSync(new URL(n, MIGD), 'utf8') }));

/** 실제 전수 + 뒤에 붙는 가짜 파일 하나 */
const withLate = (sql, name = '199_probe.sql') => [...realFiles(), { name, sql }];

// ── 배선이 있는가 ────────────────────────────────────────────────
test('정본에 전수 노출 판정이 있다', () => {
  assert.equal(typeof checkObservationExposure, 'function',
    'checkObservationExposure가 없으면 095 뒤 파일을 아무도 보지 않는다');
  assert.equal(typeof parsePolicyStatements, 'function');
});

// ── 대조 — 지금 저장소는 통과한다 ────────────────────────────────
test('대조 — 지금 저장소의 마이그레이션 전수는 통과한다', () => {
  const v = checkObservationExposure(realFiles());
  assert.equal(v.ok, true, `지금 트리가 막히면 검사기가 거짓말을 한다: ${v.code} ${v.reason}`);
});

// ── ★ 뒤 파일이 정책으로 여는 네 가지 ───────────────────────────
test('★ 뒤 파일이 TO 절 없이 정책을 만들면 막는다 (TO 없음 = PUBLIC)', () => {
  const v = checkObservationExposure(withLate(
    `CREATE POLICY probe_open ON ${RISK} FOR SELECT USING (true);`));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_NOT_SERVICE_ONLY');
  assert.match(v.reason, /199_probe\.sql/);
  assert.match(v.reason, /PUBLIC/);
});

test('★ 뒤 파일이 TO public 으로 정책을 만들면 막는다', () => {
  const v = checkObservationExposure(withLate(
    `CREATE POLICY probe_pub ON ${RISK} FOR SELECT TO public USING (true);`));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_NOT_SERVICE_ONLY');
  assert.match(v.reason, /public/);
});

test('★ 뒤 파일이 TO anon 으로 정책을 만들면 막는다', () => {
  const v = checkObservationExposure(withLate(
    `CREATE POLICY probe_anon ON ${RISK} FOR SELECT TO anon USING (true);`));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_NOT_SERVICE_ONLY');
  assert.match(v.reason, /anon/);
});

test('★ service_role 과 함께 적어도 다른 role 이 섞이면 막는다', () => {
  const v = checkObservationExposure(withLate(
    `CREATE POLICY probe_both ON ${ESC} FOR ALL TO service_role, authenticated`
    + ' USING (true) WITH CHECK (true);'));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_NOT_SERVICE_ONLY');
  assert.match(v.reason, /authenticated/);
});

// ── ★ 뒤 파일이 GRANT 로 여는 두 가지 ───────────────────────────
test('★ 뒤 파일이 anon 에 GRANT 하면 막는다', () => {
  const v = checkObservationExposure(withLate(
    `GRANT SELECT ON TABLE ${RISK} TO anon;`));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PUBLIC_ROLE_GRANTED');
  assert.match(v.reason, /anon/);
});

test('★ DO 블록 안에 숨은 GRANT 도 본다 (문장 처음이 아니다)', () => {
  const v = checkObservationExposure(withLate(
    `DO $$ BEGIN GRANT SELECT ON TABLE ${RISK} TO authenticated; END $$;`));
  assert.equal(v.ok, false, 'DO 블록 안이면 문장 처음이 아니다 — 그래도 봐야 한다');
  assert.equal(v.code, 'PUBLIC_ROLE_GRANTED');
});

// ── 대조 — 지나치게 잡지 않는가 ─────────────────────────────────
test('대조 — service_role 전용 정책은 통과한다', () => {
  const v = checkObservationExposure(withLate(
    `CREATE POLICY probe_svc ON ${RISK} FOR ALL TO service_role`
    + ' USING (true) WITH CHECK (true);'));
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 다른 표의 정책·GRANT는 건드리지 않는다', () => {
  const v = checkObservationExposure(withLate(
    'CREATE POLICY other_open ON public.some_other_table FOR SELECT TO anon USING (true);\n'
    + 'GRANT SELECT ON TABLE public.some_other_table TO anon;'));
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 주석 안의 정책·GRANT는 읽지 않는다', () => {
  const v = checkObservationExposure(withLate(
    `-- CREATE POLICY probe_anon ON ${RISK} FOR SELECT TO anon USING (true);\n`
    + `/* GRANT SELECT ON TABLE ${RISK} TO anon; */\n`));
  assert.equal(v.ok, true, `주석을 코드로 읽으면 반대쪽 거짓말이다: ${v.reason}`);
});

test('대조 — USING 식 안의 TO 는 role 이 아니다', () => {
  const v = checkObservationExposure(withLate(
    `CREATE POLICY probe_using ON ${RISK} FOR ALL TO service_role`
    + " USING (note = 'TO anon') WITH CHECK (true);"));
  assert.equal(v.ok, true, v.reason);
});

test('대조 — service_role 에 대한 GRANT 는 통과한다', () => {
  const v = checkObservationExposure(withLate(
    `GRANT ALL PRIVILEGES ON TABLE ${RISK} TO service_role;`));
  assert.equal(v.ok, true, v.reason);
});

// ── 읽은 모양이 맞는가 ──────────────────────────────────────────
test('parsePolicyStatements가 이름·표·role을 읽는다', () => {
  const got = parsePolicyStatements(
    `DO $$ BEGIN\n  CREATE POLICY exact100x_risk_obs_service\n    ON ${RISK}\n`
    + '    FOR ALL TO service_role USING (true) WITH CHECK (true);\n'
    + 'EXCEPTION WHEN duplicate_object THEN NULL; END $$;');
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'exact100x_risk_obs_service');
  assert.equal(got[0].table, RISK);
  assert.deepEqual([...got[0].roles], ['service_role']);
});

test('parsePolicyStatements — 표 이름에 스키마가 없으면 public 으로 읽는다', () => {
  const got = parsePolicyStatements(
    'CREATE POLICY p ON exact100x_risk_observations FOR SELECT TO anon USING (true);');
  assert.equal(got[0].table, RISK);
  assert.deepEqual([...got[0].roles], ['anon']);
});

test('parsePolicyStatements — TO 절이 없으면 roles 가 빈 배열이다', () => {
  const got = parsePolicyStatements(`CREATE POLICY p ON ${RISK} FOR SELECT USING (true);`);
  assert.deepEqual([...got[0].roles], []);
});

// ── 인용 식별자 (Codex가 #828에서 찾은 구멍) ──────────────────────
//
// `("?[\w$.]+"?)`로 표를 읽으면 `"public"."exact100x_risk_observations"`에서
// `"public"`만 집어 **`public.public`**이 됐고, 그 이름은 지키는 목록에
// 없으므로 통과했다. GRANT 쪽은 따옴표를 아예 벗기지 않아 역시 어긋났다.
// 유효한 SQL이다 — 격리 PostgreSQL에서 `pg_policies.roles = {public}`으로
// 확인됐다고 보고됐고, 두 경우 모두 이 저장소에서 다시 재현했다.
const QUOTED = [
  ['스키마·표 모두 인용', '"public"."exact100x_risk_observations"'],
  ['표만 인용', '"exact100x_risk_observations"'],
  ['스키마만 인용', '"public".exact100x_risk_observations'],
  ['점 주위에 공백', 'public . exact100x_risk_observations'],
];

for (const [how, ref] of QUOTED) {
  test(`★ 인용 표기 — ${how} · 정책을 PUBLIC 에 열면 막는다`, () => {
    const v = checkObservationExposure(withLate(
      `CREATE POLICY probe_open ON ${ref} FOR SELECT TO PUBLIC USING (true);`));
    assert.equal(v.ok, false, `${ref} 를 다른 표로 읽으면 통과한다`);
    assert.equal(v.code, 'POLICY_NOT_SERVICE_ONLY');
  });

  test(`★ 인용 표기 — ${how} · GRANT 를 PUBLIC 에 주면 막는다`, () => {
    const v = checkObservationExposure(withLate(
      `GRANT SELECT ON TABLE ${ref} TO PUBLIC;`));
    assert.equal(v.ok, false, `${ref} 를 다른 표로 읽으면 통과한다`);
    assert.equal(v.code, 'PUBLIC_ROLE_GRANTED');
  });
}

test('★ 인용 표기 — role 도 인용할 수 있다', () => {
  const v = checkObservationExposure(withLate(
    `GRANT SELECT ON TABLE "public"."exact100x_risk_observations" TO "anon";`));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PUBLIC_ROLE_GRANTED');
  assert.match(v.reason, /anon/);
});

test('대조 — 인용한 service_role 은 통과한다', () => {
  const v = checkObservationExposure(withLate(
    `GRANT ALL PRIVILEGES ON TABLE "public"."exact100x_risk_observations" TO "service_role";\n`
    + `CREATE POLICY p ON "public"."exact100x_exit_escape_observations"`
    + ' FOR ALL TO "service_role" USING (true) WITH CHECK (true);'));
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 인용 표기라도 다른 표는 건드리지 않는다', () => {
  const v = checkObservationExposure(withLate(
    'CREATE POLICY p ON "public"."some_other_table" FOR SELECT TO anon USING (true);\n'
    + 'GRANT SELECT ON TABLE "public"."some_other_table" TO anon;'));
  assert.equal(v.ok, true, v.reason);
});

test('parsePolicyStatements — 인용 수식 이름을 schema.table 로 읽는다', () => {
  const got = parsePolicyStatements(
    'CREATE POLICY "my policy" ON "public"."exact100x_risk_observations"'
    + ' FOR SELECT TO PUBLIC USING (true);');
  assert.equal(got[0].table, 'public.exact100x_risk_observations');
  assert.equal(got[0].name, 'my policy');
  assert.deepEqual([...got[0].roles], ['public']);
});

// ── 인용 role 은 대소문자를 보존한다 (Codex 두 번째 지적) ──────────
//
// 표 이름과 role 을 같은 `toLowerCase()`로 묶은 것이 잘못이었다. 표 쪽에서
// 보수적(놓치지 않는 쪽)이던 선택이 role 쪽에서는 **반대로 통과를 넓혔다.**
// `"SERVICE_ROLE"`은 PostgreSQL 에서 `service_role`과 다른 role 이고,
// 격리 PG 에서 `pg_roles`가 두 role 의 `bypassrls`를 별개로 반환한다고
// 보고됐다 — `service_role`은 true, `SERVICE_ROLE`은 false.
//
// 고치기 전 측정: 인용 대문자·혼합 모두 정책·GRANT 양쪽에서 **허용**.
test('★ 인용 대문자 role 은 service_role 이 아니다 — 정책을 막는다', () => {
  for (const role of ['"SERVICE_ROLE"', '"Service_Role"', '"ServiceRole"']) {
    const v = checkObservationExposure(withLate(
      `CREATE POLICY rp ON ${RISK} FOR ALL TO ${role} USING (true) WITH CHECK (true);`));
    assert.equal(v.ok, false, `${role} 를 service_role 로 읽으면 다른 role 에 표가 열린다`);
    assert.equal(v.code, 'POLICY_NOT_SERVICE_ONLY');
  }
});

test('★ 인용 대문자 role 은 service_role 이 아니다 — GRANT 를 막는다', () => {
  for (const role of ['"SERVICE_ROLE"', '"Service_Role"']) {
    const v = checkObservationExposure(withLate(
      `GRANT SELECT ON TABLE ${RISK} TO ${role};`));
    assert.equal(v.ok, false, `${role} 를 service_role 로 읽으면 다른 role 에 표가 열린다`);
    assert.equal(v.code, 'PUBLIC_ROLE_GRANTED');
  }
});

test('대조 — 인용하지 않은 role 은 PostgreSQL 규칙대로 소문자로 접힌다', () => {
  // 인용하지 않은 식별자는 PostgreSQL 이 소문자로 접는다. `SERVICE_ROLE`과
  // `service_role`은 **같은** role 이다 — 여기서 막으면 거짓 실패가 난다.
  for (const role of ['service_role', 'SERVICE_ROLE', 'Service_Role', '"service_role"']) {
    const v = checkObservationExposure(withLate(
      `GRANT ALL PRIVILEGES ON TABLE ${RISK} TO ${role};`));
    assert.equal(v.ok, true, `${role} 는 service_role 과 같은 role 이다: ${v.reason}`);
  }
});

test('대조 ★ 표를 찾는 쪽은 대소문자를 무시한다 (막는 쪽으로 틀린다)', () => {
  // `"EXACT100X_RISK_OBSERVATIONS"`는 엄밀히 다른 표다. 그래도 같은 표로
  // 봐서 막는다 — 이 선택이 낼 수 있는 잘못은 **거짓 차단**뿐이다.
  // 이 대조를 지우면 후속 파서 통합에서 그 선택이 조용히 뒤집힌다.
  for (const ref of [
    '"public"."exact100x_risk_observations"',
    '"PUBLIC"."EXACT100X_RISK_OBSERVATIONS"',
    '"Public"."Exact100X_Risk_Observations"',
  ]) {
    const v = checkObservationExposure(withLate(`GRANT SELECT ON TABLE ${ref} TO anon;`));
    assert.equal(v.ok, false, `${ref} 를 다른 표로 읽으면 통과한다`);
    assert.equal(v.code, 'PUBLIC_ROLE_GRANTED');
  }
});

test('대조 — 두 선택은 한 함수에 섞여 있지 않다', () => {
  // role 은 의미대로 접고(인용은 보존), 표는 그 위에서 대소문자를 무시한다.
  // 한 함수로 묶으면 둘 중 하나가 반드시 틀린다 — 그것이 이 지적의 핵심이다.
  const upperRoleOnGuardedTable = checkObservationExposure(withLate(
    `CREATE POLICY rp ON "PUBLIC"."EXACT100X_RISK_OBSERVATIONS"`
    + ' FOR ALL TO "SERVICE_ROLE" USING (true) WITH CHECK (true);'));
  assert.equal(upperRoleOnGuardedTable.ok, false,
    '표는 대소문자 무시로 찾고, role 은 정확히 비교해야 이 한 줄이 막힌다');
  assert.equal(upperRoleOnGuardedTable.code, 'POLICY_NOT_SERVICE_ONLY');
});

// ── ALTER POLICY 를 순회하지 않았다 (Codex 세 번째 지적) ───────────
//
// `CREATE POLICY`와 GRANT 만 봤으므로 **이미 있는 정책을 제자리에서
// 고치는** 문장이 전혀 보이지 않았다. 경계를 되돌리는 가장 자연스러운
// 방법이 비어 있던 것이다. 고치기 전 측정: 아래 전부 `ok:true/OK`.
test('★ ALTER POLICY 로 정책을 제자리에서 고치면 막는다', () => {
  for (const tail of ['USING (true)', 'TO PUBLIC USING (true)', 'TO anon',
                      'RENAME TO other_name', 'USING (true) WITH CHECK (true)']) {
    const v = checkObservationExposure(withLate(
      `ALTER POLICY exact100x_risk_obs_service ON ${RISK} ${tail};`));
    assert.equal(v.ok, false, `ALTER POLICY ${tail} 가 보이지 않으면 경계를 되돌릴 수 있다`);
    assert.equal(v.code, 'POLICY_ALTERED');
  }
});

test('★ ALTER POLICY · 인용 표기도 같은 표로 읽는다', () => {
  const v = checkObservationExposure(withLate(
    'ALTER POLICY p ON "public"."exact100x_risk_observations" USING (true);'));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_ALTERED');
});

test('★ 소유자 식을 다시 적는 ALTER POLICY 도 막는다 (결과를 알 수 없다)', () => {
  // `ALTER POLICY`는 `TO`·`USING`·`WITH CHECK`를 **따로** 바꾸고 바꾸지
  // 않은 절은 그대로 남는다. 그래서 이 문장 하나로는 결과 모양을 알 수
  // 없다 — 특히 원래 `cmd`를 모른다. 느슨하게 잡으면 `FOR ALL` 정책의
  // role 만 바꿔치우는 줄이 새어 나간다.
  const v = checkObservationExposure(withLate(
    `ALTER POLICY exact100x_risk_obs_service ON ${RISK} TO service_role;`));
  assert.equal(v.ok, false);
  assert.equal(v.code, 'POLICY_ALTERED');
  assert.match(v.reason, /지우고 같은 파일에서 다시 만들면/);
});

test('대조 — 지키지 않는 표의 ALTER POLICY 는 건드리지 않는다', () => {
  const v = checkObservationExposure(withLate(
    'ALTER POLICY p ON public.some_other_table TO anon USING (true);'));
  assert.equal(v.ok, true, v.reason);
});

test('대조 — 주석 안의 ALTER POLICY 는 읽지 않는다', () => {
  const v = checkObservationExposure(withLate(
    `-- ALTER POLICY p ON ${RISK} USING (true);\n`
    + `/* ALTER POLICY p ON ${RISK} TO anon; */\n`));
  assert.equal(v.ok, true, `주석을 코드로 읽으면 반대쪽 거짓말이다: ${v.reason}`);
});

test('parseAlterPolicyStatements 가 이름과 표를 읽는다', () => {
  const got = parseAlterPolicyStatements(
    `ALTER POLICY "my policy" ON "public"."exact100x_risk_observations" USING (true);`);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'my policy');
  assert.equal(got[0].table, 'public.exact100x_risk_observations');
});

test('대조 — 지금 저장소에는 ALTER POLICY 가 없다', () => {
  const all = realFiles().flatMap(f => parseAlterPolicyStatements(f.sql));
  assert.equal(all.length, 0,
    `ALTER POLICY 가 생기면 이 판정이 막는다 — 생긴 것: ${all.map(a => a.table).join(', ')}`);
});
