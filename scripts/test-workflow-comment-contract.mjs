// scripts/test-workflow-comment-contract.mjs
//
// **주석은 계약이 아니다.**
//
// `scripts/lib/strip-comments.mjs` 는 이 고장 때문에 생긴 파일이고,
// 그 머리에 "새 검사기는 여기서 가져다 쓴다"고 적혀 있다. 그런데 두
// 관문이 그것을 쓰지 않고 raw 텍스트를 보고 있었다.
//
// 기계적으로 쟀다 — 워크플로의 줄마다 ① 지우기 ② 들여쓰기 유지 주석
// 처리를 각각 돌려서, **지우면 빨강인데 주석 처리하면 초록인 줄**을
// 찾았다. 그런 줄이 다섯 개였다 (ed00c1a4):
//
//   check-contract-base-wiring   mutation-100x-pr313.yml:54 · ci.yml:794
//   check-required-check-workflow auto-merge.yml:89 · :90 · :95
//
// 뒤쪽이 더 무겁다. `auto-merge-gate` 는 main 의 **필수 검사**이고,
// 그 검사를 "빨갛지 않고 아예 없게" 만든 것이 바로 concurrency 설정
// 이었다(PR #576). 그 관문이 주석 한 줄로 열리면 없는 것과 같다.
//
// 지킬 문장: **주석 처리된 줄과 다른 키의 인용된 값은 "있다"가 아니다.**
// 어기는 가장 싼 방법 셋을 먼저 적고 전부 시험으로 만들었다 —
// ① 주석 처리 ② 삭제 ③ 다른 키의 인용된 값에 같은 문구.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { concurrencyOf } from './lib/workflow-concurrency.mjs';

const REPO = process.cwd();

