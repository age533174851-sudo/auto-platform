// `check-credential-exposure.mjs`가 **뿌리를 못 걸었을 때 통과하지 않는가**를 본다.
//
// 왜 이 시험이 있는가
// ───────────────────
// 검사기의 뿌리는 둘(`src` · `worker/src`)이다. 예전에는 뿌리를 한 번에
// 펼치면서 걷기 실패를 빈 배열로 삼켰고, 그래서 `worker/src`가 사라지면
// `src`가 내놓는 1003개로 "파일이 0개인가" 관문을 통과했다. 워커 파일을
// 한 개도 안 본 채 "✅ 자격증명 노출"이 찍혔고 종료코드는 0이었다.
//
// 개수(1008 → 1003)만 줄었는데 그 숫자를 읽는 사람이 없으면 아무도 모른다.
// 하필 워커가 거래소 키를 실제로 쥐는 쪽이고 자기 `crypto.ts`를 따로 가진다.
//
// 그래서 **행동으로** 못을 박는다 — 뿌리를 못 걷는 상황을 만들어 돌리고,
// 빨강인지 본다. 삼키는 모양으로 되돌리면 이 시험이 깨진다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CHECKER = join(REPO, 'scripts/check-credential-exposure.mjs');
const SOURCE = readFileSync(CHECKER, 'utf8');
const ROOTS_DECL = /^const ROOTS = .*$/m;

function run(file) {
  const r = spawnSync(process.execPath, [file], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

/**
 * `ROOTS`만 바꾼 복제본을 임시 디렉터리에서 돌린다.
 * 원본 파일은 건드리지 않는다 — 검사기는 경로를 모두 cwd 기준 상대경로로
 * 읽으므로 복제본이 어디에 있어도 같은 저장소를 본다.
 */
function runWithRoots(roots) {
  assert.match(SOURCE, ROOTS_DECL, 'ROOTS 선언을 찾지 못했습니다 — 이 시험이 낡았습니다');
  const dir = mkdtempSync(join(tmpdir(), 'cred-roots-'));
  try {
    const copy = join(dir, 'checker.mjs');
    writeFileSync(copy, SOURCE.replace(ROOTS_DECL, `const ROOTS = ${JSON.stringify(roots)};`));
    return run(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('양성 대조 — 원본은 초록이고 뿌리별 개수를 찍는다', () => {
  const r = run(CHECKER);
  assert.equal(r.code, 0, `검사기가 빨강입니다:\n${r.err.slice(0, 600)}`);

  // 뿌리별 집계가 **눈에 보여야** 한다. 한쪽이 조용히 비어도 모르던 것이
  // 이 결함의 본질이었다.
  const tally = /파일\(([^)]+)\)/.exec(r.out);
  assert.ok(tally, `뿌리별 집계가 출력에 없습니다: ${r.out.slice(0, 200)}`);
  const counts = new Map(tally[1].split(' · ').map((part) => {
    const m = /^(\S+) (\d+)개$/.exec(part);
    assert.ok(m, `집계 형식이 아닙니다: ${part}`);
    return [m[1], Number(m[2])];
  }));
  for (const root of ['src', 'worker/src']) {
    assert.ok(counts.has(root), `${root}의 개수가 없습니다`);
    assert.ok(counts.get(root) > 0, `${root}에서 0개를 셌습니다`);
  }
});

test('뿌리 하나를 걷지 못하면 빨강이다 — 나머지 뿌리의 개수로 통과하지 않는다', () => {
  const r = runWithRoots(['src', 'worker/src-존재하지-않음']);
  assert.notEqual(r.code, 0, '뿌리를 못 걸었는데 통과했습니다');
  assert.match(r.err, /worker\/src-존재하지-않음/, '어느 뿌리였는지 말하지 않습니다');
  assert.match(r.err, /뿌리를 걷지 못했습니다/);
  assert.doesNotMatch(r.out, /✅/, '빨강인데 통과 문장을 찍었습니다');
});

test('첫 뿌리가 사라져도 빨강이다 — 마지막 뿌리만 보는 수정이 아니다', () => {
  const r = runWithRoots(['src-존재하지-않음', 'worker/src']);
  assert.notEqual(r.code, 0, '첫 뿌리를 못 걸었는데 통과했습니다');
  assert.match(r.err, /src-존재하지-않음/);
});

test('뿌리가 있어도 검사 대상이 0개면 빨강이다', () => {
  // `supabase/migrations`는 실재하지만 `.ts`가 하나도 없다 (전부 `.sql`).
  // 걷기는 성공하므로 예외로는 잡히지 않는다 — 개수로 잡아야 한다.
  const r = runWithRoots(['src', 'supabase/migrations']);
  assert.notEqual(r.code, 0, '대상 0개인 뿌리를 통과시켰습니다');
  assert.match(r.err, /supabase\/migrations/);
  assert.match(r.err, /0개입니다/);
});
