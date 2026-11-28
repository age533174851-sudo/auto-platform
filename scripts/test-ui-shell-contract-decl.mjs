// scripts/test-ui-shell-contract-decl.mjs
//
// **사용자 정의 속성은 선언이 아니다.**
//
// `max-width:` 를 찾는 정규식은 `--max-width:` 안에서도 맞는다. 그건
// **CSS 사용자 정의 속성**이고 아무 일도 하지 않는다. `check-ui-shell-contract`
// 는 주석은 이미 지우고 보는데(`cssCode`) 이름 경계는 보지 않았다.
//
// 같은 결함군을 [Codex 가 #823 에서](https://github.com/age533174851-sudo/auto-platform/pull/823#issuecomment-7237339761)
// 먼저 짚었다. 이 검사기에서 다섯 자리를 재서 확인했다(main `ed00c1a4`):
//
//   구멍 (통과시킨다)
//     · `.aw` 의 칸 선언 둘을 `--grid-template-columns` 로  → rc=0
//       지우는 대조는 rc=1. **PC 3열 골격이 사라지는데 통과한다.**
//   과검출 (없는 위반을 만든다)
//     · `.mc` 에 `--max-width: 820px`                       → rc=1
//     · 전역 `*` 에 `--overflow: hidden`                     → rc=1
//     · `.menu-grid` 에 `--grid-template-columns: repeat(4,` → rc=1
//     · 접힘 규칙에 `--display: none`                        → rc=1
//
// 뒤 넷은 막는 쪽이 아니라 **거짓으로 막는** 쪽이다. 아무 일도 않는 속성
// 하나 때문에 멀쩡한 CSS 가 반려된다.
//
// ★ 과검출을 고치면서 **진짜 금지 모양을 같이 풀어 주면 안 된다.** 그래서
// 넷 다 "가짜는 통과 · 진짜는 막는다" 쌍으로 잰다. `CLAUDE.md`: 검사기를
// 약화시키지 않는다 — 막으면 검사기가 옳다.
//
// 규칙 원문은 시험이 **검사기가 보는 것과 같은 텍스트**(주석 제거 후)에서
// 떼어 온다. 원문에서 찾으면 주석을 집는다 — 실제로 한 번 그렇게 틀렸고,
// 지우는 대조가 rc=0 으로 나와서 알았다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { stripCssComments } from './lib/strip-comments.mjs';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-ui-shell-contract.mjs');
const PREFIX = 'us-decl-';
const CSS = 'src/app/globals.css';

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

function fixture(steps = []) {
  const overrides = new Map();
  for (const [file, name, fn] of steps) {
    const before = overrides.get(file) ?? readFileSync(join(ROOT, file), 'utf8');
    const after = fn(before);
    assert.notEqual(after, before, `주입이 적용되지 않았다: ${name} (${file})`);
    overrides.set(file, after);
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

/** 검사기가 보는 텍스트(주석 제거 후)에서 규칙을 떼어 온다 */
const cssCode = () => stripCssComments(readFileSync(join(ROOT, CSS), 'utf8'));

function awRules() {
  const out = [...cssCode().matchAll(/\.aw[^{}]*\{[^}]*?grid-template-columns:\s*[^;}]+/g)].map((m) => m[0]);
  assert.ok(out.length >= 1, `${CSS} 에서 .aw 칸 선언을 못 찾았다 — 골격이 바뀌었으면 이 시험도 같이 봐야 한다`);
  return out;
}
function mcRule() {
  const m = /\.mc\s*\{[^}]*\}/.exec(cssCode());
  assert.ok(m, `${CSS} 에서 .mc 규칙을 못 찾았다`);
  return m[0];
}

const renameAw = (to) => (s) => {
  let out = s;
  for (const r of awRules()) {
    assert.ok(out.includes(r), `원문에 .aw 규칙이 없다: ${r.slice(0, 40)}`);
    out = out.replace(r, r.replace('grid-template-columns:', to));
  }
  return out;
};
const intoMc = (decl) => (s) => {
  const r = mcRule();
  assert.ok(s.includes(r), '원문에 .mc 규칙이 없다');
  return s.replace(r, r.replace('{', `{ ${decl}`), 1);
};
const prepend = (text) => (s) => `${text}\n${s}`;

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture([], runIn);
  assert.equal(r.rc, 0, r.out.slice(-500));
});

