// scripts/test-workflow-shell.mjs
//
// **워크플로에 적혀 있는 것과 셸이 실행하는 것을 가르는 판정.**
//
// 이 판정이 없으면 관문을 세우는 검사기가 주석 한 줄에 속는다. 실측된
// 두 자리(#792 의 `ci.yml` 호출 세기, `check-audit-readonly` 의 운영 DB
// 읽기전용 증명)가 **같은 원인**이었고, 그래서 판정을 한 곳에 모았다.
//
// 여기서 지키는 문장: **셸이 실제로 실행하는 줄만 "있다"로 센다.**
// 그 문장을 어기는 가장 싼 방법 셋을 먼저 적고 시험으로 만들었다 —
// ① 주석 처리 ② 인용 안에 넣기 ③ run 이 아닌 곳에 적기.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellText, shellCommands, shellScriptLines, heredocText, heredocBodies, stripWorkflowComments, nodeFileArgs, invokesScript } from './lib/workflow-shell.mjs';

const AUDIT = '.github/workflows/audit-production-exact100x-testnet-readiness.yml';

test('★ 들여쓰기를 지킨 주석은 셸이 실행하지 않는다', () => {
  // YAML 블록을 깨지 않는 현실적인 주석 처리다. 0열 `#` 은 블록
  // 스칼라를 끝내 YAML 자체가 깨지므로, 사람이 실제로 하는 모양은 이쪽이다.
  const yaml = '      - run: |\n          node a.mjs\n          # node b.mjs\n';
  const t = shellText(yaml);
  assert.match(t, /node a\.mjs/);
  assert.doesNotMatch(t, /node b\.mjs/);
});

test('★ 인용 안의 문장은 명령이 아니다', () => {
  const yaml = '      - run: echo "x; grep -q \'READ_ONLY=on\'"\n';
  assert.equal(shellCommands(yaml).some((c) => /^grep\b/.test(c)), false);
  // 진짜 명령 위치에 있으면 센다.
  const real = '      - run: printf x | grep -q \'READ_ONLY=on\'\n';
  assert.equal(shellCommands(real).some((c) => /^grep\b[\s\S]*READ_ONLY=on/.test(c)), true);
});

test('★ heredoc 본문과 run 아닌 블록은 명령이 아니다', () => {
  const heredoc = "      - run: |\n          cat <<'SQL' > /tmp/a.sql\n          grep -q 'READ_ONLY=on'\n          SQL\n";
  assert.equal(shellCommands(heredoc).some((c) => /^grep\b/.test(c)), false);
  const notRun = '      - name: "grep -q \'READ_ONLY=on\' 확인함"\n        env:\n          HINT: |\n            grep -q \'READ_ONLY=on\'\n        run: true\n';
  assert.equal(shellCommands(notRun).some((c) => /^grep\b/.test(c)), false);
});

test('좁히면서 진짜 줄을 놓치지 않는다', () => {
  assert.equal(shellCommands('      - run: FOO=1 sed -E "s/a/b/"\n').some((c) => /^sed\s+-E/.test(c)), true);
  assert.equal(shellCommands('        run: |\n          cd . && sed -E "s/a/b/"\n').some((c) => /^sed\s+-E/.test(c)), true);
  // 다중행 블록의 빈 줄이 블록을 끊지 않는다
  const withBlank = '        run: |\n          echo a\n\n          sed -E "s/a/b/"\n';
  assert.equal(shellCommands(withBlank).some((c) => /^sed\s+-E/.test(c)), true);
});

test('실제 감사 워크플로의 관문 세 줄이 셸 텍스트에 있다', () => {
  const src = readFileSync(AUDIT, 'utf8');
  const t = shellText(src);
  assert.match(t, /\[\s*"\$\{CONFIRM\}"\s*!=\s*"READ-ONLY-AUDIT"\s*\]/);
  assert.match(t, /\[\s*"\$\{ACTOR\}"\s*!=\s*"\$\{OWNER\}"\s*\]/);
  assert.equal(shellCommands(src).some((c) => /^grep\b[\s\S]*READ_ONLY=on/.test(c)), true);
  assert.ok(shellScriptLines(src).length > 0, '셸 줄이 0개면 "관문 없음"이 아니라 못 읽은 것이다');
});

