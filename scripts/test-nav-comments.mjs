// scripts/test-nav-comments.mjs
//
// **메뉴 배선 검사기가 주석을 배선으로 세지 않는다.**
//
// `check-nav.mjs` 가 막으려는 고장은 그 파일 머리에 적혀 있다:
// `MENU` 에 id 는 있는데 그 id 를 받는 화면 분기가 없어서, **누르면
// 아무 일도 안 일어나는 메뉴**가 생긴 적이 있다.
//
// 그런데 판정이 셋 다 원문을 훑고 있었다. 주석 하나로 전부 만족된다 —
// 기계 탐침으로 실제로 돌려 확인했다:
//
//   · 주석에만 `case 'trading':` 를 적으면          통과했다
//   · 메뉴 블록에 `/* disabled: true */` 를 적으면  통과했다 (면제 위조)
//   · 메뉴 블록에 `/* href: … */` 를 적으면         통과했다 (면제 위조)
//
// ★ 가 그 셋이다. 그리고 **진짜 면제는 그대로 동작해야** 하므로
// (`disabled: true` · `href:` 를 코드로 적은 경우) 그 둘도 대조로 잠근다
// — 좁히다가 옳게 동작하는 길을 막으면 안 된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-nav.mjs');
const PREFIX = 'nav-cmt-';

const MENU = 'src/lib/menuItems.tsx';
const PAGE = 'src/app/page.tsx';
const NEEDED = [MENU, PAGE];

// 실제 모양. 바뀌면 주입이 조용히 실패하므로 **단계마다** 확인한다.
const SWITCH = '      switch(tab) {';
const CASE = "case 'trading':";
const BLOCK = "{ id:'trading',";

/**
 * 격리 사본. `plan`은 {경로: [[이름, 변이], …]}.
 * 각 변이가 **실제로 본문을 바꿨는지** 단계마다 확인한다 — 앞 단계가
 * 이미 바꿔 놓으면 통째 비교로는 주입 실패를 못 잡는다(탐침을 쓰다가
 * 실제로 그렇게 한 번 속았다).
 */
function fixture(plan = {}) {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  for (const rel of NEEDED) {
    let text = readFileSync(join(ROOT, rel), 'utf8');
    for (const [name, fn] of plan[rel] ?? []) {
      const next = fn(text);
      assert.notEqual(next, text, `주입이 적용되지 않았다: ${rel} / ${name}`);
      text = next;
    }
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  return dir;
}

function runIn(dir) {
  try {
    execFileSync(process.execPath, [CHECKER], { cwd: dir, stdio: 'pipe', timeout: 120_000 });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

function withFixture(plan, fn) {
  const dir = fixture(plan);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 변이 조각 ──
const killCase = ['분기 제거', (s) => s.replace(CASE, "case 'trading_x':")];
const line = (text) => (s) => s.replace(SWITCH, `      ${text}\n${SWITCH}`);
const inBlock = (text) => (s) => s.replace(BLOCK, `${BLOCK} ${text}`);

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  assert.equal(withFixture({}, runIn), 0);
});

test('대조 — 화면 분기를 없애면 막는다 (요구 앵커가 동작하는가)', () => {
  assert.equal(withFixture({ [PAGE]: [killCase] }, runIn), 1,
    '요구 앵커가 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
});

test("★ 주석에만 `case 'trading':` 가 있어도 막는다", () => {
  const plan = { [PAGE]: [killCase, ['주석에 분기', line(`// ${CASE} 는 예전에 여기 있었다`)]] };
  assert.equal(withFixture(plan, runIn), 1,
    '주석이 화면 분기를 가장했다 — 눌러도 아무 일도 안 일어나는 메뉴가 통과한다');
});

test('대조 — 그 토큰 없는 주석이면 원래도 막았다', () => {
  const plan = { [PAGE]: [killCase, ['토큰 없는 주석', line('// 매매 화면은 다른 곳으로 옮겼다')]] };
  assert.equal(withFixture(plan, runIn), 1);
});

test('★ 블록 주석의 `disabled: true` 로 면제를 위조하지 못한다', () => {
  const plan = { [PAGE]: [killCase], [MENU]: [['주석 disabled', inBlock('/* disabled: true */')]] };
  assert.equal(withFixture(plan, runIn), 1, '주석이 "준비 중" 면제를 위조했다');
});

test('★ 블록 주석의 `href:` 로 면제를 위조하지 못한다', () => {
  const plan = { [PAGE]: [killCase], [MENU]: [['주석 href', inBlock("/* href: '/trade' */")]] };
  assert.equal(withFixture(plan, runIn), 1, '주석이 "독립 경로" 면제를 위조했다');
});

test('대조 — 코드로 적은 `disabled: true` 는 그대로 면제된다', () => {
  const plan = { [PAGE]: [killCase], [MENU]: [['코드 disabled', inBlock('disabled: true,')]] };
  assert.equal(withFixture(plan, runIn), 0,
    '좁히다가 옳게 동작하는 면제를 막았다');
});

test('대조 — 코드로 적은 `href:` 는 그대로 면제된다', () => {
  const plan = { [PAGE]: [killCase], [MENU]: [['코드 href', inBlock("href: '/trade',")]] };
  assert.equal(withFixture(plan, runIn), 0,
    '좁히다가 옳게 동작하는 면제를 막았다');
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture({}, runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
