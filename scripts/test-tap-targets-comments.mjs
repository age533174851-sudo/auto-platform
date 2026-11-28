// scripts/test-tap-targets-comments.mjs
//
// **주석 처리한 줄은 계약이 아니다.**
//
// `check-tap-targets.mjs`는 `panelPrefs`·`NotifyHost`·화면 셋은 주석을
// 지우고 보면서 **CSS 와 `page.tsx`·`AutoPage.tsx` 는 원문으로** 보고
// 있었다. 한 검사기 안에서 경로가 둘이었고, 안 지우는 쪽이 전부 구멍이었다.
//
// 실측(main `ed00c1a4` · 지우는 대조는 모두 rc=1):
//
//   · `--tap` 선언을 주석으로 감싼다                → rc=0
//   · `--notify-band` 를 주석으로 감싼다            → rc=0
//   · 헤더가 띠를 비우는 규칙을 주석으로 감싼다      → rc=0
//   · 자동매매 화면 바닥 규칙을 주석으로 감싼다      → rc=0
//   · `data-region` 표식을 주석에 적는다(블록·줄)    → rc=0
//   · 헤더 벨 태그를 주석에 적는다                   → rc=0
//   · 금지 모양을 주석에만 적는다                    → rc=1 (과검출)
//
// 세 번째가 이 검사기 머리말의 **실측 사고**를 지키는 규칙이다 — 벨이
// 1024px 미만에서 로그인 버튼을 1376px² 덮었다. 그 규칙을 주석으로 덮어도
// 초록이었다.
//
// ★★ 고치면서 **내가 구멍을 하나 만들었다.** 바닥 규칙 판정이
// `[\s\S]{0,160}?` 로 거리를 재고 있어서, 주석을 지우자 글자가 줄어들며
// **다른 규칙의** `min-height: var(--tap)` 이 그 창 안으로 들어왔다. 그때
// 바닥 규칙을 `max-height` 로 바꿔 놓아도 통과했다. 규칙의 **본문**만 보게
// 바꿨고, 아래 `대조 ★★` 가 그 자리를 고정한다. 이 줄이 빨개지면 거리로
// 세는 판정이 돌아온 것이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const CHECKER = join(ROOT, 'scripts', 'check-tap-targets.mjs');
const PREFIX = 'tap-cmt-';

const CSS = 'src/app/globals.css';
const AUTO = 'src/components/pages/AutoPage.tsx';
const APP = 'src/app/page.tsx';

/**
 * 격리 사본. `src` 는 **실제 디렉터리 + 파일 심볼릭 링크**로 비춘다 —
 * 이 검사기는 일곱 파일을 읽고 그 중 하나만 바꿔야 한다. 디렉터리까지
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

/** `steps` = [[파일, 이름, 변이], …]. **단계마다** 실제로 바뀌었는지 본다. */
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

/** 원문에서 그 규칙 덩어리를 떼어 온다 — 시험이 원문 모양을 가정하지 않게 */
function block(file, re) {
  const m = re.exec(readFileSync(join(ROOT, file), 'utf8'));
  assert.ok(m, `원문에서 찾지 못했다: ${re}`);
  return m[0];
}

const TAP_DECL = '  --tap: 40px;';
const BAND_DECL = '  --notify-band: 48px;';
const BAND_RULE = () => block(CSS,
  /@media \(max-width: 1023px\)[\s\S]{0,200}?\.hdr-actions\s*\{[^}]*margin-right:\s*var\(--notify-band\)[^}]*\}/);
const FLOOR_RULE = () => block(CSS, /\[data-region='autoPage'\][^{}]*\{[^}]*\}/);
const BELL = "<button onClick={()=>nav('alerts')}";

const wrap = (t) => `/* ${t} */`;
const sub = (a, b) => (s) => {
  assert.ok(s.includes(a), `원문에 없다: ${String(a).slice(0, 40)}`);
  return s.replace(a, b);
};

test('원문 복사본은 통과한다 (대조 — 좁히는 대가 0)', () => {
  const r = withFixture([], runIn);
  assert.equal(r.rc, 0, r.out.slice(-500));
});

test('대조 — `--tap` 선언을 지우면 막는다 (판정이 동작하는가)', () => {
  const r = withFixture([[CSS, '--tap 개명', sub(TAP_DECL, '  --tapz: 40px;')]], runIn);
  assert.equal(r.rc, 1, '판정이 동작하지 않는다 — 아래 ★ 시험은 의미가 없다');
  assert.ok(r.out.includes('--tap 변수가 없습니다'), '다른 이유로 빨개졌다');
});