test('★ 그 세 줄을 주석 처리하면 셸 텍스트에서 사라진다', () => {
  // 수정 전에는 이 셋을 주석 처리해도 검사기가 ✅ 였다 (ed00c1a4 실측).
  const src = readFileSync(AUDIT, 'utf8');
  const lines = [
    "          if ! printf '%s' \"${out}\" | grep -q 'READ_ONLY=on'; then",
    '          if [ "${ACTOR}" != "${OWNER}" ]; then',
    '          if [ "${CONFIRM}" != "READ-ONLY-AUDIT" ]; then',
  ];
  for (const line of lines) {
    assert.equal(src.includes(line), true, `앵커가 바뀌었습니다: ${line.trim()}`);
    const stripped = line.trimStart();
    const pad = line.slice(0, line.length - stripped.length);
    const muted = src.replace(line, `${pad}# ${stripped}`);
    assert.equal(shellText(muted).includes(stripped), false,
      `주석 처리했는데 셸 텍스트에 남아 있습니다: ${stripped}`);
    // raw 텍스트에는 그대로 남는다 — 그것이 전 판이 속은 이유다
    assert.equal(muted.includes(stripped), true);
  }
});

test('★ 검사기가 그 판정을 실제로 쓴다 — 만들어 놓고 배선을 안 하지 않는다', () => {
  const chk = readFileSync('scripts/check-audit-readonly.mjs', 'utf8');
  assert.match(chk, /from '\.\/lib\/workflow-shell\.mjs'/,
    '공용 판정을 가져오지 않습니다');
  // 관문 셋을 raw `src` 로 다시 보고 있으면 안 된다
  assert.doesNotMatch(chk, /src\.includes\("grep -q 'READ_ONLY=on'"\)/);
  for (const re of [/READ-ONLY-AUDIT[\s\S]{0,40}\.test\(src\)/, /\$\{OWNER\}[\s\S]{0,40}\.test\(src\)/]) {
    assert.doesNotMatch(chk, re, '관문을 raw src 로 보고 있습니다');
  }
});

// ── 감사 SQL 앵커도 셸에서 실행되는 줄이어야 한다 ──────────────
//
// 기계 탐침으로 다시 재니 이 검사기의 구멍이 `ed00c1a4` 에서 **14개**
// 였다. 앞선 커밋이 13개를 닫고 하나가 남았다 — SQL 블록을 만드는
// 앵커를 raw `src.indexOf` 로 찾는 자리다. 자르는 일은 원문이 맞지만
// **그 줄이 실제로 도는가**는 셸에게 물어야 한다.

const AUDIT_WF = '.github/workflows/audit-production-exact100x-testnet-readiness.yml';
const commentOut = (line) => {
  const t = line.trimStart();
  return line.slice(0, line.length - t.length) + '# ' + t;
};