test('대조 — `.aw` 칸 선언을 다른 이름으로 바꾸면 막는다', () => {
  const r = withFixture([[CSS, '.aw 칸 개명', renameAw('grid-cols-x:')]], runIn);
  assert.equal(r.rc, 1, '판정이 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
  assert.ok(r.out.includes('칸 선언을 못 찾았습니다'), '다른 이유로 빨개졌다');
});

test('★ `.aw` 칸 선언을 사용자 정의 속성으로 바꿔도 막는다', () => {
  const r = withFixture([[CSS, '.aw 칸 사용자 정의 속성화', renameAw('--grid-template-columns:')]], runIn);
  assert.equal(r.rc, 1,
    '사용자 정의 속성을 칸 선언으로 인정했다 — PC 3열 골격이 사라지는데 통과한다');
  assert.ok(r.out.includes('칸 선언을 못 찾았습니다'), '막기는 했는데 다른 판정이 울렸다');
});

// ── 과검출 넷: 가짜는 통과 · 진짜는 막는다 ──
//
// 쌍으로 잰다. 고치면서 진짜 금지 모양까지 풀어 주면 검사기를 약화시킨
// 것이고, 그건 하지 않는다.
test('과검출 — `.mc` 의 `--max-width` 로 막지 않는다 (진짜는 막는다)', () => {
  const fake = withFixture([[CSS, '.mc 가짜', intoMc('--max-width: 820px;')]], runIn);
  assert.equal(fake.rc, 0, `아무 일도 않는 속성을 위반으로 셌다\n${fake.out.slice(-300)}`);
  const real = withFixture([[CSS, '.mc 진짜', intoMc('max-width: 820px;')]], runIn);
  assert.equal(real.rc, 1, '진짜 고정 max-width 를 놓쳤다 — 검사기를 약화시켰다');
  assert.ok(real.out.includes('고정 max-width'), '막기는 했는데 다른 판정이 울렸다');
});

test('과검출 — 전역 `*` 의 `--overflow` 로 막지 않는다 (진짜는 막는다)', () => {
  const fake = withFixture([[CSS, '전역 가짜', prepend('* { --overflow: hidden; }')]], runIn);
  assert.equal(fake.rc, 0, `아무 일도 않는 속성을 위반으로 셌다\n${fake.out.slice(-300)}`);
  const real = withFixture([[CSS, '전역 진짜', prepend('* { overflow: hidden; }')]], runIn);
  assert.equal(real.rc, 1, '진짜 전역 overflow:hidden 을 놓쳤다 — 검사기를 약화시켰다');
  assert.ok(real.out.includes('전역 overflow:hidden'), '막기는 했는데 다른 판정이 울렸다');
});

test('과검출 — `.menu-grid` 의 `--grid-template-columns` 로 막지 않는다 (진짜는 막는다)', () => {
  const fake = withFixture([[CSS, '메뉴격자 가짜',
    (s) => `${s}\n.menu-grid { --grid-template-columns: repeat(4, 1fr); }\n`]], runIn);
  assert.equal(fake.rc, 0, `아무 일도 않는 속성을 위반으로 셌다\n${fake.out.slice(-300)}`);
  const real = withFixture([[CSS, '메뉴격자 진짜',
    (s) => `${s}\n.menu-grid { grid-template-columns: repeat(4, 1fr); }\n`]], runIn);
  assert.equal(real.rc, 1, '진짜 고정 열 수를 놓쳤다 — 검사기를 약화시켰다');
  assert.ok(real.out.includes('고정 열 수'), '막기는 했는데 다른 판정이 울렸다');
});

test('과검출 — 접힘 규칙의 `--display: none` 으로 막지 않는다 (진짜는 막는다)', () => {
  const fake = withFixture([[CSS, '접힘 가짜',
    (s) => `${s}\n.aw[data-left='compact'] .panel-toggle { --display: none; }\n`]], runIn);
  assert.equal(fake.rc, 0, `아무 일도 않는 속성을 위반으로 셌다\n${fake.out.slice(-300)}`);
  const real = withFixture([[CSS, '접힘 진짜',
    (s) => `${s}\n.aw[data-left='compact'] .panel-toggle { display: none; }\n`]], runIn);
  assert.equal(real.rc, 1, '접으면 펴는 버튼이 사라지는 규칙을 놓쳤다 — 검사기를 약화시켰다');
  assert.ok(real.out.includes('펴는 버튼까지 사라집니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture([], runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
