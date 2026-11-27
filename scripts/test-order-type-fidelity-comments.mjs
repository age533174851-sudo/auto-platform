// scripts/test-order-type-fidelity-comments.mjs
//
// **주문유형 일치 관문이 "적혀 있는 것"에 속지 않는가.**
//
// 이 검사기는 공용 `stripJsComments` 를 **복사해 두고** 있었다(`stripJs`).
// 공용 파일의 머리글이 그 위험을 미리 적어 두었다:
//
//   그래서 이 함수를 **한 곳에만** 둔다. 검사기마다 각자 복사해 두면 언젠가
//   한쪽만 고쳐지고, 그때부터 그 검사기는 조용히 아무것도 막지 않는다.
//
// 기계 탐침으로 실제로 돌려 세 자리를 확인했다(TS 구문 유효).
//
//   A 사본이 **정규식 리터럴을 모른다**
//        const QUOTES = /["']+/g;
//        // export function sizingPriceOf
//        export function zizingPriceOf(t) { … }
//      가짜 문자열 상태에 빠져 `//` 를 주석으로 안 보므로 주석 본문이 코드로
//      남고, 정본 함수가 사라졌는데 통과했다. **원인 대조**: 정규식 없이
//      같은 주석만 남기면 rc=1 이다.
//
//   B 등록 확인이 **생성 러너 템플릿 안**을 소스로 읽지 않았다
//        zunOrderTypesTests() // runOrderTypesTests();
//      `run-tests.mjs` 는 러너를 `const RUN_SRC = \`…\`` 템플릿으로 들고
//      있다가 `run.ts` 로 써 낸다. 호스트의 주석을 걷어도 템플릿은 문자열
//      이라 손대지 않으므로, 생성된 파일에서는 주석인데 검사기는 통과했다.
//
//   C 시험 파일을 원문으로 읽었다
//      회귀 시험 이름을 바꾸고 원래 이름을 주석에 남기면 통과했다. 그 시험이
//      지키는 것이 "지정가 수량은 지정가로 나눈다"이고, 빠지면 사용자가 적은
//      명목가와 실제 체결 명목가가 갈린다(100 → 80 USDT).
//
// **A 는 이 변경만으로 닫히지 않는다.** 지금 main 의 공용 함수도 같은 탈선을
// 갖고 있다. 사본을 지우는 것은 **고칠 자리를 하나로 만드는** 일이고, PR #795
// 가 그 한 자리를 고친다(실측: 같은 변이에서 주석 문구가 코드로 남는가 —
// 사본 true · main 공용 true · #795 false). 여기서는 **사본이 사라졌다는
// 것**과 B·C 가 닫혔다는 것을 잠근다. 열린 구멍을 통과로 못 박지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve('.');
const CHECKER_REL = 'scripts/check-order-type-fidelity.mjs';
const CHECKER = join(REPO, CHECKER_REL);
const TYPES = 'src/lib/markets/orderTypes.ts';
const TEST_FILE = 'src/lib/markets/orderTypes.test.ts';
const RUNNER = 'scripts/run-tests.mjs';
const PREFIX = 'otf-cmt-';

/** 이 시험이 만든 임시 폴더만 센다 */
function ownTempDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX));
}

/**
 * 검사기를 격리된 작업 폴더에서 돌린다. `src` 와 `scripts` 를 복사하고
 * 나머지는 심링크한다 — 이 검사기는 `scripts/run-tests.mjs` 도 읽으므로
 * 그쪽을 바꿔 보려면 사본이 필요하다.
 * **`finally` 로 반드시 치운다**: 쓰기 공간이 고정 할당이라 남기면 다음
 * 작업이 디스크로 막힌다.
 */