/** 워크플로 **전부**를 복사한 임시 트리에서 검사기를 돌린다 */
function runAudit(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'auditwf-'));
  cpSync('.github/workflows', join(dir, '.github/workflows'), { recursive: true });
  const path = join(dir, AUDIT_WF);
  const src = readFileSync(path, 'utf8');
  writeFileSync(path, mutate(src));
  const r = spawnSync(process.execPath,
    [join(process.cwd(), 'scripts/check-audit-readonly.mjs')], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const anchorLine = (src) => {
  const l = src.split('\n').find((x) => x.includes('cat > /tmp/audit.sql') && !x.trimStart().startsWith('#'));
  assert.ok(l, '앵커 줄을 찾지 못했습니다 — 앵커가 바뀌었습니다');
  return l;
};

test('감사 검사기 — 원문 복사본은 통과한다 (대조)', () => {
  const r = runAudit((s2) => s2);
  assert.equal(r.code, 0, r.out);
});

test('★ 감사 SQL 앵커를 주석 처리하면 그 이유로 실패한다', () => {
  // 주석 처리하면 `/tmp/audit.sql` 이 아예 만들어지지 않는다. 그런데
  // raw 텍스트에는 남아 있어 통과했다 (b3f2fa93 실측 rc=0).
  const r = runAudit((s2) => {
    const l = anchorLine(s2);
    return s2.replace(l, commentOut(l));
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /셸에서 실제로 돌지 않습니다/,
    '실패는 했지만 이유가 이 관문이 아닙니다');
});

test('★ 앵커를 다른 키의 인용된 값에 적어도 통과하지 않는다', () => {
  const r = runAudit((s2) => {
    const l = anchorLine(s2);
    const t = l.trimStart();
    const pad = l.slice(0, l.length - t.length);
    return s2.replace(l, `${pad}DUMMY: "${t}"`);
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /셸에서 실제로 돌지 않습니다/);
});

test('SQL 본문은 원문에서 자른다 — 쓰기 구문 검사가 그대로 돈다', () => {
  // heredoc 본문은 셸 명령이 아니지만 psql 에는 SQL 로 들어간다.
  // 그 구분이 깨지면 쓰기 구문 검사가 아무것도 못 본다.
  const r = runAudit((s2) => s2.replace('BEGIN TRANSACTION READ ONLY;',
    'BEGIN TRANSACTION READ ONLY;\n          INSERT INTO live_orders VALUES (1);'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /쓰기로 읽히는 구문/);
});

// ═══════════════════════════════════════════════════════════════════
// heredoc 본문 — **셸이 실행하지 않지만 자료로 그대로 넘기는 것**
//
// `psql <<'SQL'` 의 본문이 실제로 돌 SQL 이다. 그래서 SQL 단정은 워크플로
// 전체가 아니라 이쪽에서 봐야 한다. 실측(감사 워크플로):
// `BEGIN TRANSACTION READ ONLY` 5개 중 실제 SQL 은 2개뿐이고 나머지는
// 머리말 주석 1 + `- name:` 단계 제목 2 였다.
// ═══════════════════════════════════════════════════════════════════

test('heredoc 본문만 뽑는다 — 여는 줄은 명령이고 본문은 자료다', () => {
  const yaml = [
    '      - run: |',
    '          cat > /tmp/a.sql <<\'SQL\'',
    '          BEGIN TRANSACTION READ ONLY;',
    '          SELECT 1;',
    '          SQL',
    '          psql -f /tmp/a.sql',
    '',
  ].join('\n');
  const sql = heredocText(yaml);
  assert.match(sql, /BEGIN TRANSACTION READ ONLY;/);
  assert.doesNotMatch(sql, /psql -f/);          // 명령은 본문이 아니다
  assert.doesNotMatch(sql, /cat > \/tmp\/a\.sql/);
  // 반대쪽: 셸 쪽에는 본문이 없고 명령만 있다.
  const sh = shellText(yaml);
  assert.match(sh, /psql -f \/tmp\/a\.sql/);
  assert.doesNotMatch(sh, /BEGIN TRANSACTION READ ONLY/);
});

test('★ 주석 처리된 heredoc 여는 줄은 heredoc 이 아니다', () => {
  // 실측된 구멍(감사 워크플로 :139 · :427). 셸은 이 줄을 주석으로 읽어
  // **그 SQL 파일을 만들지 않는다.** 원문에서 `<<TAG` 를 찾으면 본문이
  // 그대로 "도는 SQL" 로 잡혀, 질의를 하나도 만들지 않는데도 통과한다.
  const live = '      - run: |\n          cat > /tmp/a.sql <<\'SQL\'\n          BEGIN TRANSACTION READ ONLY;\n          SQL\n';
  const dead = '      - run: |\n          # cat > /tmp/a.sql <<\'SQL\'\n          BEGIN TRANSACTION READ ONLY;\n          SQL\n';
  assert.match(heredocText(live), /BEGIN TRANSACTION READ ONLY/);
  assert.equal(heredocBodies(live).length, 1);
  assert.doesNotMatch(heredocText(dead), /BEGIN TRANSACTION READ ONLY/);
  assert.equal(heredocBodies(dead).length, 0);
});

test('heredoc 안의 `#` 은 주석이 아니다 — 본문을 자르지 않는다', () => {
  const yaml = '      - run: |\n          cat > /tmp/a.sql <<\'SQL\'\n          SELECT 1; -- 설명\n          SELECT \'a#b\' AS x;\n          SQL\n';
  assert.match(heredocText(yaml), /a#b/);
  assert.match(heredocText(yaml), /-- 설명/);   // 걷는 것은 쓰는 쪽의 몫이다
});

test('★ 주석 글자는 자리마다 다르다 — stripWorkflowComments', () => {
  // `#` 하나로 걷으면 SQL 의 `sed -E 's#…'` 가 잘리고, YAML 규칙으로
  // 걷으면 heredoc 안의 `--` 설명이 남아 **금지 구문이 주석에 적혀 있다는
  // 이유로** 관문이 불평한다 (감사 워크플로 :153 이 실제로 그랬다).
  const yaml = [
    '      - run: |',
    '          cat > /tmp/a.sql <<\'SQL\'',
    '          -- 전에는 INSERT INTO public.x 를 썼다',
    '          SELECT 1;',
    '          SQL',
    '          sed -E \'s#postgres://[^ ]*#***#\' log.txt   # 가린다',
    '',
  ].join('\n');
  const code = stripWorkflowComments(yaml);
  assert.doesNotMatch(code, /INSERT INTO/);     // heredoc 안의 `--` 주석은 걷힌다
  assert.doesNotMatch(code, /가린다/);          // 셸의 `#` 주석도 걷힌다
  assert.match(code, /sed -E 's#postgres/);     // 인용 안의 `#` 은 주석이 아니다
  assert.match(code, /SELECT 1;/);
});

test('닫히지 않은 heredoc 의 본문은 끝까지 센다 — 금지 구문이 숨지 않게', () => {
  const yaml = '      - run: |\n          cat > /tmp/a.sql <<\'SQL\'\n          INSERT INTO public.x VALUES (1);\n';
  assert.match(heredocText(yaml), /INSERT INTO public\.x/);
  assert.match(stripWorkflowComments(yaml), /INSERT INTO public\.x/);
});

/* ── nodeFileArgs — 이름으로 찾는 쪽과 글롭으로 찾는 쪽이 같은 목록을 본다
   ────────────────────────────────────────────────────────────────────
   전에는 명령 위치 판정이 `invokesScript` 안에만 있었고,
   `check-ci-script-tests.mjs` 의 `runTokens` 는 줄 단위로 `node --test` 를
   찾았다. 그래서 같은 반례가 한쪽만 막혔다 — 실측으로 확인했다. */

test('nodeFileArgs — 명령 위치의 node 호출만 인자째로 내보낸다', () => {
  const y = [
    '        run: |',
    '          npm run lint',
    '          node --test scripts/test-a.mjs',
    '          node scripts/check-b.mjs --strict',
  ].join('\n');
  assert.deepEqual(nodeFileArgs(y), [
    ['--test', 'scripts/test-a.mjs'],
    ['scripts/check-b.mjs', '--strict'],
  ]);
});

test('★ echo·printf 안에 적힌 node 는 호출이 아니다', () => {
  assert.deepEqual(nodeFileArgs("        run: echo 'node --test scripts/test-a.mjs'"), []);
  assert.deepEqual(nodeFileArgs('        run: printf \'%s\' "node --test scripts/test-a.mjs"'), []);
});

test('★ --eval 꼴은 파일을 돌리지 않으므로 목록에 없다', () => {
  for (const flag of ['--eval', '-e', '-p', '--print', '-pe', '--eval=1+1']) {
    assert.deepEqual(
      nodeFileArgs(`        run: node ${flag} 'console.log(1)' scripts/test-a.mjs`),
      [], `${flag} 가 파일 호출로 셌다`,
    );
  }
});

test('대조 — --test 와 환경변수 접두는 좁히지 않는다', () => {
  assert.deepEqual(nodeFileArgs('        run: CI=1 node --test scripts/test-a.mjs'),
    [['--test', 'scripts/test-a.mjs']]);
});

test('★ invokesScript 가 이 목록 위에 서 있다 — 판단이 두 곳에 없다', () => {
  const y = '        run: node scripts/check-b.mjs';
  assert.equal(invokesScript(y, 'scripts/check-b.mjs'), true);
  assert.equal(invokesScript("        run: echo 'node scripts/check-b.mjs'", 'scripts/check-b.mjs'), false);
  // 실제 ci.yml 에서도 그대로여야 한다 (좁히는 대가 0)
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.equal(invokesScript(ci, 'scripts/check-design-tokens.mjs'), true);
});
