// scripts/test-test-registry-discovery.mjs
//
// **`check-test-registry`가 "훑지 못한 것"을 통과로 적지 않는지 못 박는다.**
//
// 그 검사기의 머리말이 막으려는 고장은 "테스트 뭉치가 조용히 사라지고
// 그때도 CI는 초록"이다. 그런데 검사기 자신이 같은 모양으로 비어 있었다 —
// 뿌리를 읽지 못하면 `walk`이 빈 배열을 돌려주고, 집계는 그래도
// `미등록 0`을 적었다 (실측: 2026-11-26, main ed00c1a4).
//
// 여기서 보는 것은 네 가지다:
//
//   · 건강한 저장소는 초록이다 (잘못 막으면 그것도 고장이다)
//   · 등록 안 된 시험은 여전히 빨강이다 (원래 동작의 회귀)
//   · 뿌리를 **걷지 못하면** 빨강이다 ← 고친 것
//   · 발견이 **전부 비면** 빨강이다 ← 고친 것
//
// 뿌리마다 "1개 이상"을 요구하지 않는다는 것도 함께 못 박는다.
// worker/src의 `.test.ts`는 정상 저장소에서 0개다.
//
// 저장소를 건드리지 않는다. 작은 가짜 트리를 임시 디렉터리에 세우고
// 거기서만 돌린다 (#783에서 실제 트리를 건드려 병렬 형제 시험을
// 깨뜨린 적이 있다).
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-test-registry.mjs');

function runChecker(cwd) {
  const r = spawnSync(process.execPath, [CHECKER], { cwd, encoding: 'utf8' });
  return { rc: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * 검사기가 보는 것만 갖춘 최소 트리.
 *
 * 러너의 import 경로는 `./src/...` 꼴이어야 한다 — 검사기가 파일 경로
 * `src/lib/foo.test.ts`를 `./src/lib/foo.test`로 바꿔 맞춘다.
 */
function makeRepo(extra = {}) {
  const base = mkdtempSync(join(tmpdir(), 'testreg-'));
  const write = (rel, body) => {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  write('scripts/run-tests.mjs',
    "import { runFooTests } from './src/lib/foo.test';\nawait runFooTests();\n");
  write('src/lib/foo.test.ts', 'export async function runFooTests() {}\n');
  write('worker/src/index.ts', 'export const workerEntry = 1;\n');
  for (const [rel, body] of Object.entries(extra)) write(rel, body);
  return base;
}

function withRepo(extra, fn) {
  const base = makeRepo(extra);
  try { return fn(base); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('양성 대조 — 건강한 트리는 초록이다', () => {
  withRepo({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `초록이어야 합니다:\n${r.err}${r.out}`);
  });
});

test('러너에 등록 안 된 시험은 빨강이다 (원래 동작의 회귀)', () => {
  withRepo({ 'src/lib/bar.test.ts': 'export async function runBarTests() {}\n' }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 1, '빨강이어야 합니다');
    assert.match(r.err, /runBarTests/);
  });
});

test('★ 뿌리를 걷지 못하면 빨강이다 — 그 뿌리 이름을 적는다', () => {
  // 뿌리를 지운다. 등록·발견은 나머지 뿌리에서 여전히 들어맞으므로,
  // 고치기 전에는 이 경우가 **초록**이었다.
  withRepo({}, (base) => {
    rmSync(join(base, 'worker/src'), { recursive: true, force: true });
    const r = runChecker(base);
    assert.equal(r.rc, 1, `빨강이어야 합니다:\n${r.out}`);
    assert.match(r.err, /훑지 못한 디렉터리/);
    assert.match(r.err, /worker\/src/);
  });
});

test('★ 발견이 전부 비면 빨강이다 — "미등록 0"으로 적지 않는다', () => {
  withRepo({}, (base) => {
    rmSync(join(base, 'src'), { recursive: true, force: true });
    rmSync(join(base, 'worker/src'), { recursive: true, force: true });
    const r = runChecker(base);
    assert.equal(r.rc, 1, `빨강이어야 합니다:\n${r.out}`);
    assert.match(r.err, /시험 파일을 하나도 찾지 못했습니다/);
    assert.doesNotMatch(r.out, /미등록 0/);
  });
});

test('뿌리가 있고 .test.ts만 0개면 통과한다 — 뿌리마다 1개 이상을 요구하지 않는다', () => {
  // worker/src에는 `.test.ts`가 없고 보통 파일만 있다. 정상 저장소의
  // 모습이고, 이것을 막으면 건강한 저장소가 빨강이 된다.
  withRepo({ 'worker/src/lib/util.ts': 'export const u = 1;\n' }, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `초록이어야 합니다:\n${r.err}`);
  });
});

test('실제 저장소도 초록이다 — 가짜 트리가 현실과 갈라지지 않았는지 본다', () => {
  const r = runChecker(ROOT);
  assert.equal(r.rc, 0, `실제 저장소가 빨강입니다:\n${r.err}${r.out}`);
});

test('★ 집계가 뿌리별 개수를 적는다 — 한 뿌리가 0으로 떨어진 것이 보여야 한다', () => {
  // 합계 하나만 적으면 `src`가 늘고 `worker/src`가 0이 된 것을 사람이
  // 볼 수 없다. 그래서 집계 줄에 뿌리마다 개수를 남긴다.
  withRepo({}, (base) => {
    const r = runChecker(base);
    assert.equal(r.rc, 0, `초록이어야 합니다:\n${r.err}`);
    assert.match(r.out, /src 1개/);
    assert.match(r.out, /worker\/src 0개/);
    assert.match(r.out, /훑지 못한 디렉터리 0/);
  });
});
