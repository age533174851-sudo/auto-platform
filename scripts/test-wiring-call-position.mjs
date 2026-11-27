// scripts/test-wiring-call-position.mjs
//
// **`check-wiring.mjs` 가 "적혀 있는 것"을 "부르는 것"으로 세지 않는가.**
//
// 이 검사기는 두 가지를 보증한다고 적어 뒀다:
//   ① "CI가 안 돌리는 검사기는 없는 검사기다" (아무도 안 부르는 검사기 0개)
//   ② 무인 회차 워크플로는 실패 원인을 **진단기 한 곳에서만** 정한다
//      — 그래서 진단기가 **항상** 돌아야 한다
//
// 그리고 :1030 에 스스로 적었다: **"주석은 호출이 아니다."**
// 그런데 실측(무인 회차 01:32)에서 둘 다 열려 있었다:
//
//   · `ci.yml` 의 호출 줄을 지우고 `echo "… node scripts/check-x.mjs"` 만
//     남겨도 "배선됨" 으로 셌다 (인용 안 · heredoc 본문 · `- name:` 제목 전부)
//   · `claude-hourly-*.yml` 의 `claude-exec-category` 호출 줄을 들여쓰기를
//     지키며 전부 주석 처리해도 rc=0 이었다 — 이 블록만 주석을 안 걷었다
//
// 아래 시험은 그 두 변형을 그대로 박아 둔다.
//
// **값: 이 검사기는 1회 22초다.** 그래서 변형 둘을 한 번에 넣고 메시지로
// 구분한다(2회 실행). 대조군을 따로 두는 이유는 내가 이 종류의 수정에서
// 두 번, 좁히는 쪽으로 틀려 실제 파일에서 거짓 양성을 냈기 때문이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-wiring.mjs');

/** 저장소를 심링크로 빌려 쓰고 `.github` 만 실제 복사해 변형한다. */
function runWiring(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-pos-'));
  for (const e of readdirSync(REPO)) {
    if (e === '.github' || e === '.git') continue;
    symlinkSync(join(REPO, e), join(dir, e));
  }
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  cpSync(join(REPO, '.github'), join(dir, '.github'), { recursive: true });
  if (mutate) mutate((rel) => join(dir, rel));
  const r = spawnSync('node', [CHECKER], { cwd: dir, encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const WF = (n) => `.github/workflows/${n}`;

test('대조군 — 실제 저장소에서 통과한다 (좁히는 쪽으로 틀리지 않았다)', () => {
  const { rc, out } = runWiring(null);
  assert.equal(rc, 0, out);
  assert.match(out, /아무도 안 부르는 것 0개/);
});

test('★ 인용 안에 적힌 호출과 주석 처리된 진단기는 "부르는 것"이 아니다', () => {
  const { rc, out } = runWiring((p) => {
    // ① 실제 호출 줄을 지우고 echo 인용 안에만 남긴다
    const ci = p(WF('ci.yml'));
    const L = readFileSync(ci, 'utf8').split('\n');
    const k = L.map((l, i) => (l.includes('check-audit-readonly.mjs') ? i : -1)).filter(i => i >= 0);
    assert.ok(k.length >= 1, 'ci.yml 이 check-audit-readonly 를 불러야 한다');
    const indent = L[k[0]].length - L[k[0]].replace(/^\s*/, '').length;
    const kept = L.filter((_, i) => !k.includes(i));
    kept.splice(k[0], 0, `${' '.repeat(indent)}echo "would run: node scripts/check-audit-readonly.mjs"`);
    writeFileSync(ci, kept.join('\n'));

    // ② 진단기 호출을 들여쓰기를 지키며 전부 주석 처리한다
    const dev = p(WF('claude-hourly-dev.yml'));
    const M = readFileSync(dev, 'utf8').split('\n');
    let hit = 0;
    for (let i = 0; i < M.length; i += 1) {
      if (!M[i].includes('claude-exec-category.mjs')) continue;
      const n = M[i].length - M[i].replace(/^\s*/, '').length;
      M[i] = `${M[i].slice(0, n)}# ${M[i].slice(n)}`;
      hit += 1;
    }
    assert.ok(hit >= 1, 'dev 워크플로가 진단기를 불러야 한다');
    writeFileSync(dev, M.join('\n'));
  });

  assert.equal(rc, 1, `둘 다 막혀야 한다\n${out}`);
  // 두 단정이 **각각** 걸렸는지 메시지로 확인한다 — 한 번 실행으로 둘을 구분한다.
  assert.match(out, /아무도 부르지 않는 검사기[\s\S]*check-audit-readonly\.mjs/,
    '인용 안의 호출을 배선으로 셌다');
  assert.match(out, /진단기\(claude-exec-category\)를 부르지 않습니다/,
    '주석 처리된 진단기 호출을 "부른다"로 셌다');
});
