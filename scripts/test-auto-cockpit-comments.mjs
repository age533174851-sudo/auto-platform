// scripts/test-auto-cockpit-comments.mjs
//
// **"시험이 이 경우를 짚는다"를 주석으로 주장하지 못한다.**
//
// `check-auto-cockpit.mjs` 의 ① 과 ⑧ 은 시험 파일을 훑어 "시험이 있는가 ·
// 위험한 케이스를 짚는가"를 아홉 자리에서 판정한다. 그 판정이 **원문**을
// 보고 있었다 — 주석에 그 이름을 적어 두면 시험이 없어도 통과했다.
//
// 이 화면이 답하는 질문은 "지금 내 돈이 움직이는가"이고, 검사기 머리에
// 적힌 실제 사고는 **실전 예약이 켜져 있는데 화면이 "모의 자동매매 모드 —
// 실제 자금 이동 없음"이라고 적은 것**이다. 그 판정을 지키는 시험의
// 존재를 주석으로 주장할 수 있으면 보장이 빈 말이 된다.
//
// ★ 가 그 자리이고 나머지는 대조다.
//
// **아직 열려 있는 자리 하나** — 러너 등록 판정(`run-tests.mjs` 에
// `runAutoCockpitTests()` 가 있는가)은 그 호출이 `RUN_SRC` 템플릿 **안**에
// 있어서 공용 제거기로 닫히지 않는다. 템플릿 안에서 주석 처리하면 생성된
// 프로그램에서 시험이 안 돌면서 검사는 통과한다(측정: rc=0). 여기에 시험을
// 걸지 않는다 — 닫는 방법은 생성 소스 추출기(#807)를 `scripts/lib/` 로
// 옮겨 함께 쓰는 것이고, 같은 등록 앵커 자리가 7곳이라 복제하지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-auto-cockpit.mjs');
const PREFIX = 'ac-cmt-';
const PLANT = 'src/lib/ui/autoCockpit.test.ts';

const DECL = 'export function runAutoCockpitTests';
const NEEDLE = 'LIVE_LIMITED';

/**
 * 격리 사본. `src` 는 **실제 디렉터리 + 파일 심볼릭 링크**로 비춘다 —
 * 이 검사기는 여러 파일을 읽고 그 중 하나만 바꿔야 한다. 디렉터리까지
 * 링크로 두면 읽기는 되지만 덮어쓰기가 원본을 건드린다.
 */
function mirror(absDir, absDest, overrides) {
  mkdirSync(absDest, { recursive: true });
  for (const e of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, e.name);
    const rel = relative(ROOT, abs);
    if (e.isDirectory()) mirror(abs, join(absDest, e.name), overrides);
    else if (overrides.has(rel)) writeFileSync(join(absDest, e.name), overrides.get(rel));
    else symlinkSync(abs, join(absDest, e.name));
  }
}

/** `steps` = [[이름, 변이], …]. 단계마다 실제로 바뀌었는지 확인한다. */
function fixture(steps = []) {
  const overrides = new Map();
  if (steps.length) {
    let text = readFileSync(join(ROOT, PLANT), 'utf8');
    for (const [name, fn] of steps) {
      const next = fn(text);
      assert.notEqual(next, text, `주입이 적용되지 않았다: ${name}`);
      text = next;
    }
    overrides.set(PLANT, text);
  }
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    if (e.name === 'src') { mirror(join(ROOT, 'src'), join(dir, 'src'), overrides); continue; }
    symlinkSync(join(ROOT, e.name), join(dir, e.name));
  }
  return dir;
}

function runIn(dir) {
  try {
    execFileSync(process.execPath, [CHECKER], { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    return { rc: 0, out: '' };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function withFixture(steps, fn) {
  const dir = fixture(steps);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 변이 조각 ──
const renameDecl = ['시험 선언 개명',
  (s) => s.replaceAll(DECL, 'export function runAutoCockpitSuite')];
const cmtDecl = ['주석에 옛 선언', (s) => `// 예전 이름: ${DECL}\n${s}`];
const cmtPlain = ['토큰 없는 주석', (s) => `// 이름을 바꿨다\n${s}`];
const dropNeedle = [`${NEEDLE} 제거`, (s) => s.replaceAll(NEEDLE, 'LIVE_SOMETHING_ELSE')];
const cmtNeedle = [`주석에 ${NEEDLE}`, (s) => `// ${NEEDLE} 섞인 경우도 본다\n${s}`];

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture([], runIn);
  assert.equal(r.rc, 0, r.out.slice(-400));
});

test('대조 — 시험 선언을 개명하면 막는다 (판정이 동작하는가)', () => {
  const r = withFixture([renameDecl], runIn);
  assert.equal(r.rc, 1, '판정이 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
  assert.ok(r.out.includes('테스트가 없습니다'), '다른 이유로 빨개졌다');
});

test('★ 개명하고 주석에 옛 선언을 적어도 막는다', () => {
  const r = withFixture([renameDecl, cmtDecl], runIn);
  assert.equal(r.rc, 1, '주석이 시험의 존재를 가장했다');
  assert.ok(r.out.includes('테스트가 없습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('대조 — 개명하고 토큰 없는 주석이면 원래도 막았다', () => {
  const r = withFixture([renameDecl, cmtPlain], runIn);
  assert.equal(r.rc, 1);
  assert.ok(r.out.includes('테스트가 없습니다'));
});

test(`대조 — 위험 케이스(${NEEDLE})를 시험에서 지우면 막는다`, () => {
  const r = withFixture([dropNeedle], runIn);
  assert.equal(r.rc, 1);
  assert.ok(r.out.includes('실전이 섞였을 때'), '다른 이유로 빨개졌다');
});

test(`★ 지우고 주석에만 ${NEEDLE} 를 적어도 막는다`, () => {
  const r = withFixture([dropNeedle, cmtNeedle], runIn);
  assert.equal(r.rc, 1, '주석이 시험 범위를 가장했다 — 실전 혼입 케이스가 안 돌아도 통과한다');
  assert.ok(r.out.includes('실전이 섞였을 때'), '막기는 했는데 다른 판정이 울렸다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture([], runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