function runChecker(mutate) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  try {
    for (const e of readdirSync(REPO)) {
      if (e === 'src' || e === 'scripts' || e === '.git') continue;
      symlinkSync(join(REPO, e), join(dir, e));
    }
    for (const d of ['src', 'scripts']) {
      cpSync(join(REPO, d), join(dir, d), { recursive: true });
    }
    if (mutate) mutate((rel) => join(dir, rel));
    const r = spawnSync('node', [join(dir, CHECKER_REL)], { cwd: dir, encoding: 'utf8' });
    return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function edit(path, fn) {
  const s = readFileSync(path, 'utf8');
  const out = fn(s);
  assert.notEqual(out, s, '바꿀 자리를 못 찾았습니다 — 못 찾은 것을 통과로 적지 않습니다');
  writeFileSync(path, out);
}

const SZ = 'export function sizingPriceOf';
const CALL = 'runOrderTypesTests()';
const CASE = '화면 선택지는 서버 목록의 부분집합이다';

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(runChecker(null).rc, 0);
});

// ── A 사본이 사라졌다 ───────────────────────────────────────────
test('★ 이 검사기에 주석 걷기 사본이 없다 — 공용 함수를 쓴다', () => {
  // 판단을 두 벌로 두지 않는다. 사본이 돌아오면 이 시험이 잡는다.
  const src = readFileSync(CHECKER, 'utf8');
  assert.match(src, /import \{ stripJsComments \} from '\.\/lib\/strip-comments\.mjs'/);
  assert.equal(/^function stripJs\s*\(/m.test(src), false, '주석 걷기 사본이 다시 생겼습니다');
  assert.equal(/let out = '', i = 0, quote = null;/.test(src), false, '사본의 본문이 남아 있습니다');
});

test('대조 — sizingPriceOf 이름을 바꾸면 막는다 (앵커가 필요하긴 한가)', () => {
  const r = runChecker((p) => edit(p(TYPES), (s) => s.replace(SZ, 'export function zizingPriceOf')));
  assert.notEqual(r.rc, 0);
});

test('대조 — 정규식 없이 같은 주석만 남기면 막는다 (탈선이 원인이라는 대조)', () => {
  const r = runChecker((p) => edit(p(TYPES), (s) =>
    s.replace(SZ, `// ${SZ}\nexport function zizingPriceOf`)));
  assert.notEqual(r.rc, 0, '보통 주석이 코드로 셌습니다');
});

// ── B 생성 러너 템플릿 ─────────────────────────────────────────
test('대조 — 생성 러너에서 호출을 지우면 막는다', () => {
  const r = runChecker((p) => edit(p(RUNNER), (s) => s.replace(CALL, 'zunOrderTypesTests()')));
  assert.notEqual(r.rc, 0);
});

test('★ 템플릿 안에서 호출을 주석으로만 남기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(RUNNER), (s) =>
    s.replace(CALL, `zunOrderTypesTests() // ${CALL}`)));
  assert.notEqual(r.rc, 0, '생성된 run.ts 에서는 주석인데 통과했습니다');
  console.log('    거부 확인 · 생성 러너 템플릿 안의 꼬리 주석');
});

test('★ 템플릿 본문을 못 떼면 조용히 통과하지 않고 크게 실패한다', () => {
  // 모양이 바뀌면 빈 문자열이 되어 앵커가 없다고 실패한다 — 막히면 관문이 옳다.
  const r = runChecker((p) => edit(p(RUNNER), (s) =>
    s.replace('const RUN_SRC = `', 'const RUN_SOURCE = `')));
  assert.notEqual(r.rc, 0);
  assert.match(r.out, /runOrderTypesTests\(\)/);
});

// ── C 시험 파일 ────────────────────────────────────────────────
test('대조 — 회귀 시험 이름을 바꾸면 막는다', () => {
  const r = runChecker((p) => edit(p(TEST_FILE), (s) => s.replace(CASE, 'xx 다른 이름 xx')));
  assert.notEqual(r.rc, 0);
});

test('★ 시험을 없애고 이름만 주석에 남기면 통과하지 않는다', () => {
  const r = runChecker((p) => edit(p(TEST_FILE), (s) =>
    `${s.replace(CASE, 'xx 다른 이름 xx')}\n// ${CASE}\n`));
  assert.notEqual(r.rc, 0, '주석에 남은 시험 이름을 시험으로 셌습니다');
  console.log('    거부 확인 · 시험 이름을 주석으로');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = new Set(ownTempDirs());
  runChecker(null);
  assert.deepEqual(ownTempDirs().filter((n) => !before.has(n)), []);
});