/** 합성 `.github/workflows` 를 만들고 그 안에서 검사기를 돌린다 */
function runIn(files, script) {
  const dir = mkdtempSync(join(tmpdir(), 'wfcomment-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, '.github/workflows', name), body);
  }
  // 검사기는 `scripts/lib/*` 를 상대 import 하므로 스크립트 경로는 저장소 쪽을 쓴다
  const r = spawnSync(process.execPath, [join(REPO, script)], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const commented = (line) => {
  const s = line.trimStart();
  return line.slice(0, line.length - s.length) + '# ' + s;
};

// ── check-contract-base-wiring ────────────────────────────────
// 전수 변이 하네스(`check-100x-mutations.mjs`)를 쓰면 같은 검사기의 둘째
// 절이 `paths:` 필터를 요구한다(정당한 요구다 — 내 첫 fixture 가 그래서
// 빨갰고, 검사기가 아니라 fixture 가 틀렸다). 여기서 보려는 것은 배선
// 절이므로 직접 호출 쪽을 쓴다.
const WIRED = [
  'name: mut',
  'on:',
  '  pull_request:',
  'jobs:',
  '  m:',
  '    runs-on: ubuntu-latest',
  '    env:',
  '      EXECUTION_CONTRACT_BASE: ${{ github.event.pull_request.base.sha }}',
  '    steps:',
  '      - run: node scripts/check-execution-profile.mjs',
  '',
].join('\n');
const WIRE_LINE = '      EXECUTION_CONTRACT_BASE: ${{ github.event.pull_request.base.sha }}';

test('계약 기준 배선 — 원문은 통과한다 (대조)', () => {
  const r = runIn({ 'mut.yml': WIRED }, 'scripts/check-contract-base-wiring.mjs');
  assert.equal(r.code, 0, r.out);
});

test('★ 배선 줄을 주석 처리하면 "넘긴다"로 세지 않는다', () => {
  const r = runIn({ 'mut.yml': WIRED.replace(WIRE_LINE, commented(WIRE_LINE)) },
    'scripts/check-contract-base-wiring.mjs');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /넘기지 않습니다/);
});

test('배선 줄을 지우면 이유까지 맞게 적는다', () => {
  // 전에는 rc=1 이긴 했지만 **44행 설명 주석**을 배선 줄로 집어
  // "base를 넣지 않습니다 ()" 라는 엉뚱한 이유를 적었다.
  const r = runIn({ 'mut.yml': WIRED.replace(WIRE_LINE + '\n', '') },
    'scripts/check-contract-base-wiring.mjs');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /넘기지 않습니다/);
});

test('★ 다른 키의 인용된 값은 배선이 아니다', () => {
  const dummy = '      DUMMY: "EXECUTION_CONTRACT_BASE: ${{ github.event.pull_request.base.sha }}"';
  const r = runIn({ 'mut.yml': WIRED.replace(WIRE_LINE, dummy) },
    'scripts/check-contract-base-wiring.mjs');
  assert.equal(r.code, 1, r.out);
});

// ── concurrencyOf (필수 체크 관문의 판정) ──────────────────────
test('concurrencyOf 계약 — 걷힌 뒤의 모습을 그대로 읽는다 (회귀 감시 아님)', () => {
  // 이 시험은 되돌려도 통과한다. 주석을 걷는 일은 **호출부**에서 하므로
  // 여기서는 "걷힌 입력을 올바로 읽는다"만 못 박는다. ★ 를 붙이지 않는다 —
  // 되돌리면 깨지는 것만 ★ 다.
  const live = 'concurrency:\n  group: auto-merge-x\n  cancel-in-progress: false\n';
  assert.deepEqual(concurrencyOf(live), { group: 'auto-merge-x', cancelInProgress: 'false' });
  const stripped = 'concurrency:\n  group: auto-merge-x\n  \n';
  assert.equal(concurrencyOf(stripped).cancelInProgress, null);
});

test('★ 다른 키의 인용된 값은 concurrency 설정이 아니다', () => {
  const faked = 'concurrency:\n  group: auto-merge-x\n  DUMMY: "cancel-in-progress: false"\n';
  assert.equal(concurrencyOf(faked).cancelInProgress, null,
    '인용된 값을 설정으로 읽었습니다');
});

test('여러 줄 group: >- 을 끝까지 읽는다 — 좁히다 잘라 먹지 않는다', () => {
  // 내 첫 수정이 `m` 플래그를 써서 `$` 가 줄 끝이 되었고, 이어진 줄을
  // 잘라 먹어 실제 auto-merge.yml 을 깨뜨렸다. 그 회귀를 못 박는다.
  const multi = [
    'concurrency:',
    '  group: >-',
    '    auto-merge-${{ github.event.pull_request.head.sha',
    '    || github.sha }}',
    '  cancel-in-progress: false',
    '',
  ].join('\n');
  const got = concurrencyOf(multi);
  assert.match(got.group, /auto-merge-\$\{\{ github\.event\.pull_request\.head\.sha/);
  assert.match(got.group, /github\.sha \}\}/);
  assert.equal(got.cancelInProgress, 'false');
});

// ── 실제 저장소 (앵커가 살아 있는지) ───────────────────────────
test('실제 auto-merge.yml 의 concurrency 를 그대로 읽는다', () => {
  const src = readFileSync('.github/workflows/auto-merge.yml', 'utf8');
  const got = concurrencyOf(src);
  assert.ok(got, 'concurrency 블록을 찾지 못했습니다 — 앵커가 바뀌었습니다');
  assert.equal(got.cancelInProgress, 'false');
  assert.match(got.group, /auto-merge-/);
});

test('★ 실제 auto-merge.yml 의 관문 줄을 주석 처리하면 그 이유로 실패한다', () => {
  // **처음 쓴 판은 맞는 이유로 통과하지 않았다.** 임시 디렉터리에
  // `auto-merge.yml` 하나만 넣었더니, 되돌린 판에서도 rc=1 이었다 —
  // 다만 이유가 "ci.yml 이 없습니다 / mutation-100x-pr313.yml 이
  // 없습니다" 였다. 워크플로 전부를 복사하면 되돌린 판은 rc=0 이다.
  // 그래서 ① 전부 복사하고 ② 메시지까지 확인한다.
  const dir = mkdtempSync(join(tmpdir(), 'wfam-'));
  cpSync('.github/workflows', join(dir, '.github/workflows'), { recursive: true });
  const amPath = join(dir, '.github/workflows/auto-merge.yml');
  const src = readFileSync(amPath, 'utf8');
  const target = src.split('\n').find((l) => l.trim().startsWith('cancel-in-progress:'));
  assert.ok(target, 'cancel-in-progress 줄을 찾지 못했습니다 — 앵커가 바뀌었습니다');
  writeFileSync(amPath, src.replace(target, commented(target)));
  const r = spawnSync(process.execPath,
    [join(REPO, 'scripts/check-required-check-workflow.mjs')], { cwd: dir, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, out);
  assert.match(out, /cancel-in-progress/,
    '실패는 했지만 이유가 이 관문이 아닙니다 — 맞는 이유로 실패해야 합니다');
  assert.doesNotMatch(out, /이 없습니다/,
    '파일이 없다는 이유로 실패했습니다 — fixture 가 불완전합니다');
});
