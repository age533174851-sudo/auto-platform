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

test('★ 유효한 `run: echo \'…\'` 는 호출이 아니다 — 인용 안의 문장은 출력뿐이다', () => {
  // 이것이 **유효한 YAML 이고 `bash -n` 도 통과하는** 반례다 (#792 코멘트
  // 7208374816). 앞선 fixture 는 호출 줄을 지우고 같은 들여쓰기에 echo 를
  // 넣어 `run:` 키까지 없앴다 — 그래서 그 GREEN 은 이 경우를 증명하지
  // 못했다. 여기서는 `run:` 를 살려 두고 값만 echo 로 바꾼다.
  const { rc, out } = runWiring((p) => {
    const ci = p(WF('ci.yml'));
    const L = readFileSync(ci, 'utf8').split('\n');
    const k = L.map((l, i) => (l.includes('check-audit-readonly.mjs') ? i : -1)).filter((i) => i >= 0);
    assert.equal(k.length, 1, `호출 줄이 1개여야 한다 (지금 ${k.length})`);
    const indent = L[k[0]].length - L[k[0]].replace(/^\s*/, '').length;
    // `run:` 키는 그대로, 값만 인용된 echo 로. 콜론을 넣지 않아 YAML 이 깨지지 않는다.
    L[k[0]] = `${' '.repeat(indent)}run: echo 'node scripts/check-audit-readonly.mjs'`;
    writeFileSync(ci, L.join('\n'));
  });
  assert.equal(rc, 1, `인용 안의 문장을 호출로 셌다\n${out}`);
  assert.match(out, /아무도 부르지 않는 검사기[\s\S]*check-audit-readonly\.mjs/);
});

test('★ 진단기 호출을 인용 echo 로 바꾸면 막힌다 — 파이프가 인용 안에 있어도', () => {
  const { rc, out } = runWiring((p) => {
    const dev = p(WF('claude-hourly-dev.yml'));
    const L = readFileSync(dev, 'utf8').split('\n');
    const k = L.map((l, i) => (/^\s*node\s+scripts\/claude-exec-category\.mjs/.test(l) ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(k.length >= 1, '진단기를 명령 위치에서 부르는 줄이 있어야 한다');
    for (const i of k) {
      const indent = L[i].length - L[i].replace(/^\s*/, '').length;
      L[i] = `${' '.repeat(indent)}echo 'node scripts/claude-exec-category.mjs | tee -a "$GITHUB_STEP_SUMMARY"'`;
    }
    writeFileSync(dev, L.join('\n'));
  });
  assert.equal(rc, 1, `인용 안의 문장을 진단기 호출로 셌다\n${out}`);
  assert.match(out, /진단기\(claude-exec-category\)를 부르지 않습니다/);
});

test('★ 주석 처리된 호출·진단기도 여전히 막힌다', () => {
  const { rc, out } = runWiring((p) => {
    const ci = p(WF('ci.yml'));
    const L = readFileSync(ci, 'utf8').split('\n');
    for (let i = 0; i < L.length; i += 1) {
      if (!L[i].includes('check-audit-readonly.mjs')) continue;
      const n = L[i].length - L[i].replace(/^\s*/, '').length;
      L[i] = `${L[i].slice(0, n)}# ${L[i].slice(n)}`;
    }
    writeFileSync(ci, L.join('\n'));

    const dev = p(WF('claude-hourly-dev.yml'));
    const M = readFileSync(dev, 'utf8').split('\n');
    for (let i = 0; i < M.length; i += 1) {
      if (!M[i].includes('claude-exec-category.mjs')) continue;
      const n = M[i].length - M[i].replace(/^\s*/, '').length;
      M[i] = `${M[i].slice(0, n)}# ${M[i].slice(n)}`;
    }
    writeFileSync(dev, M.join('\n'));
  });
  assert.equal(rc, 1, `주석을 호출로 셌다\n${out}`);
  assert.match(out, /아무도 부르지 않는 검사기[\s\S]*check-audit-readonly\.mjs/);
  assert.match(out, /진단기\(claude-exec-category\)를 부르지 않습니다/);
});

test('좁히는 쪽으로 틀리지 않았다 — 환경변수 접두와 `node --test` 는 호출이다', () => {
  // 명령 위치로 좁히면 **실제로 돌고 있는 것**을 미배선으로 적을 위험이 생긴다.
  // 두 꼴을 대조로 박아 둔다: `FOO=1 node …` 와 `node --test …`.
  const envPrefixed = runWiring((p) => {
    const ci = p(WF('ci.yml'));
    const L = readFileSync(ci, 'utf8').split('\n');
    const i = L.findIndex((l) => l.includes('check-audit-readonly.mjs'));
    const indent = L[i].length - L[i].replace(/^\s*/, '').length;
    L[i] = `${' '.repeat(indent)}run: FOO=1 node scripts/check-audit-readonly.mjs`;
    writeFileSync(ci, L.join('\n'));
  });
  assert.equal(envPrefixed.rc, 0, `환경변수 접두를 호출이 아니라고 셌다\n${envPrefixed.out}`);

  // `node --test scripts/check-*.test.mjs` 꼴이 실제 저장소에 있다(2개).
  // 대조군이 통과한다는 것이 그 꼴을 세고 있다는 증거다.
  const asIs = runWiring(null);
  assert.equal(asIs.rc, 0, asIs.out);
  assert.match(asIs.out, /아무도 안 부르는 것 0개/);
});
