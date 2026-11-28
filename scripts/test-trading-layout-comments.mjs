// scripts/test-trading-layout-comments.mjs
//
// **주석 처리한 줄은 계약이 아니다 — CSS 도.**
//
// `check-trading-layout.mjs`는 TS/TSX 를 주석을 지우고 보면서(`code[f]`)
// **CSS 만 원문으로** 보고 있었다. 한 검사기 안에서 경로가 둘이었다.
//
// 실측 (main `ed00c1a4` · 지우는 대조 둘은 rc=1):
//
//   · 겹쳐 여는 레일 규칙 전체를 주석으로 감싼다          → rc=0
//   · 규칙은 살려 두고 `position: fixed` 한 줄만 주석     → rc=0
//   · 규칙 안 주석에 `}` 가 들어간다                      → rc=1 (없는 위반)
//
// 두 번째가 가장 그럴듯하다. 규칙은 그대로 있고 한 줄만 꺼 보는 것이라
// 되돌리는 것을 잊기 쉽다. 그때 겹쳐 여는 레일이 다시 흐름 안으로 들어와
// **거래영역의 폭을 가져가는데** 관문은 초록이다 — 이 검사기가 막으려고
// 있는 바로 그 고장이다(머리말: 1440에서 뉴스 레일을 칸으로 열자 매매
// 영역이 900px 로 떨어졌다).
//
// 세 번째는 반대 방향이다. 본문을 `[\s\S]*?\}` 로 떼므로 주석 안의 `}` 에서
// 끊겨 `position: fixed` 를 못 보고 **없는 위반을 만든다.**

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-trading-layout.mjs');
const PREFIX = 'tl-cmt-';
const CSS = 'src/app/globals.css';

/** 격리 사본. `src` 는 실제 디렉터리 + 파일 심링크로 비춘다 */
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

/** 겹쳐 여는 레일 규칙을 **원문에서** 떼어 온다 — 모양을 가정하지 않게 */
function overlayRule() {
  const src = readFileSync(join(ROOT, CSS), 'utf8');
  const m = /\.aw\[data-rail-overlay='1'\] \.rp \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, `${CSS} 에서 겹쳐 여는 레일 규칙을 찾지 못했다 — 모양이 바뀌었으면 이 시험도 같이 봐야 한다`);
  assert.ok(m[0].includes('position: fixed'), '규칙에 position: fixed 가 없다');
  return m[0];
}

const swap = (a, b) => (s) => {
  assert.ok(s.includes(a), `원문에 없다: ${String(a).slice(0, 50)}`);
  return s.replace(a, b);
};

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture([], runIn);
  assert.equal(r.rc, 0, r.out.slice(-500));
});

test('대조 — 선택자를 바꾸면 막는다 (판정이 동작하는가)', () => {
  const r = withFixture([[CSS, '선택자 변경',
    swap("\n.aw[data-rail-overlay='1'] .rp {", "\n.aw[data-rail-overlay='9'] .rp {")]], runIn);
  assert.equal(r.rc, 1, '판정이 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
  assert.ok(r.out.includes('레일 규칙이 없습니다'), '다른 이유로 빨개졌다');
});

test('대조 — 규칙 안의 position: fixed 를 지우면 막는다', () => {
  const rule = overlayRule();
  const r = withFixture([[CSS, 'fixed 제거',
    swap(rule, rule.replace('position: fixed;', 'position: static;'))]], runIn);
  assert.equal(r.rc, 1);
  assert.ok(r.out.includes('흐름에서 빠지지 않습니다'), '다른 이유로 빨개졌다');
});

test('★ 겹쳐 여는 레일 규칙 전체를 주석으로 감싸도 막는다', () => {
  const rule = overlayRule();
  const r = withFixture([[CSS, '규칙 주석', swap(rule, `/* ${rule} */`)]], runIn);
  assert.equal(r.rc, 1, '주석 처리한 규칙이 규칙의 존재를 가장했다 — 표식만 붙고 화면은 그대로다');
  assert.ok(r.out.includes('레일 규칙이 없습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('★ 규칙은 살려 두고 position: fixed 한 줄만 주석 처리해도 막는다', () => {
  const rule = overlayRule();
  const r = withFixture([[CSS, '한 줄 주석',
    swap(rule, rule.replace('position: fixed;', '/* position: fixed; */'))]], runIn);
  assert.equal(r.rc, 1,
    '꺼 둔 한 줄이 계약으로 읽혔다 — 겹쳐 여는 레일이 다시 거래영역의 폭을 가져간다');
  assert.ok(r.out.includes('흐름에서 빠지지 않습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('과검출 — 규칙 안 주석의 `}` 로 없는 위반을 만들지 않는다', () => {
  const rule = overlayRule();
  const r = withFixture([[CSS, '주석에 닫는 중괄호',
    swap(rule, rule.replace('position: fixed;', '/* 닫는 중괄호 } 가 든 설명 */\n  position: fixed;'))]], runIn);
  assert.equal(r.rc, 0,
    `주석 안의 }에서 본문 추출이 끊겨 없는 위반을 만들었다\n${r.out.slice(-400)}`);
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture([], runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});

// ── 선언 이름의 왼쪽 경계 ──
//
// 주석만 막아서는 부족했다. `position:` 을 찾는 정규식은 `--position:`
// 안에서도 맞는다 — 그건 **사용자 정의 속성**이고 흐름에서 빼 주지 않는다.
//
// 같은 결함군을 [Codex 가 #823 에서](https://github.com/age533174851-sudo/auto-platform/pull/823#issuecomment-7237339761)
// 먼저 짚었다(거기서는 `margin-right`·`min-height`). 이 파일에서도 재서
// 확인했다 — rc=0 이었다.
test('★ position 을 사용자 정의 속성으로 바꿔도 막는다', () => {
  const rule = overlayRule();
  const broken = rule.replace('position: fixed;', '--position: fixed;');
  assert.notEqual(broken, rule, '원문 모양이 바뀌었다 — 이 시험도 같이 봐야 한다');
  const r = withFixture([[CSS, 'position 사용자 정의 속성화', swap(rule, broken)]], runIn);
  assert.equal(r.rc, 1,
    '사용자 정의 속성(--position)을 실제 선언으로 인정했다 — 레일은 여전히 흐름 안에 있다');
  assert.ok(r.out.includes('흐름에서 빠지지 않습니다'), '막기는 했는데 다른 판정이 울렸다');
});
