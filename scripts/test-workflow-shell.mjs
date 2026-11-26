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
import { readFileSync } from 'node:fs';
import { shellText, shellCommands, shellScriptLines } from './lib/workflow-shell.mjs';

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