test('★ `--tap` 선언을 주석으로 감싸도 막는다', () => {
  const r = withFixture([[CSS, '--tap 주석', sub(TAP_DECL, wrap(TAP_DECL))]], runIn);
  assert.equal(r.rc, 1, '주석 처리한 선언이 변수의 존재를 가장했다 — 모든 var(--tap)이 빈 값이 된다');
  assert.ok(r.out.includes('--tap 변수가 없습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('★ `--notify-band` 를 주석으로 감싸도 막는다', () => {
  const r = withFixture([[CSS, 'band 주석', sub(BAND_DECL, wrap(BAND_DECL))]], runIn);
  assert.equal(r.rc, 1, '주석이 띠 폭의 존재를 가장했다');
  assert.ok(r.out.includes('--notify-band'), '막기는 했는데 다른 판정이 울렸다');
});

test('★ 헤더가 띠를 비우는 규칙을 주석으로 감싸도 막는다 (실측 사고를 지키는 규칙)', () => {
  const rule = BAND_RULE();
  const r = withFixture([[CSS, '헤더 띠 규칙 주석', sub(rule, wrap(rule))]], runIn);
  assert.equal(r.rc, 1, '주석이 규칙의 존재를 가장했다 — 벨이 로그인 버튼을 덮는다');
  assert.ok(r.out.includes('띠를 비우지 않습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('★ 자동매매 화면 바닥 규칙을 주석으로 감싸도 막는다', () => {
  const rule = FLOOR_RULE();
  const r = withFixture([[CSS, '바닥 규칙 주석', sub(rule, wrap(rule))]], runIn);
  assert.equal(r.rc, 1, '주석이 바닥 규칙의 존재를 가장했다');
  assert.ok(r.out.includes('바닥 규칙이 없습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('대조 ★★ — 바닥 규칙의 min-height 를 바꾸면 막는다 (거리로 세지 않는가)', () => {
  const rule = FLOOR_RULE();
  const broken = rule.replace('min-height: var(--tap)', 'max-height: var(--tap)');
  assert.notEqual(broken, rule, '원문 모양이 바뀌었다 — 이 시험도 같이 봐야 한다');
  const r = withFixture([[CSS, '바닥 규칙 무력화', sub(rule, broken)]], runIn);
  assert.equal(r.rc, 1,
    '다른 규칙의 min-height 가 대신 통과시켰다 — 거리(`{0,160}`)로 세는 판정이 돌아왔다');
  assert.ok(r.out.includes('바닥 규칙이 없습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('★ `data-region` 표식을 주석에 적어도 막는다 (블록·줄 둘 다)', () => {
  for (const [name, cmt] of [
    ['블록 주석', (s) => `/* data-region="autoPage" */\n${s}`],
    ['줄 주석', (s) => `// data-region="autoPage"\n${s}`],
  ]) {
    const r = withFixture([
      [AUTO, '표식 개명', (s) => {
        assert.ok(s.includes('data-region="autoPage"'), '원문에 표식이 없다');
        return s.replaceAll('data-region="autoPage"', 'data-region="autoPageX"');
      }],
      [AUTO, name, cmt],
    ], runIn);
    assert.equal(r.rc, 1, `주석이 표식을 가장했다 (${name}) — 바닥 규칙이 걸릴 곳이 없다`);
    assert.ok(r.out.includes('표식이 없습니다'), `막기는 했는데 다른 판정이 울렸다 (${name})`);
  }
});

test('★ 헤더 벨 태그를 주석에 적어도 막는다', () => {
  const r = withFixture([
    [APP, '헤더 벨 개명', sub(BELL, "<button onClick={()=>nav('alertsX')}")],
    [APP, '주석에 헤더 벨', (s) => `// ${BELL} aria-label="알림" >\n${s}`],
  ], runIn);
  assert.equal(r.rc, 1, '주석이 헤더 벨의 존재를 가장했다');
  assert.ok(r.out.includes('알림 화면 버튼을 찾지 못했습니다'), '막기는 했는데 다른 판정이 울렸다');
});

test('과검출 — 금지 모양이 주석에만 있으면 막지 않는다', () => {
  // 금지 앵커도 원문으로 보면 **반대로 틀린다**: 규칙을 설명하는 주석
  // 한 줄이 위반으로 잡힌다. 막는 쪽이 아니라 **없는 위반을 만드는** 쪽이다.
  const r = withFixture([[APP, '주석에 금지 모양', (s) => `// const unreadCount = 3\n${s}`]], runIn);
  assert.equal(r.rc, 0, `주석에 적힌 금지 모양을 위반으로 셌다\n${r.out.slice(-400)}`);
});

test('★ 임시 폴더를 남기지 않는다', () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  withFixture([], runIn);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
  assert.equal(after, before, `임시 폴더가 늘었다 (${before} → ${after})`);
});
