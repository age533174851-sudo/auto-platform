// scripts/test-ui-inventory-comments.mjs
//
// **UI Inventory 검사기가 주석을 "실제 화면"으로 세지 않는다.**
//
// 이 검사기의 ⑦이 막으려는 상태는 본문에 적혀 있다 — "적은 것만 목록에
// 있다"는 상태는 목록이 없는 것과 같고, "목록이 실제와 갈리면, 그 목록을
// 보고 내리는 판단이 전부 틀립니다."
//
// 그런데 두 판정이 원문을 훑고 있었다:
//
//   · registry 에 남은 화면의 `case 'x': return <Y` 가 **주석에만** 있어도
//     "그릴 화면이 있다"로 통과했다 (죽은 항목이 조용히 남는다)
//   · NAVIGATION 의 심볼이 개명됐는데 **주석에 옛 이름**이 있으면
//     "이름이 바뀌었습니다"를 내지 않았다
//
// ★ 가 그 둘이고 나머지는 대조다. 대조는 **어느 판정이 울렸는지**까지
// 메시지로 확인한다 — 다른 이유로 빨개진 것을 구멍이 닫혔다고 읽으면
// 안 된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-ui-inventory.mjs');
const PREFIX = 'uiinv-cmt-';

const PAGE = 'src/app/page.tsx';
const MENU = 'src/lib/menuItems.tsx';

// 실제 모양. 바뀌면 주입이 조용히 실패하므로 **단계마다** 확인한다.
const CASE_LINE = "        case 'easy':         return <EasyModePage onNav={nav}/>;\n";
const SWITCH = '      switch(tab) {';

/**
 * 격리 사본. `src` 는 **실제 디렉터리 + 파일 심볼릭 링크**로 비춘다.
 *
 * 디렉터리까지 심볼릭 링크로 두면 안 된다 — 검사기의 라우트·겹치는 층
 * 탐색이 `readdirSync(..., { withFileTypes: true })` 의 `isDirectory()` 로
 * 내려가는데, 심볼릭 링크는 거기서 디렉터리가 아니다. 그러면 라우트가
 * 0개로 읽혀 **엉뚱한 이유로** 빨개진다.
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

/** `plan`은 {경로: [[이름, 변이], …]}. 각 단계가 실제로 바꿨는지 확인한다. */
function fixture(plan = {}) {
  const overrides = new Map();
  for (const [rel, steps] of Object.entries(plan)) {
    let text = readFileSync(join(ROOT, rel), 'utf8');
    for (const [name, fn] of steps) {
      const next = fn(text);
      assert.notEqual(next, text, `주입이 적용되지 않았다: ${rel} / ${name}`);
      text = next;
    }
    overrides.set(rel, text);
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
    const out = execFileSync(process.execPath, [CHECKER], { cwd: dir, stdio: 'pipe', timeout: 300_000 });
    return { rc: 0, out: out.toString() };
  } catch (e) {
    return { rc: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function withFixture(plan, fn) {
  const dir = fixture(plan);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const DEAD = '`tab:easy`를 그리는 분기가 page.tsx에 없습니다';
const RENAMED = '이름이 바뀌었습니다';

// ── 변이 조각 ──
const killCase = ['easy 분기 삭제', (s) => s.replace(CASE_LINE, '')];
const cmtCase = ['주석에 그 분기', (s) => s.replace(SWITCH, `      // ${CASE_LINE.trim()}\n${SWITCH}`)];
const cmtPlain = ['토큰 없는 주석', (s) => s.replace(SWITCH, `      // 쉬운 화면은 다른 곳으로 옮겼다\n${SWITCH}`)];
const killSym = ['MENU 개명', (s) => s.replace(/\bMENU\b/g, 'MENU_RENAMED')];
const cmtSym = ['주석에 옛 이름', (s) => `// 이 목록은 예전에 MENU 라는 이름이었다\n${s}`];
const cmtSymPlain = ['토큰 없는 주석', (s) => `// 이 목록은 예전에 다른 이름이었다\n${s}`];

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture({}, runIn);
  assert.equal(r.rc, 0, r.out.slice(-400));
});

test('대조 — easy 분기를 삭제하면 막는다 (죽은 항목 판정이 동작하는가)', () => {
  const r = withFixture({ [PAGE]: [killCase] }, runIn);
  assert.equal(r.rc, 1);
  assert.ok(r.out.includes(DEAD), '다른 이유로 빨개졌다 — 이 대조는 의미가 없다');
});

test("★ 삭제하고 주석에만 `case 'easy': return <…` 가 있어도 막는다", () => {
  const r = withFixture({ [PAGE]: [killCase, cmtCase] }, runIn);
  assert.equal(r.rc, 1, '주석이 화면 분기로 세어졌다 — 죽은 registry 항목이 조용히 남는다');
  assert.ok(r.out.includes(DEAD), '막기는 했는데 다른 판정이 울렸다');
});

test('대조 — 삭제하고 그 토큰 없는 주석이면 원래도 막았다', () => {
  const r = withFixture({ [PAGE]: [killCase, cmtPlain] }, runIn);
  assert.equal(r.rc, 1);
  assert.ok(r.out.includes(DEAD));
});

test('대조 — NAVIGATION 심볼을 개명하면 막는다 (이름 판정이 동작하는가)', () => {
  const r = withFixture({ [MENU]: [killSym] }, runIn);
  assert.equal(r.rc, 1);
  assert.ok(r.out.includes(RENAMED), '다른 이유로 빨개졌다');
});

test('★ 개명하고 주석에만 옛 이름이 있어도 막는다', () => {
  const r = withFixture({ [MENU]: [killSym, cmtSym] }, runIn);
  assert.equal(r.rc, 1, '주석의 옛 이름이 개명을 가렸다');
  assert.ok(r.out.includes(RENAMED), '막기는 했는데 다른 판정이 울렸다');
});

test('대조 — 개명하고 그 이름 없는 주석이면 원래도 막았다', () => {
  const r = withFixture({ [MENU]: [killSym, cmtSymPlain] }, runIn);
  assert.equal(r.rc, 1);
  assert.ok(r.out.includes(RENAMED));
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture({}, runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
