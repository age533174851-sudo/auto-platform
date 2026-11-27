// scripts/test-design-tokens-ci-call.mjs
//
// **UI 계약 검사 셋이 CI 에서 실제로 도는가 — 이름이 적혀 있는가가 아니다.**
//
// `check-design-tokens.mjs` §⑧ 은 "디자인 정리를 핑계로 UI-1·UI-3A 검사를
// 우회하거나 지우면 안 된다" 를 지키는 자리다. 그 단정이
// `ci.includes('check-ui-shell-contract.mjs')` 한 줄이었다 — **원문에
// 글자가 있으면 통과**였다.
//
// 기계 탐침으로 실제로 돌려 확인한 구멍(전부 유효 YAML · 단계는 성공 ·
// 검사기는 한 번도 안 돈다):
//
//     run: echo 'node scripts/check-ui-shell-contract.mjs'
//     run: true  # node scripts/check-ui-shell-contract.mjs
//
// 그리고 앵커가 필요하긴 한지의 대조로 **줄을 지우면** rc=1 이었다.
// 아래 시험은 그 변형들을 그대로 박아 둔다 — 하나라도 다시 통과하면
// 그 자리에 구멍이 다시 열린 것이다.
//
// 좁히는 쪽으로 틀리지 않는 것도 같이 잠근다: 환경변수 접두와
// `node --test` 꼴은 **그대로 호출로 세야 한다**(대조 시험 둘).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER = join(REPO, 'scripts/check-design-tokens.mjs');
const CI = '.github/workflows/ci.yml';

/** 검사기가 보는 이름 셋 — 검사기에서 읽어 온다(목록을 두 곳에 두지 않는다). */
const GUARDED = readFileSync(CHECKER, 'utf8')
  .match(/\[(?:\s*'check-[a-z-]+\.mjs',?)+\s*\]/)[0]
  .match(/check-[a-z-]+\.mjs/g);

/**
 * 검사기를 **격리된 작업 폴더**에서 돌린다.
 *
 * 이 검사기는 `src/` 와 토큰 파일도 읽는다. 저장소를 통째로 복사하지 않고
 * `.github` 만 복사하고 나머지는 심링크한다. `node --test` 는 파일을 병렬로
 * 돌리니 실제 저장소 파일은 건드리지 않는다.
 */
function runChecker(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'dt-ci-call-'));
  for (const e of readdirSync(REPO)) {
    if (e === '.github' || e === '.git') continue;
    symlinkSync(join(REPO, e), join(dir, e));
  }
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  cpSync(join(REPO, '.github/workflows'), join(dir, '.github/workflows'), { recursive: true });
  if (mutate) mutate(join(dir, CI));
  const r = spawnSync('node', [CHECKER], { cwd: dir, encoding: 'utf8' });
  return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 실제 호출 줄의 번호 — 줄 번호를 박지 않는다. */
function callLineNo(name) {
  const L = readFileSync(join(REPO, CI), 'utf8').split('\n');
  const i = L.findIndex((l) => new RegExp(`^\\s*run:\\s*node\\s+scripts/${name}\\s*$`).test(l));
  assert.notEqual(i, -1, `${CI} 에서 ${name} 호출 줄을 못 찾았습니다 — 못 찾은 것을 통과로 적지 않습니다`);
  return i + 1;
}

/** 한 줄을 다른 글로 바꾼다. 들여쓰기는 그대로 둔다. */
function rewrite(path, lineNo, make) {
  const L = readFileSync(path, 'utf8').split('\n');
  const s = L[lineNo - 1];
  const indent = s.slice(0, s.length - s.replace(/^\s*/, '').length);
  L[lineNo - 1] = make(indent, s.trim());
  writeFileSync(path, L.join('\n'));
}

test('검사기가 보는 이름이 셋이고 전부 ci.yml 에 호출 줄로 있다', () => {
  assert.equal(GUARDED.length, 3, `읽어 온 이름: ${JSON.stringify(GUARDED)}`);
  for (const n of GUARDED) assert.ok(callLineNo(n) > 0);
});

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = runChecker(null);
  assert.equal(r.rc, 0, r.out);
});

test('★ 호출 줄을 지우면 그 이유로 실패한다 (앵커가 필요하긴 한가)', () => {
  const n = GUARDED[0];
  const r = runChecker((ci) => {
    const L = readFileSync(ci, 'utf8').split('\n');
    const no = callLineNo(n);
    writeFileSync(ci, L.filter((_, i) => i + 1 !== no).join('\n'));
  });
  assert.notEqual(r.rc, 0);
  assert.match(r.out, new RegExp(n.replace('.', '\\.')));
});

test('★ echo 로 감싸면 통과하지 않는다 (유효 YAML · 셸은 출력만 한다)', () => {
  const n = GUARDED[0];
  const r = runChecker((ci) => rewrite(ci, callLineNo(n), (ind) => `${ind}run: echo 'node scripts/${n}'`));
  assert.notEqual(r.rc, 0, '인용 안의 문장이 호출로 셌다');
  assert.match(r.out, /명령 위치에서 부르지 않습니다/);
});

test('★ 호출을 지우고 이름만 꼬리 주석에 남기면 통과하지 않는다', () => {
  const n = GUARDED[1];
  const r = runChecker((ci) => rewrite(ci, callLineNo(n), (ind) => `${ind}run: true  # node scripts/${n}`));
  assert.notEqual(r.rc, 0, '주석에 적힌 이름이 호출로 셌다');
});

test('★ 들여쓰기를 지킨 주석 처리도 통과하지 않는다', () => {
  const n = GUARDED[2];
  const r = runChecker((ci) => rewrite(ci, callLineNo(n), (ind, body) => `${ind}# ${body}`));
  assert.notEqual(r.rc, 0, '주석 처리된 호출이 호출로 셌다');
});

test('대조 — 환경변수 접두는 여전히 호출이다 (좁히는 쪽으로 틀리지 않는다)', () => {
  const n = GUARDED[0];
  const r = runChecker((ci) => rewrite(ci, callLineNo(n), (ind) => `${ind}run: CI=1 node scripts/${n}`));
  assert.equal(r.rc, 0, r.out);
});

test('대조 — 플래그가 붙어도 호출이다', () => {
  const n = GUARDED[0];
  const r = runChecker((ci) => rewrite(ci, callLineNo(n), (ind) => `${ind}run: node --enable-source-maps scripts/${n}`));
  assert.equal(r.rc, 0, r.out);
});
